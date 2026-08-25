import { randomUUID } from 'node:crypto';
import { renderForModel, ValueOriginTracker } from './boundary.js';
import { verifyCompletion } from './completion.js';
import { convertProposal } from './proposal.js';
import { buildSystemPrompt, PROMPT_VERSION } from './prompts/v1.js';
import { parseToolCall, type ToolCall } from './tools.js';
import type { LlmClient, LlmTurn } from './llm-client.js';
import type { EvidenceWriter } from '../evidence/logger.js';
import type { LeaseManager } from '../session/lease.js';
import type { SessionStateMachine } from '../session/state.js';
import { detectCondition, effectiveDetectors } from '../artifact/detectors.js';
import type { ConditionProfile } from '../artifact/profiles.js';
import type { SurfaceAction } from '../types/action.js';
import type {
  DiscoveryRunRecord,
  EncounteredCondition,
  OutputBinding,
  ProposedEffect,
  RecordedStep,
  RecordIdentityBinding,
  StateProposal,
} from '../types/discovery.js';
import type { Observation, PerceivedControl } from '../types/perception.js';
import type { ErrorCode } from '../types/outcomes.js';
import type { RunMetrics, RunResult } from '../types/run.js';
import type { DiscoverySpec } from '../types/spec.js';
import type { LeaseToken } from '../types/session.js';
import type { Surface, TargetResolver } from '../types/surface.js';

/**
 * ==============================================================================================
 * THE DISCOVERY LOOP: observe, render, decide, convert, validate, act, record.
 * ==============================================================================================
 *
 * Every stopping condition is BOUNDED and RECORDED. A discovery loop with an unbounded stopping
 * condition is a loop that eventually runs until somebody notices the bill.
 */
export interface DiscoveryLimits {
  maxSteps: number;
  maxDurationMs: number;
  /** Consecutive steps that changed nothing, or proposals that were rejected. */
  maxNoProgress: number;
  /** How many times the same action may be proposed before we call it a loop. */
  maxRepeats: number;
  /** How many times the model may re-propose completion after the system refused it. */
  maxCompletionRounds: number;
  /** Malformed tool calls tolerated before the run fails. */
  maxParseFailures: number;
}

export const DEFAULT_LIMITS: DiscoveryLimits = {
  maxSteps: 30,
  maxDurationMs: 5 * 60 * 1000,
  maxNoProgress: 3,
  maxRepeats: 3,
  maxCompletionRounds: 2,
  maxParseFailures: 1,
};

export interface DiscoveryOptions {
  spec: DiscoverySpec;
  specHash: string;
  goal: string;
  target: string;
  runtimeInputs: Readonly<Record<string, string>>;
  surface: Surface;
  token: LeaseToken;
  lease: LeaseManager;
  session: SessionStateMachine;
  resolver: TargetResolver;
  client: LlmClient;
  conditionProfile: ConditionProfile;
  evidence?: EvidenceWriter;
  limits?: Partial<DiscoveryLimits>;
  now?: () => number;
}

export interface DiscoveryOutcome {
  record: DiscoveryRunRecord;
  result: RunResult;
}

function actionSignature(action: SurfaceAction): string {
  if (action.type === 'navigate') {
    return 'navigate:' + action.pathSegments.map((segment) => JSON.stringify(segment)).join('/');
  }
  const value = 'value' in action ? JSON.stringify(action.value) : '';
  return action.type + ':' + JSON.stringify(action.target.semantic) + ':' + value;
}

