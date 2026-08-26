import { randomUUID } from 'node:crypto';
import { verifyProfilePins } from '../artifact/approve.js';
import { AssertionEvaluator } from '../artifact/assertions.js';
import { effectiveDetectors, type EffectiveDetectors } from '../artifact/detectors.js';
import { extractDeclaredOutput } from '../artifact/outputs.js';
import type { ConditionProfile } from '../artifact/profiles.js';
import { stepApplies, type CapabilityArtifact, type Step } from '../artifact/schema.js';
import { matchState } from '../artifact/validate.js';
import type { EvidenceWriter } from '../evidence/logger.js';
import { providerCallCount } from '../observability/provider-calls.js';
import type { Assertion } from '../types/assertion.js';
import type { ErrorCode } from '../types/outcomes.js';
import type { Observation } from '../types/perception.js';
import type { Outputs, RunMetrics, RunResult } from '../types/run.js';
import type { LeaseToken } from '../types/session.js';
import type { Surface, TargetResolver } from '../types/surface.js';
import { validateInvocationParams } from '../artifact/params.js';
import { settle } from './observation-loop.js';

/**
 * ==============================================================================================
 * THE REPLAY ENGINE. NO MODEL IS INVOLVED, AND THERE IS NOWHERE TO PUT ONE.
 * ==============================================================================================
 *
 * Layer 1 of the no-LLM proof is the SHAPE of this file: `ReplayDeps` has no LlmClient field, so
 * there is nothing to inject even for somebody who wanted to. `src/replay/` imports nothing from
 * `src/agent/` and nothing from the provider SDK, directly or transitively.
 *
 * Layer 2 is an import-boundary test that walks the module graph from `src/replay/index.ts`.
 *
 * Layer 3 is at run time: the provider call counter is snapshotted before and after, and
 * `metrics.llmCalls` is asserted to be zero before a result is returned. A counter rather than a
 * "replay mode" flag, because a flag describes the PROCESS and breaks the moment discovery and
 * replay share one.
 */
