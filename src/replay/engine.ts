import { randomUUID } from 'node:crypto';
import { verifyProfilePins } from '../artifact/approve.js';
import { AssertionEvaluator, type AssertionContext } from '../artifact/assertions.js';
import {
  detectCondition,
  effectiveDetectors,
  type EffectiveDetectors,
} from '../artifact/detectors.js';
import { comparableText, extractDeclaredOutput } from '../artifact/outputs.js';
import type { ConditionProfile, Recovery } from '../artifact/profiles.js';
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
import { bindDescriptor } from '../perception/bind.js';
import { settle } from './observation-loop.js';
import { decideResume } from '../escalation/resume.js';
import type { HumanActionEvidence, Intervention, InterventionKind } from '../types/intervention.js';
import { newInterventionId } from '../escalation/handoff.js';

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
/**
 * What the engine does when it cannot continue and a person is needed.
 *
 * A CALLBACK rather than a console reference, for the same reason `ReplayDeps` has no LlmClient:
 * the engine must not know what a console is. It knows that it stopped, what it can say about why,
 * and that somebody may hand control back. Whether that somebody is a web page, a CLI prompt or a
 * test is not its business - and a test can therefore drive the entire handoff without a browser
 * or a server.
 */
export interface EscalationRequest {
  readonly intervention: Intervention;
  readonly observation: Observation;
}

export type EscalationOutcome =
  | { choice: 'abort'; notes: string }
  | {
      choice: 'resume';
      notes: string;
      humanEvents: HumanActionEvidence[];
      /** The AUTOMATION lease, re-issued after the human released theirs. */
      token: LeaseToken;
      sameSession: boolean;
    };

export interface EscalationHandler {
  escalate(request: EscalationRequest): Promise<EscalationOutcome>;
}

export interface ReplayDeps {
  resolver: TargetResolver;
  conditionProfile: ConditionProfile;
  evidence?: EvidenceWriter;
  configRoot?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Absent means a needs_human condition is TERMINAL, which is the PHASE 6 behaviour and still the
   * right default: a caller with nobody to ask must not sit blocked forever.
   */
  escalation?: EscalationHandler;
  /** How many times one run may go back to a person before giving up. */
  maxInterventions?: number;
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
  /** Recovery ids applied during this step, in order. Empty on a clean pass. */
  recoveriesAttempted?: string[];
}