function comparableText(control: PerceivedControl): string {
  return control.value !== undefined && control.value !== '' ? control.value : control.name;
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryOutcome> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  const runId = options.evidence?.runId ?? randomUUID();

  const tracker = new ValueOriginTracker();
  const detectors = effectiveDetectors(options.conditionProfile);

  const observations: Observation[] = [];
  const steps: RecordedStep[] = [];
  const stateProposals: StateProposal[] = [];
  const outputs: OutputBinding[] = [];
  const encountered: EncounteredCondition[] = [];
  let recordIdentity: RecordIdentityBinding | null = null;
  let successObservationId: string | null = null;

  const runtimeValues: string[] = Object.values(options.runtimeInputs).filter((v) => v !== '');
  const turns: LlmTurn[] = [];
  const system = buildSystemPrompt(options.spec);

  const metrics: RunMetrics = {
    steps: 0,
    durationMs: 0,
    llmCalls: 0,
    recoveriesUsed: 0,
    locatorTierDowngrades: 0,
    humanInterventions: 0,
  };

  let noProgress = 0;
  let parseFailures = 0;
  let completionRounds = 0;
  const repeats = new Map<string, number>();
  let terminal: RunResult | null = null;

  const remember = (observation: Observation): Observation => {
    if (!observations.some((existing) => existing.observationId === observation.observationId)) {
      observations.push(observation);
    }
    // A condition the run merely ENCOUNTERED. Recorded for the evidence bundle, and it never
    // reaches the artifact: see 4H.6 and src/artifact/distill.ts.
    const condition = detectCondition(observation, detectors);
    if (condition !== null && condition.kind !== 'system') {
      const detectorId =
        condition.kind === 'known_outcome'
          ? condition.outcome.id
          : condition.kind === 'recovery'
            ? condition.recovery.id
            : condition.kind === 'hard_failure'
              ? condition.failure.id
              : 'needs-human';
      const detail =
        condition.kind === 'known_outcome'
          ? condition.outcome.detail
          : condition.kind === 'recovery'
            ? condition.recovery.description
            : condition.kind === 'hard_failure'
              ? condition.failure.description
              : condition.reason;
      if (!encountered.some((entry) => entry.observationId === observation.observationId)) {
        encountered.push({
          observationId: observation.observationId,
          screen: observation.screenIdentity.canonicalScreenName,
          kind: condition.kind,
          detectorId,
          detail,
        });
      }
    }
    return observation;
  };

  const observe = async (): Promise<Observation> => remember(await options.surface.observe());

  const say = (content: string): void => {
    turns.push({ role: 'user', content });
    options.evidence?.transcript({
      at: new Date().toISOString(),
      role: 'system-to-model',
      content,
    });
  };

  const showScreen = (observation: Observation, preamble: string): void => {
    say(
      preamble +
        String.fromCharCode(10) +
        String.fromCharCode(10) +
        renderForModel(observation, tracker),
    );
  };

  let current = await observe();
  say(
    'GOAL: ' +
      options.goal +
      String.fromCharCode(10) +
      'TARGET: ' +
      options.target +
      String.fromCharCode(10) +
      String.fromCharCode(10) +
      'This is what is on screen now.' +
      String.fromCharCode(10) +
      String.fromCharCode(10) +
      renderForModel(current, tracker),
  );

  const finish = (result: RunResult): DiscoveryOutcome => {
    metrics.steps = steps.length;
    metrics.durationMs = now() - startedAtMs;
    const record: DiscoveryRunRecord = {
      runId,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      model: options.client.model,
      promptVersion: PROMPT_VERSION,
      spec: options.spec,
      specHash: options.specHash,
      goal: options.goal,
      target: options.target,
      runtimeInputs: options.runtimeInputs,
      observations,
      steps,
      stateProposals,
      outputs,
      recordIdentity,
      encounteredConditions: encountered,
      successObservationId,
      metrics,
    };
    return { record, result: { ...result, metrics } };
  };

  const evidenceRef = options.evidence?.runDir ?? 'runs/' + runId;
  const failed = (error: ErrorCode, reason: string): RunResult => ({
    status: 'failed',
    error,
    expected: null,
    observed: reason,
    attempts: steps.length,
    evidenceRef,
    metrics,
  });

  /** Act, then record what actually changed. The record is what the distiller reasons over. */
  const perform = async (
    action: SurfaceAction,
    intent: string,
    rationale: string,
    sourceObservation: Observation,
    before: Observation,
  ): Promise<{ ok: boolean; feedback: string }> => {
    const { result, trace } = await options.surface.resolveAndPerform(action, options.token);
    if (trace.downgraded) metrics.locatorTierDowngrades += 1;

    if (result.status !== 'performed') {
      return {
        ok: false,
        feedback:
          'That action did not happen (' +
          result.error +
          '): ' +
          result.reason +
          ' Look at the current screen and choose again.',
      };
    }

    const after = await observe();

    // What changed, measured rather than assumed. `noop` is the ONLY thing the distiller may
    // delete from within a retained segment, so it has to mean something precise.
    const changedScreen =
      before.screenIdentity.canonicalScreenName !== after.screenIdentity.canonicalScreenName;

    // The third signal, and the one a search needs: running a query changes neither the screen
    // name nor the button that ran it. What changes is the set of controls that came back.
    const inventoryKey = (observation: Observation): string =>
      observation.controls.map((control) => control.role + ':' + control.name).join('|');
    const changedInventory = inventoryKey(before) !== inventoryKey(after);

    let changedTargetValue = false;
    let resolvedControlName = '';
    let resolvedControlRole: PerceivedControl['role'] = 'unknown';
    if (action.type !== 'navigate') {
      const beforeHit = options.resolver.resolve(before, action.target);
      const afterHit = options.resolver.resolve(after, action.target);
      if (beforeHit.ok) {
        resolvedControlName = beforeHit.control.name;
        resolvedControlRole = beforeHit.control.role;
      }
      if (afterHit.ok && resolvedControlName === '') {
        resolvedControlName = afterHit.control.name;
        resolvedControlRole = afterHit.control.role;
      }
      if (beforeHit.ok && afterHit.ok) {
        changedTargetValue = comparableText(beforeHit.control) !== comparableText(afterHit.control);
      } else if (beforeHit.ok !== afterHit.ok) {
        changedTargetValue = true;
      }
    }

    const step: RecordedStep = {
      index: steps.length,
      intent,
      action,
      sourceObservationId: sourceObservation.observationId,
      beforeObservationId: before.observationId,
      afterObservationId: after.observationId,
      trace,
      noop: !changedScreen && !changedTargetValue && !changedInventory,
      changedScreen,
      changedTargetValue,
      changedInventory,
      resolvedControlName,
      resolvedControlRole,
      descriptorRationale: rationale,
      proposedEffects: [],
    };
    steps.push(step);

    if (step.noop) noProgress += 1;
    else noProgress = 0;

    current = after;
    return {
      ok: true,
      feedback: step.noop
        ? 'That action completed but nothing on the screen changed.'
        : 'Done. Here is the screen now.',
    };
  };

  let shown = current;
  const show = (observation: Observation, preamble: string): void => {
    shown = observation;
    showScreen(observation, preamble);
  };

  const performRead = async (
    action: SurfaceAction,
  ): Promise<{ ok: true; value: string } | { ok: false; reason: string }> => {
    const { result } = await options.surface.resolveAndPerform(action, options.token);
    if (result.status !== 'performed' || result.readValue === undefined) {
      return {
        ok: false,
        reason: result.status === 'performed' ? 'nothing could be read there' : result.reason,
      };
    }
    return { ok: true, value: result.readValue };
  };

  while (terminal === null) {
    if (now() - startedAtMs > limits.maxDurationMs) {
      terminal = failed('TIMEOUT', 'the run exceeded its time budget');
      break;
    }
    if (steps.length >= limits.maxSteps) {
      terminal = failed('MAX_STEPS_EXCEEDED', 'the run exceeded ' + limits.maxSteps + ' steps');
      break;
    }
    if (noProgress >= limits.maxNoProgress) {
      terminal = failed(
        'EFFECT_NOT_OBSERVED',
        limits.maxNoProgress + ' consecutive actions changed nothing observable',
      );
      break;
    }

    metrics.llmCalls += 1;
    const response = await options.client.complete({ system, turns });
    turns.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
    options.evidence?.transcript({
      at: new Date().toISOString(),
      role: 'model',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    if (response.toolCalls.length === 0) {
      parseFailures += 1;
      if (parseFailures > limits.maxParseFailures) {
        terminal = failed('UNKNOWN', 'the model stopped calling tools');
        break;
      }
      say('You must call exactly one tool. Choose an action from the inventory above.');
      continue;
    }

    const feedback: string[] = [];

    // EVERY tool call in a turn was formed against the SAME inventory: the one the model was
    // holding when it produced them. Re-reading `shown` mid-batch would validate later calls
    // against a screen the model never saw, which is both wrong and the exact case the staleness
    // check exists to catch - a second call in a batch after the first one changed the screen.
    const sourceForTurn = shown;

    for (const raw of response.toolCalls) {
      if (terminal !== null) break;

      const parsed = parseToolCall(raw.name, raw.input);
      if (!parsed.ok) {
        parseFailures += 1;
        noProgress += 1;
        feedback.push(parsed.reason);
        if (parseFailures > limits.maxParseFailures) {
          terminal = failed('UNKNOWN', 'repeated malformed tool calls: ' + parsed.reason);
        }
        continue;
      }

      const call: ToolCall = parsed.call;

      if (call.name === 'observe_more') {
        current = await observe();
        show(current, 'Re-observed (' + call.input.reason + ').');
        continue;
      }

      if (call.name === 'request_human') {
        metrics.humanInterventions += 1;
        terminal = {
          status: 'needs_human',
          interventionId: randomUUID(),
          reason: call.input.reason + ' (tried: ' + call.input.whatYouTried + ')',
          stepId: 'step-' + steps.length,
          evidenceRef,
          metrics,
        };
        continue;
      }

      if (call.name === 'give_up') {
        // Not an error code. The automation could not see a way forward, and the correct next
        // actor is a person - which is exactly what needs_human means. Calling it a failure would
        // put "the model could not find the link" in the same bucket as "the browser died".
        metrics.humanInterventions += 1;
        terminal = {
          status: 'needs_human',
          interventionId: randomUUID(),
          reason: 'the model gave up: ' + call.input.reason,
          stepId: 'step-' + steps.length,
          evidenceRef,
          metrics,
        };
        continue;
      }

      if (call.name === 'propose_goal_reached') {
        // [MUST] A FRESH observation. Not `shown`, not `current`: a model that has convinced
        // itself it is finished has by construction been reasoning over a screen that supports
        // that conclusion, so the check has to look again for itself.
        const fresh = await observe();
        const verdict = verifyCompletion({
          fresh,
          spec: options.spec,
          outputs,
          recordIdentity,
          runtimeInputs: options.runtimeInputs,
          resolver: options.resolver,
        });

        options.evidence?.transcript({
          at: new Date().toISOString(),
          role: 'completion-check',
          observationId: fresh.observationId,
          verified: verdict.verified,
          reasons: verdict.reasons,
        });

        if (verdict.verified) {
          successObservationId = fresh.observationId;
          current = fresh;
          terminal = {
            status: 'success',
            completionMode: 'automation',
            outputs: verdict.outputs,
            evidenceRef,
            metrics,
          };
          continue;
        }

        completionRounds += 1;
        if (completionRounds > limits.maxCompletionRounds) {
          terminal = failed(
            'INVARIANT_VIOLATED',
            'the system could not verify completion after ' +
              completionRounds +
              ' attempts: ' +
              verdict.reasons.join('; '),
          );
          continue;
        }

        noProgress += 1;
        current = fresh;
        show(
          fresh,
          'The system re-observed the screen and could NOT confirm the goal was met:' +
            String.fromCharCode(10) +
            verdict.reasons.map((reason) => '  - ' + reason).join(String.fromCharCode(10)),
        );
        continue;
      }

      if (call.name === 'propose_state_reached') {
        stateProposals.push({
          observationId: sourceForTurn.observationId,
          label: call.input.label,
          evidence: call.input.evidence,
        });
        feedback.push('Noted the label "' + call.input.label + '" for this screen.');
        continue;
      }

      if (call.name === 'propose_effect') {
        const last = steps.at(-1);
        if (last === undefined) {
          feedback.push('There is no action yet for that effect to be about.');
          continue;
        }
        const effect: ProposedEffect = {
          kind: call.input.kind,
          description: call.input.description,
        };
        if (typeof call.input.expected === 'string') {
          effect.expected = { kind: 'literal', value: call.input.expected };
        } else if (call.input.expected !== undefined) {
          effect.expected = { kind: 'param', name: call.input.expected.param };
        }
        if (call.input.markId !== undefined) {
          const converted = convertProposal({
            sourceObservation: sourceForTurn,
            freshObservation: sourceForTurn,
            markId: call.input.markId,
            kind: 'read',
            resolver: options.resolver,
            runtimeValues,
            runtimeInputs: options.runtimeInputs,
          });
          if (converted.ok) effect.target = converted.descriptor;
        }
        last.proposedEffects.push(effect);
        feedback.push('Recorded that proposed effect. The system will verify it, not take it.');
        continue;
      }

      // Everything below addresses a control, so everything below goes through conversion first.
      const fresh = await observe();
      const kind =
        call.name === 'click'
          ? ('click' as const)
          : call.name === 'type_text'
            ? ('type' as const)
            : call.name === 'select_option'
              ? ('select' as const)
              : ('read' as const);

      const converted = convertProposal({
        sourceObservation: sourceForTurn,
        freshObservation: fresh,
        markId: call.input.markId,
        kind,
        ...('value' in call.input ? { value: call.input.value } : {}),
        resolver: options.resolver,
        runtimeValues,
        runtimeInputs: options.runtimeInputs,
      });

      if (!converted.ok) {
        noProgress += 1;
        options.evidence?.append({
          type: 'action_blocked',
          at: new Date().toISOString(),
          actionType: kind === 'read' ? 'read' : kind,
          error: 'CONTROL_NOT_FOUND',
          reason: converted.rejection.code + ': ' + converted.rejection.reason,
        });
        current = fresh;
        show(fresh, converted.rejection.reason);
        continue;
      }

      const signature = actionSignature(converted.action);
      const seen = (repeats.get(signature) ?? 0) + 1;
      repeats.set(signature, seen);
      if (seen > limits.maxRepeats) {
        terminal = failed(
          'MAX_STEPS_EXCEEDED',
          'the same action was proposed ' + seen + ' times: ' + signature,
        );
        continue;
      }

      if (call.name === 'read_value') {
        const read = await performRead(converted.action);
        if (!read.ok) {
          noProgress += 1;
          feedback.push('Could not read that: ' + read.reason);
          continue;
        }
        outputs.push({
          name: call.input.outputName,
          observationId: fresh.observationId,
          target: converted.descriptor,
          parseAs: call.input.parseAs,
          observedValue: read.value,
        });
        // A value we have now READ is a runtime value, and no later descriptor may embed it.
        if (!runtimeValues.includes(read.value)) runtimeValues.push(read.value);
        noProgress = 0;
        feedback.push('Bound output "' + call.input.outputName + '".');
        continue;
      }

      if (call.name === 'propose_record_identity') {
        const read = await performRead(converted.action);
        if (!read.ok) {
          noProgress += 1;
          feedback.push('Could not read the record identity there: ' + read.reason);
          continue;
        }
        recordIdentity = {
          param: options.spec.recordIdentity.param,
          observationId: fresh.observationId,
          target: converted.descriptor,
          observedValue: read.value,
        };
        noProgress = 0;
        feedback.push('Bound the record identity. The system will check it, not you.');
        continue;
      }

      if (call.name === 'type_text' || call.name === 'select_option') {
        if (call.input.value.kind === 'param') {
          tracker.record(converted.control, call.input.value.name);
        }
      }

      const outcome = await perform(
        converted.action,
        call.input.intent,
        converted.rationale,
        sourceForTurn,
        fresh,
      );
      if (!outcome.ok) {
        noProgress += 1;
        current = await observe();
        show(current, outcome.feedback);
        continue;
      }
      show(current, outcome.feedback);
    }

    if (terminal === null && feedback.length > 0) {
      say(feedback.join(String.fromCharCode(10)));
    }
  }

  return finish(terminal ?? failed('UNKNOWN', 'the loop ended without a result'));
}