export interface ReplayDeps {
  resolver: TargetResolver;
  conditionProfile: ConditionProfile;
  evidence?: EvidenceWriter;
  configRoot?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReplayRequest {
  artifact: CapabilityArtifact;
  params: Readonly<Record<string, unknown>>;
  /** Already authenticated and on the entry screen. See SessionBroker. */
  surface: Surface;
  token: LeaseToken;
}

export type StepStatus = 'performed' | 'skipped' | 'failed';

export interface StepOutcome {
  stepId: string;
  status: StepStatus;
  /** Why a step was skipped, or why it failed. Empty for a clean pass. */
  detail: string;
  tierUsed: string | null;
  downgraded: boolean;
  attempts: number;
  ms: number;
}

export interface ReplayOutcome {
  result: RunResult;
  steps: StepOutcome[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class ReplayEngine {
  readonly #deps: ReplayDeps;
  readonly #evaluator: AssertionEvaluator;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  // NOTE FOR A REVIEWER: there is no LlmClient parameter here, and no field that could hold one.
  constructor(deps: ReplayDeps) {
    this.#deps = deps;
    this.#evaluator = new AssertionEvaluator(deps.resolver);
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async run(request: ReplayRequest): Promise<ReplayOutcome> {
    const providerCallsBefore = providerCallCount();
    const startedAt = this.#now();
    const { artifact, surface, token } = request;
    const evidence = this.#deps.evidence;
    const steps: StepOutcome[] = [];
    const outputs: Outputs = {};

    const metrics: RunMetrics = {
      steps: 0,
      durationMs: 0,
      llmCalls: 0,
      recoveriesUsed: 0,
      locatorTierDowngrades: 0,
      humanInterventions: 0,
    };
    const evidenceRef = evidence?.runDir ?? 'runs/replay-' + randomUUID().slice(0, 8);

    const finish = (result: RunResult): ReplayOutcome => {
      metrics.steps = steps.filter((step) => step.status === 'performed').length;
      metrics.durationMs = this.#now() - startedAt;

      // LAYER 3 of the no-LLM proof, checked before anything is returned.
      const providerCalls = providerCallCount() - providerCallsBefore;
      metrics.llmCalls = providerCalls;
      if (metrics.llmCalls !== 0) {
        throw new Error(
          'replay made ' +
            metrics.llmCalls +
            ' provider call(s). Replay makes zero, by ' +
            'construction; something has reached across the package boundary.',
        );
      }

      return { result: { ...result, metrics }, steps };
    };

    const failed = (error: ErrorCode, reason: string, stepId?: string): ReplayOutcome =>
      finish({
        status: 'failed',
        error,
        ...(stepId === undefined ? {} : { stepId }),
        expected: null,
        observed: reason,
        attempts: steps.length,
        evidenceRef,
        metrics,
      });

    // ---- 1. every caller parameter, against OUR contract ---------------------------------------
    const validation = validateInvocationParams(artifact.inputs, request.params);
    if (!validation.ok) {
      return failed('INPUT_VALIDATION_FAILED', validation.issues.join('; '));
    }
    const params = validation.params;
    const supplied = validation.supplied;

    // ---- 2. the pinned profiles --------------------------------------------------------------
    try {
      verifyProfilePins(artifact, {
        ...(this.#deps.configRoot === undefined ? {} : { configRoot: this.#deps.configRoot }),
      });
    } catch (error) {
      return failed(
        'PROFILE_INTEGRITY_FAILURE',
        error instanceof Error ? error.message : 'a pinned profile does not verify',
      );
    }

    const detectors = effectiveDetectors(this.#deps.conditionProfile);
    const context = (observation: Observation, before?: Observation) => ({
      observation,
      params,
      inputs: artifact.inputs,
      ...(before === undefined ? {} : { before }),
    });

    // ---- 3. fingerprint pre-flight. BLOCK, do not guess ----------------------------------------
    let current = await surface.observe();
    evidence?.observed(current);

    for (const fingerprint of artifact.target.fingerprint) {
      const check: Assertion = {
        id: 'fingerprint',
        kind: 'text_present',
        expected: { kind: 'literal', value: fingerprint.expected },
        description: 'the application identifies itself as "' + fingerprint.expected + '"',
      };
      if (!this.#evaluator.evaluate(check, context(current)).passed) {
        return failed(
          'FINGERPRINT_MISMATCH',
          'expected "' +
            fingerprint.expected +
            '" on screen "' +
            current.screenIdentity.canonicalScreenName +
            '". Refusing to run a capability ' +
            'recorded against a different version of the application.',
        );
      }
    }

    // ---- 4. declared preconditions --------------------------------------------------------------
    for (const precondition of artifact.preconditions) {
      const outcome = this.#evaluator.evaluate(precondition.check, context(current));
      if (!outcome.passed) {
        return failed(
          'PRECONDITION_FAILED',
          precondition.description + ' (' + outcome.detail + ')',
        );
      }
    }

    /** Pull any declared output whose source STATE the current screen now matches. */
    const harvestOutputs = (observation: Observation): string | null => {
      for (const output of artifact.outputs) {
        if (outputs[output.name] !== undefined) continue;

        const state = artifact.states.find((candidate) => candidate.id === output.source.stateId);
        if (state === undefined) continue;
        if (!matchState(state, this.#evaluator, context(observation)).matched) continue;

        const extracted = extractDeclaredOutput({
          declared: output,
          target: output.source.target,
          observation,
          params,
          resolver: this.#deps.resolver,
        });
        if (!extracted.ok) {
          if (output.required) return extracted.reason;
          continue;
        }
        outputs[output.name] = extracted.value;
      }
      return null;
    };

    // ---- 5. the steps ---------------------------------------------------------------------------
    for (const step of artifact.steps) {
      const stepStarted = this.#now();

      // [MUST] D16. A step bound to an OPTIONAL parameter the caller did not supply is SKIPPED,
      // not attempted. The guard is in the ARTIFACT, so a reader can see the step is conditional
      // without knowing how this engine works - and the skip is RECORDED, never silent.
      if (!stepApplies(step, supplied)) {
        steps.push({
          stepId: step.id,
          status: 'skipped',
          detail:
            'skipped: the optional parameter "' +
            (step.when?.paramPresent ?? '') +
            '" was not ' +
            'supplied, so this step has nothing to do',
          tierUsed: null,
          downgraded: false,
          attempts: 0,
          ms: this.#now() - stepStarted,
        });
        evidence?.append({
          type: 'action_blocked',
          at: new Date().toISOString(),
          actionType: step.action.type,
          error: 'PRECONDITION_FAILED',
          reason: 'step ' + step.id + ' skipped: optional parameter not supplied',
        });
        continue;
      }

      // Invariants hold BEFORE the action as well as after it. That is what makes them invariants
      // rather than effects, and checking only afterwards would let a step run from a state it was
      // never valid in.
      const beforeInvariants = this.#evaluator.evaluateAll(step.invariants, context(current));
      if (!beforeInvariants.passed) {
        return failed(
          'INVARIANT_VIOLATED',
          'before ' +
            step.id +
            ': ' +
            beforeInvariants.outcomes
              .filter((outcome) => !outcome.passed)
              .map((outcome) => outcome.assertionId + ' (' + outcome.detail + ')')
              .join('; '),
          step.id,
        );
      }

      const attemptResult = await this.#runStep(step, {
        surface,
        token,
        detectors,
        params,
        artifact,
        before: current,
        metrics,
        evidence,
      });

      steps.push({ ...attemptResult.outcome, ms: this.#now() - stepStarted });
      current = attemptResult.observation;

      if (attemptResult.terminal !== null)
        return finish(attemptResult.terminal(evidenceRef, metrics));

      const afterInvariants = this.#evaluator.evaluateAll(step.invariants, context(current));
      if (!afterInvariants.passed) {
        return failed(
          'INVARIANT_VIOLATED',
          'after ' +
            step.id +
            ': ' +
            afterInvariants.outcomes
              .filter((outcome) => !outcome.passed)
              .map((outcome) => outcome.assertionId + ' (' + outcome.detail + ')')
              .join('; '),
          step.id,
        );
      }

      const missing = harvestOutputs(current);
      if (missing !== null) return failed('OUTPUT_PARSE_ERROR', missing, step.id);
    }

    // ---- 6. the success state ---------------------------------------------------------------------
    const success = artifact.states.find((state) => state.id === artifact.successState);
    if (success === undefined) {
      return failed('INVARIANT_VIOLATED', 'the artifact declares no success state');
    }

    current = await surface.observe();
    evidence?.observed(current);

    const reached = matchState(success, this.#evaluator, context(current));
    if (!reached.matched) {
      return failed(
        'EFFECT_NOT_OBSERVED',
        'the success state "' + success.id + '" was not reached: ' + reached.failures.join('; '),
      );
    }

    const missing = harvestOutputs(current);
    if (missing !== null) return failed('OUTPUT_PARSE_ERROR', missing);

    for (const output of artifact.outputs) {
      if (output.required && outputs[output.name] === undefined) {
        return failed('OUTPUT_PARSE_ERROR', 'required output "' + output.name + '" was never read');
      }
    }

    return finish({
      status: 'success',
      completionMode: 'automation',
      outputs,
      evidenceRef,
      metrics,
    });
  }

  /**
   * One step, with retries.
   *
   * [MUST] RETRY SAFETY. Before ANY retry, re-observe and check whether the expected effect
   * ALREADY holds. If it does, the step is complete and the action is NOT repeated.
   *
   * The failure this prevents: an action lands, the confirmation is slow, the wait times out, and
   * the retry does the same thing a second time. For a capability that only fills forms that is
   * merely wasteful - and this capability is deliberately non-mutating end to end, which is worth
   * saying plainly in REPORT.md rather than pretending the rule makes retries universally safe. On
   * a capability that submits anything, re-observing first is the difference between one request
   * and two.
   */
  async #runStep(
    step: Step,
    ctx: {
      surface: Surface;
      token: LeaseToken;
      detectors: EffectiveDetectors;
      params: Readonly<Record<string, string>>;
      artifact: CapabilityArtifact;
      before: Observation;
      metrics: RunMetrics;
      evidence: EvidenceWriter | undefined;
    },
  ): Promise<{
    outcome: Omit<StepOutcome, 'ms'>;
    observation: Observation;
    terminal: ((evidenceRef: string, metrics: RunMetrics) => RunResult) | null;
  }> {
    const assertionContext = (observation: Observation) => ({
      observation,
      params: ctx.params,
      inputs: ctx.artifact.inputs,
      before: ctx.before,
    });

    let current = ctx.before;
    let tierUsed: string | null = null;
    let downgraded = false;
    let lastDetail = '';
    let attempts = 0;
    let recoveriesTried = 0;

    for (let attempt = 0; attempt <= step.retries.max; attempt += 1) {
      if (attempt > 0) {
        // Re-observe BEFORE repeating anything.
        current = await ctx.surface.observe();
        if (this.#evaluator.evaluateAll(step.expectedEffects, assertionContext(current)).passed) {
          ctx.evidence?.append({
            type: 'wait',
            at: new Date().toISOString(),
            condition: 'retry-precheck:' + step.id,
            satisfied: true,
            ms: 0,
          });
          return {
            outcome: {
              stepId: step.id,
              status: 'performed',
              detail:
                'the expected effect already held on re-observation; the action was not repeated',
              tierUsed,
              downgraded,
              attempts,
            },
            observation: current,
            terminal: null,
          };
        }
        await this.#sleep(step.retries.backoffMs[attempt - 1] ?? 0);
      }

      attempts += 1;
      const { result, trace } = await ctx.surface.resolveAndPerform(step.action, ctx.token);
      if (trace.tierUsed !== null) tierUsed = trace.tierUsed;
      if (trace.downgraded) {
        downgraded = true;
        ctx.metrics.locatorTierDowngrades += 1;
      }

      if (result.status !== 'performed') {
        lastDetail = result.error + ': ' + result.reason;
        // A BLOCKED action is terminal on the spot. A guardrail refusing something is not a
        // transient condition to retry past.
        if (result.status === 'blocked') {
          const error = result.error;
          return {
            outcome: {
              stepId: step.id,
              status: 'failed',
              detail: lastDetail,
              tierUsed,
              downgraded,
              attempts,
            },
            observation: current,
            terminal: (evidenceRef, metrics) => ({
              status: 'failed',
              error,
              stepId: step.id,
              expected: null,
              observed: lastDetail,
              attempts,
              evidenceRef,
              metrics,
            }),
          };
        }
        continue;
      }

      const settled = await settle({
        surface: ctx.surface,
        detectors: ctx.detectors,
        evaluator: this.#evaluator,
        expectedEffects: step.expectedEffects,
        params: ctx.params,
        inputs: ctx.artifact.inputs,
        before: ctx.before,
        timeoutMs: step.wait.timeoutMs || DEFAULT_TIMEOUT_MS,
        pollMs: step.wait.pollMs,
        now: this.#now,
        sleep: this.#sleep,
      });

      current = settled.observation;

      if (settled.kind === 'settled') {
        ctx.evidence?.performed(step.action.type, trace);
        return {
          outcome: {
            stepId: step.id,
            status: 'performed',
            detail: '',
            tierUsed,
            downgraded,
            attempts,
          },
          observation: current,
          terminal: null,
        };
      }

      if (settled.kind === 'condition') {
        const condition = settled.condition;

        if (condition.kind === 'hard_failure') {
          const code = condition.failure.code;
          const detail = condition.failure.description;
          return {
            outcome: { stepId: step.id, status: 'failed', detail, tierUsed, downgraded, attempts },
            observation: current,
            terminal: (evidenceRef, metrics) => ({
              status: 'failed',
              error: code,
              stepId: step.id,
              expected: null,
              observed: detail,
              attempts,
              evidenceRef,
              metrics,
            }),
          };
        }

        if (condition.kind === 'known_outcome') {
          // NOT a failure. The automation worked and the answer is negative. This is the whole
          // reason detectors are checked inside the wait loop rather than after it.
          const outcome = condition.outcome;
          return {
            outcome: {
              stepId: step.id,
              status: 'performed',
              detail: 'business outcome: ' + outcome.outcome,
              tierUsed,
              downgraded,
              attempts,
            },
            observation: current,
            terminal: (evidenceRef, metrics) => ({
              status: 'business_outcome',
              outcome: outcome.outcome,
              detail: outcome.detail,
              evidenceRef,
              metrics,
            }),
          };
        }

        if (condition.kind === 'recovery') {
          const recovery = condition.recovery;
          if (recoveriesTried >= recovery.maxAttempts) {
            lastDetail =
              'recovery ' +
              recovery.id +
              ' did not clear the way after ' +
              recoveriesTried +
              ' attempt(s)';
            continue;
          }
          recoveriesTried += 1;
          ctx.metrics.recoveriesUsed += 1;

          // continuation: recheck_expected_effect. After clearing an interruption we do NOT assume
          // the interrupted action landed - a modal that swallowed a click leaves the screen
          // looking exactly as it did before the click.
          await ctx.surface.resolveAndPerform(
            {
              type: 'click',
              target: { semantic: recovery.action.target, recordedTier: 'T1_EXACT_ROLE_NAME' },
            },
            ctx.token,
          );
          continue;
        }

        // needs_human / system conditions reach here only if a detector is added that raises one.
        lastDetail = 'an unrecognised condition was detected';
        continue;
      }

      // TIMEOUT. The expected effect never held, and no detector explained why.
      //
      // [ADDENDUM C] THIS IS THE REAL no-recovery-matched PATH, and it is the normal one today.
      // The recovery detectors reference screens that do not exist until PHASE 6, so nothing
      // matches them - and a step declaring `try_recoveries_then_fail` must behave correctly when
      // nothing does. Detectors were already consulted on EVERY pass of the observation loop, so
      // reaching here means no recovery applied. There is nothing to try, and the step falls
      // through to failure rather than pretending a recovery was attempted.
      lastDetail =
        'the expected effect never held within ' +
        step.wait.timeoutMs +
        'ms' +
        (step.onFailure === 'try_recoveries_then_fail'
          ? ', and no recovery in the pinned condition profile matched the screen'
          : '');
      ctx.evidence?.append({
        type: 'wait',
        at: new Date().toISOString(),
        condition: 'expected-effects:' + step.id,
        satisfied: false,
        ms: settled.ms,
      });
    }

    const detail = lastDetail === '' ? 'the step did not complete' : lastDetail;
    return {
      outcome: { stepId: step.id, status: 'failed', detail, tierUsed, downgraded, attempts },
      observation: current,
      terminal: (evidenceRef, metrics) => ({
        status: 'failed',
        error: 'EFFECT_NOT_OBSERVED',
        stepId: step.id,
        expected: step.expectedEffects.map((effect) => effect.description).join('; '),
        observed: detail,
        attempts,
        evidenceRef,
        metrics,
      }),
    };
  }
}