export interface ReplayOutcome {
  result: RunResult;
  steps: StepOutcome[];
  /**
   * Whether the live session was still usable when the run ended. A failure on a dead session and
   * a failure on a live one need different things from whoever picks it up: one is "sign on again",
   * the other is "look at the screen we left behind".
   */
  sessionAlive: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function describeError(error: unknown): string {
  return error instanceof Error
    ? (error.message.split(String.fromCharCode(10))[0] ?? '')
    : String(error);
}

/**
 * Is this the browser dying, rather than a bug in here?
 *
 * Matched on the phrases Playwright and CDP use when the target is gone. Deliberately an explicit
 * list: an over-broad test would classify our own defects as infrastructure failure.
 *
 * THE CDP PHRASES WERE MISSING, AND A LOADED MACHINE FOUND IT. The first version of this list
 * covered the page-level messages only. Running the suite with file parallelism put enough load on
 * the machine that the browser died a few milliseconds earlier - during `newCDPSession` rather than
 * during a page operation - and Playwright said
 *
 *     browserContext.newCDPSession: Protocol error (Target.attachToTarget):
 *     No target with given id found
 *
 * which matched nothing, so the error was rethrown instead of becoming SURFACE_UNAVAILABLE. The
 * test caught it; the parallel run is what made it happen. In production this is the ordinary case:
 * a browser that dies during OBSERVATION dies inside CDP, not inside a click.
 */
function isSurfaceDeath(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    // Page and context level.
    message.includes('target page, context or browser has been closed') ||
    message.includes('target closed') ||
    message.includes('browser has been closed') ||
    message.includes('browser closed') ||
    message.includes('session closed') ||
    message.includes('websocket') ||
    message.includes('page has been closed') ||
    message.includes('page closed') ||
    // CDP level: the target we were attached to is gone.
    message.includes('no target with given id found') ||
    message.includes('no object with guid') ||
    message.includes('target.attachtotarget') ||
    message.includes('target crashed') ||
    message.includes('session with given id not found')
  );
}

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

  /**
   * ==============================================================================================
   * A DEAD BROWSER IS A RESULT, NOT AN EXCEPTION.
   * ==============================================================================================
   *
   * When the driven process dies, Playwright throws from wherever we happened to be. Letting that
   * escape `run()` would make the one failure mode that is NOT the application's fault the only
   * one a caller cannot handle uniformly - and SURFACE_UNAVAILABLE exists precisely to be told
   * apart from APPLICATION_UNAVAILABLE, because one restarts a browser and the other waits for a
   * vendor.
   *
   * ANYTHING NOT RECOGNISABLE AS SURFACE DEATH IS RETHROWN. A blanket catch here would turn every
   * genuine defect in this engine into a tidy "the browser died", which is the kind of helpful
   * error handling that costs a day of debugging.
   */
  async run(request: ReplayRequest): Promise<ReplayOutcome> {
    try {
      return await this.#run(request);
    } catch (error) {
      // The SURFACE is the authority. The message match below is a fast path for the cases where
      // the page object is still around to be asked; when it is gone, `isClosed()` answers.
      const dead = request.surface.isClosed?.() === true || isSurfaceDeath(error);
      if (!dead) throw error;
      const metrics: RunMetrics = {
        steps: 0,
        durationMs: 0,
        llmCalls: 0,
        recoveriesUsed: 0,
        locatorTierDowngrades: 0,
        humanInterventions: 0,
      };
      return {
        result: {
          status: 'failed',
          error: 'SURFACE_UNAVAILABLE',
          expected: null,
          observed: 'the browser or driven process died mid-run: ' + describeError(error),
          attempts: 0,
          evidenceRef: this.#deps.evidence?.runDir ?? 'runs/replay-unavailable',
          metrics,
        },
        steps: [],
        sessionAlive: false,
      };
    }
  }

  async #run(request: ReplayRequest): Promise<ReplayOutcome> {
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

      // A SESSION_EXPIRED or SURFACE_UNAVAILABLE run ends with nothing left to look at; anything
      // else leaves the browser sitting on the screen that stopped us. Whoever picks this up needs
      // to know which, because it decides whether the next move is "sign on again" or "look".
      const sessionAlive = !(
        result.status === 'failed' &&
        (result.error === 'SESSION_EXPIRED' || result.error === 'SURFACE_UNAVAILABLE')
      );
      return { result: { ...result, metrics }, steps, sessionAlive };
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
    //
    // Indexed rather than `for...of`, because a resume can move the cursor. When a person takes
    // control and hands it back, the system decides WHICH state the screen now matches and resumes
    // at the first step leaving that state - which may be several steps ahead of where we stopped,
    // and must never be assumed to be "the next one".
    let cursor = 0;
    let activeToken = token;
    let completionMode: 'automation' | 'human_assisted' = 'automation';
    let interventions = 0;
    const maxInterventions = this.#deps.maxInterventions ?? 3;

    while (cursor < artifact.steps.length) {
      const step = artifact.steps[cursor] as Step;
      cursor += 1;
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
        token: activeToken,
        detectors,
        params,
        artifact,
        before: current,
        metrics,
        evidence,
      });

      steps.push({ ...attemptResult.outcome, ms: this.#now() - stepStarted });
      current = attemptResult.observation;

      if (attemptResult.terminal !== null) {
        const terminal = attemptResult.terminal(evidenceRef, metrics);
        const handler = this.#deps.escalation;

        // Only needs_human is escalatable. A hard failure and a business outcome are DECIDED, and
        // asking a person to look at a decided run is how a clean negative answer turns into an
        // hour of somebody's afternoon.
        if (terminal.status !== 'needs_human' || handler === undefined) {
          return finish(terminal);
        }

        // ======================================================================================
        // ESCALATE, RECONCILE, REPEAT - as a LOOP, because a resume can fail to place us.
        // ======================================================================================
        //
        // The first version of this was written straight-line: escalate, reconcile, and if the
        // reconciliation failed, escalate once more and carry on. That is wrong in a specific way.
        // "Carry on" meant re-running the step from a screen the system had just said it could not
        // place, which fails with a locator error - so a run that should have come back to a person
        // for a second question reported a control-not-found instead.
        //
        // Asking again is the correct answer, and it is the SAME question, so it is a loop.
        let reason = terminal.reason;
        let resolved = false;

        while (!resolved) {
          if (interventions >= maxInterventions) {
            return finish({
              ...terminal,
              reason:
                reason +
                ' (gave up after ' +
                interventions +
                ' interventions: the run kept coming back to a person)',
            });
          }
          interventions += 1;
          metrics.humanInterventions = interventions;

          const resolution = await this.#escalate({
            handler,
            artifact,
            params,
            step,
            stepIndex: cursor - 1,
            observation: current,
            reason,
            surface,
            evidence,
            runId: evidenceRef,
          });

          if (resolution.choice === 'abort') {
            return finish({
              status: 'cancelled',
              reason: 'OPERATOR_ABORTED',
              stepId: step.id,
              evidenceRef,
              metrics,
            });
          }

          // The person handed control back. NOW the system decides where we are - never "carry on
          // from the next step", and never "the furthest checkpoint that still holds".
          activeToken = resolution.token;
          completionMode = 'human_assisted';
          current = await surface.observe();
          evidence?.observed(current);

          const decision = decideResume({
            artifact,
            observation: current,
            evaluator: this.#evaluator,
            context: context(current),
          });

          // ORDER, and it follows the detector ladder: TERMINAL before non-terminal.
          //
          // A screen can be both still-blocked AND the wrong record - an operator who cleared
          // nothing and navigated somewhere else. Reporting the modal would hide the more serious
          // fact, and "you are on a different member" is the one that must never be softened into
          // "please have another look". So the identity check is asked first.
          if (decision.kind === 'hard_failure') {
            // [MUST] Never continue on the wrong record.
            return failed('INVARIANT_VIOLATED', decision.reason, step.id);
          }
          // IS THE THING THAT STOPPED US STILL THERE?
          //
          // Asked after the identity check and before anything else, because a screen carrying an
          // unrecognised blocking modal can still match a resume-eligible state perfectly - the
          // modal sits ON TOP of a member record, and the member record is exactly what the state
          // describes. Resuming there sends the next click into the overlay, which times out as a
          // locator failure and reports the symptom instead of the cause.
          //
          // Found by driving the handoff by hand and pressing Resume without fixing anything, which
          // is the first thing any operator will do.
          const stillBlocked = detectCondition(current, detectors);
          if (stillBlocked !== null && stillBlocked.kind === 'hard_failure') {
            return failed(stillBlocked.failure.code, stillBlocked.failure.description, step.id);
          }
          if (stillBlocked !== null && stillBlocked.kind === 'needs_human') {
            reason = 'that is still in the way: ' + stillBlocked.reason;
            continue;
          }

          if (decision.kind === 'success_state') {
            const missingNow = harvestOutputs(current);
            if (missingNow !== null) return failed('OUTPUT_PARSE_ERROR', missingNow, step.id);
            cursor = artifact.steps.length;
            resolved = true;
            break;
          }
          if (decision.kind === 'resume_after') {
            cursor = decision.resumeAtStepIndex;
            resolved = true;
            break;
          }

          // Zero matched, or more than one did. Same question, asked again, with what we learned.
          reason = decision.reason + ' - ' + decision.detail.join('; ');
        }

        continue;
      }

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
      completionMode,
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
  /**
   * ==============================================================================================
   * [MUST] 6C. APPLY REMEDIATION -> RE-OBSERVE -> TERMINAL DETECTORS -> RECHECK THE EFFECT.
   * ==============================================================================================
   *
   * The order is the design, and each rung earns its place:
   *
   *   1  Apply the remediation.
   *   2  RE-OBSERVE. Nothing about the pre-recovery observation is still trustworthy.
   *   3  Run the TERMINAL detectors on what is now visible. Clearing an overlay is exactly how a
   *      permission denial or a business outcome underneath it becomes readable, and acting on a
   *      run that is already decided is the thing the ladder exists to prevent.
   *   4  Only then check whether the interrupted step's expected effect NOW holds.
   *
   * Rung 3 is the one that would be easy to leave out. Without it, dismissing a maintenance notice
   * that was sitting on top of "You do not have permission to view this member" would recheck the
   * effect, fail, and report EFFECT_NOT_OBSERVED - a diagnosis of the automation for what is
   * actually an entitlement problem.
   *
   * This runs REGARDLESS of the retry budget. The recheck is not a retry: `retries.max: 0` means
   * "do not perform this action twice", and it must not also mean "do not look at whether the
   * recovery worked".
   */
  async #recover(input: {
    ctx: {
      surface: Surface;
      token: LeaseToken;
      detectors: EffectiveDetectors;
      params: Readonly<Record<string, string>>;
      artifact: CapabilityArtifact;
      before: Observation;
      metrics: RunMetrics;
      evidence: EvidenceWriter | undefined;
    };
    step: Step;
    recovery: Recovery;
    assertionContext: (observation: Observation) => AssertionContext;
    tierUsed: string | null;
    downgraded: boolean;
    attempts: number;
  }): Promise<
    | { kind: 'settled'; observation: Observation }
    | { kind: 'unsettled'; observation: Observation }
    | {
        kind: 'terminal';
        result: {
          outcome: Omit<StepOutcome, 'ms'>;
          observation: Observation;
          terminal: ((evidenceRef: string, metrics: RunMetrics) => RunResult) | null;
        };
      }
  > {
    const { ctx, step, recovery } = input;

    // 1. Apply the remediation.
    await ctx.surface.resolveAndPerform(
      {
        type: 'click',
        target: { semantic: recovery.action.target, recordedTier: 'T1_EXACT_ROLE_NAME' },
      },
      ctx.token,
    );
    ctx.evidence?.append({
      type: 'recovery_applied',
      at: new Date().toISOString(),
      recoveryId: recovery.id,
      continuation: typeof recovery.continuation === 'string' ? recovery.continuation : 'gotoStep',
    });

    // 2. Re-observe.
    const after = await ctx.surface.observe();

    // 3. Terminal detectors on what the recovery revealed.
    const revealed = detectCondition(after, ctx.detectors);
    if (
      revealed !== null &&
      (revealed.kind === 'hard_failure' || revealed.kind === 'known_outcome')
    ) {
      const terminal =
        revealed.kind === 'hard_failure'
          ? {
              detail: revealed.failure.description,
              build: (evidenceRef: string, metrics: RunMetrics): RunResult => ({
                status: 'failed',
                error: revealed.failure.code,
                stepId: step.id,
                expected: step.expectedEffects.map((effect) => effect.description).join('; '),
                observed: revealed.failure.description,
                attempts: input.attempts,
                evidenceRef,
                metrics,
              }),
            }
          : {
              detail: 'business outcome: ' + revealed.outcome.outcome,
              build: (evidenceRef: string, metrics: RunMetrics): RunResult => ({
                status: 'business_outcome',
                outcome: revealed.outcome.outcome,
                detail: revealed.outcome.detail,
                evidenceRef,
                metrics,
              }),
            };

      return {
        kind: 'terminal',
        result: {
          outcome: {
            stepId: step.id,
            status: revealed.kind === 'hard_failure' ? 'failed' : 'performed',
            detail: 'after recovery ' + recovery.id + ': ' + terminal.detail,
            tierUsed: input.tierUsed,
            downgraded: input.downgraded,
            attempts: input.attempts,
          },
          observation: after,
          terminal: terminal.build,
        },
      };
    }

    // 4. Did the interrupted step's expected effect land after all?
    const held = this.#evaluator.evaluateAll(
      step.expectedEffects,
      input.assertionContext(after),
    ).passed;

    ctx.evidence?.append({
      type: 'wait',
      at: new Date().toISOString(),
      condition: 'post-recovery-recheck:' + step.id,
      satisfied: held,
      ms: 0,
    });

    return held
      ? { kind: 'settled', observation: after }
      : { kind: 'unsettled', observation: after };
  }

  /**
   * Build the intervention and hand it to whoever is listening.
   *
   * The intervention carries everything a person needs to decide WITHOUT reading the run's logs or
   * opening the artifact: which capability, which step and the intent recorded for it, what stopped
   * us, what is on screen, what we did immediately before. A notification that says "needs human"
   * and a run id is not a handoff, it is an interruption.
   */
  async #escalate(input: {
    handler: EscalationHandler;
    artifact: CapabilityArtifact;
    step: Step;
    stepIndex: number;
    observation: Observation;
    reason: string;
    surface: Surface;
    evidence: EvidenceWriter | undefined;
    runId: string;
    /** Needed to bind an output descriptor that carries a row key before resolving it. */
    params: Readonly<Record<string, string>>;
  }): Promise<EscalationOutcome> {
    const { artifact, step, observation } = input;

    // ============================================================================================
    // LEARN WHAT IS ON THIS SCREEN BEFORE PERSISTING A PICTURE OF IT.
    // ============================================================================================
    //
    // A handoff stops the run part way through, and the screen it stopped on can display a
    // declared-sensitive OUTPUT that the run had not read yet - the member's name is on the record
    // screen long before the review screen the capability reads it from. The declaration made
    // before the run names `memberName` and has no value for it, so neither the pseudonymizer nor
    // the masker can act on it, and a real bundle carried a person's name into an
    // `observation-*.json` because of it.
    //
    // The artifact says exactly where each output lives. Resolving those descriptors here uses only
    // declared information, and it is the difference between "the system could not know" and "the
    // system had not looked". Failures are ignored on purpose: an output that is not on this screen
    // is the ordinary case, not a problem.
    if (input.evidence !== undefined) {
      for (const output of artifact.outputs) {
        if (output.sensitivity !== 'pii' && output.sensitivity !== 'secret') continue;
        const resolution = this.#deps.resolver.resolve(
          observation,
          bindDescriptor(output.source.target, input.params),
        );
        if (resolution.ok) {
          input.evidence.learnSensitiveValue(output.name, comparableText(resolution.control));
        }
      }
    }

    // The screenshot is MASKED before it is written - the evidence writer refuses to write an
    // unmasked one - so the console can poll it and a person can look at a live banking screen
    // without the declared-sensitive regions being in a file.
    const screenshotRef = await input.surface.captureEvidence('screenshot').catch(() => 'none');
    const inventoryRef = await input.surface.captureEvidence('ax').catch(() => 'none');

    const kind: InterventionKind = input.reason.includes('blocking dialog')
      ? 'unknown_state'
      : input.reason.includes('AMBIGUOUS')
        ? 'ambiguous_control'
        : input.reason.includes('recovery')
          ? 'recovery_exhausted'
          : 'unknown_state';

    const intervention: Intervention = {
      id: newInterventionId(),
      createdAt: new Date().toISOString(),
      kind,
      runId: input.runId,
      mode: 'replay',
      capabilityId: artifact.capabilityId,
      capabilityVersion: artifact.capabilityVersion,
      currentStep: { id: step.id, index: input.stepIndex, intent: step.intent },
      stopReason: input.reason,
      state: {
        screenIdentity: observation.screenIdentity.canonicalScreenName,
        visibleHeading: observation.screenIdentity.headings[0] ?? '',
        maskedScreenshotRef: screenshotRef,
        inventoryRef,
      },
      previousAction: step.action.type + ' (' + step.id + ')',
      policyContext: {
        allowedOrigins: [],
        maxRiskAllowed: step.risk,
        deniedControlPhrases: [],
      },
      // [MUST] resume | abort. There is no 'complete': a person clicking a button must not be able
      // to produce a successful capability result. See src/escalation/console.ts.
      allowedChoices: ['resume', 'abort'],
      status: 'open',
    };

    // ============================================================================================
    // THE ENGINE DOES NOT RECORD SESSION TRANSITIONS. ONLY WHAT PERFORMS ONE MAY RECORD IT.
    // ============================================================================================
    //
    // There used to be an append here claiming AUTOMATION_RUNNING -> PAUSING, with `from` hardcoded
    // because the engine has no reference to the state machine. On the FIRST intervention it merely
    // duplicated the coordinator's own event. On the SECOND it was false: the machine was in
    // RESUME_VALIDATION, the coordinator correctly recorded RESUME_VALIDATION -> HUMAN_CONTROL, and
    // the event log carried a transition that never happened.
    //
    // A component narrating a state change it does not own will eventually narrate a wrong one, and
    // the evidence bundle is the last place that should contain fiction. The intervention id is
    // carried by the coordinator's own transition reason instead. See DECISIONS.md D89.
    return await input.handler.escalate({ intervention, observation });
  }

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
    const recoveriesAttempted: string[] = [];

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
              // A failure is a DISAGREEMENT. Reporting only what we saw leaves the reader to guess
              // what we wanted, which is the half that says whether the automation is wrong.
              expected: step.expectedEffects.map((effect) => effect.description).join('; '),
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
          recoveriesAttempted.push(recovery.id);

          const continued = await this.#recover({
            ctx,
            step,
            recovery,
            assertionContext,
            tierUsed,
            downgraded,
            attempts,
          });

          if (continued.kind === 'terminal') return continued.result;
          if (continued.kind === 'settled') {
            current = continued.observation;
            return {
              outcome: {
                stepId: step.id,
                status: 'performed',
                detail:
                  'recovery ' +
                  recovery.id +
                  ' cleared the way and the expected effect then held; the action was NOT repeated',
                tierUsed,
                downgraded,
                attempts,
                recoveriesAttempted,
              },
              observation: current,
              terminal: null,
            };
          }

          current = continued.observation;
          if (recovery.continuation === 'retry_action') continue;

          // continuation: recheck_expected_effect, and the recheck did not hold.
          //
          // [MUST] We do NOT fall through to repeating the action. The maintenance notice appears
          // AFTER the "New Sub-Account" click, on the screen that click navigated to - the click
          // WORKED. Repeating it would navigate a second time from a page whose link is no longer
          // on it, or restart a form that was already filled. Only `retry_action` may repeat.
          lastDetail =
            'recovery ' +
            recovery.id +
            ' was applied and the expected effect still did not hold. Its continuation is ' +
            recovery.continuation +
            ', so the action was deliberately not repeated.';
          break;
        }

        if (condition.kind === 'needs_human') {
          // Rung 5. Something is in the way that nobody described, and guessing past an
          // unrecognised BLOCKING state is precisely the thing this system must not do.
          const reason = condition.reason;
          return {
            outcome: {
              stepId: step.id,
              status: 'failed',
              detail: reason,
              tierUsed,
              downgraded,
              attempts,
              recoveriesAttempted,
            },
            observation: current,
            terminal: (evidenceRef, metrics) => ({
              status: 'needs_human',
              interventionId: 'intervention-' + step.id + '-' + String(this.#now()),
              reason,
              stepId: step.id,
              evidenceRef,
              metrics,
            }),
          };
        }

        // A global-safety condition raised by the runtime.
        lastDetail = 'a global safety condition stopped the run: ' + condition.reason;
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
      outcome: {
        stepId: step.id,
        status: 'failed',
        detail,
        tierUsed,
        downgraded,
        attempts,
        recoveriesAttempted,
      },
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
