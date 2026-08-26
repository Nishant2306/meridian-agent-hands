import { RISK_ORDER } from '../types/risk.js';
import type { Observation } from '../types/perception.js';
import type { InputDefinition } from '../types/spec.js';
import type { AssertionContext, AssertionEvaluator } from './assertions.js';
import type { CapabilityArtifact, State, Step } from './schema.js';

/**
 * Structural and observational checks the zod schema cannot express.
 *
 * The distiller runs these before it will emit an artifact, and `capability:approve` runs the
 * static ones again before it will sign one. Everything here fails CLOSED: an artifact that cannot
 * be shown to satisfy a rule is rejected rather than approved with a warning.
 */
export interface ValidationIssue {
  code: string;
  message: string;
}

export interface StateMatch {
  stateId: string;
  matched: boolean;
  failures: string[];
}

/**
 * Does this observation put us in this state?
 *
 * All three assertion groups must hold: the screen must be the right screen, the qualifiers must be
 * true of it, and the invariants must hold. A conditional assertion whose parameter was not
 * supplied is skipped, which is what lets `subaccount-form-complete` match an invocation that
 * legitimately omitted the optional nickname.
 */
export function matchState(
  state: State,
  evaluator: AssertionEvaluator,
  context: AssertionContext,
): StateMatch {
  const failures: string[] = [];

  for (const group of [state.screenAssertions, state.qualifiers, state.invariants]) {
    for (const outcome of evaluator.evaluateAll(group, context).outcomes) {
      if (!outcome.passed) failures.push(outcome.assertionId + ': ' + outcome.detail);
    }
  }

  return { stateId: state.id, matched: failures.length === 0, failures };
}

/**
 * ==============================================================================================
 * [MUST] ONLY RESUME-ELIGIBLE STATES MUST BE MUTUALLY EXCLUSIVE.
 * ==============================================================================================
 *
 * A non-resumable state is allowed to be a strict prefix of a resumable one. `subaccount-form`
 * matches every observation `subaccount-form-complete` matches, and that is harmless, because
 * nothing ever has to CHOOSE between them: `subaccount-form` exists only as a step precondition.
 * Resumption is the single moment where an ambiguous answer would be acted on.
 *
 * This CANNOT be proven statically - two assertion sets are not comparable as text - so it is
 * checked against the observations the discovery run actually produced. That is a real check on
 * real screens rather than a claim in a comment, and it is also why the check lives here and is
 * called by the distiller rather than by the schema.
 */
export function checkResumeEligibleExclusivity(
  artifact: CapabilityArtifact,
  observations: readonly Observation[],
  evaluator: AssertionEvaluator,
  params: Readonly<Record<string, string>>,
  inputs: readonly InputDefinition[] = artifact.inputs,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const resumable = artifact.states.filter((state) => state.resumeEligible);

  for (const observation of observations) {
    const context: AssertionContext = { observation, params, inputs };
    const matched = resumable
      .map((state) => matchState(state, evaluator, context))
      .filter((match) => match.matched)
      .map((match) => match.stateId);

    if (matched.length > 1) {
      issues.push({
        code: 'RESUMABLE_STATES_NOT_EXCLUSIVE',
        message:
          'observation ' +
          observation.observationId +
          ' ("' +
          observation.screenIdentity.canonicalScreenName +
          '") matches more than one ' +
          'resume-eligible state: ' +
          matched.join(', ') +
          '. On resume the system would have to guess which one it is in.',
      });
    }
  }

  return issues;
}

/**
 * ==============================================================================================
 * [MUST] A MUTATING STEP NEEDS A DISCRIMINATING EFFECT. AN INVARIANT MUST NOT BE ONE.
 * ==============================================================================================
 *
 * Discriminating means FALSE BEFORE THE ACTION AND TRUE AFTER IT.
 *
 * A false-to-true flip is EVIDENCE, not proof of causality: something else on the page could have
 * caused it. We require one anyway, because its ABSENCE is conclusive in the direction that
 * matters. If nothing changed, the action did nothing - and "the click was swallowed by a modal"
 * is the single most common way legacy UI automation quietly does nothing and reports success.
 *
 * The mirror-image rule: an INVARIANT that is false before and true after is an effect wearing the
 * wrong label. Invariants are checked before AND after every step, so one that has to flip would
 * fail on every run and then be deleted by whoever is debugging it at the time.
 */
export function checkStepDiscrimination(
  step: Step,
  before: Observation,
  after: Observation,
  evaluator: AssertionEvaluator,
  params: Readonly<Record<string, string>>,
  inputs: readonly InputDefinition[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const beforeContext: AssertionContext = { observation: before, params, inputs };
  const afterContext: AssertionContext = { observation: after, params, inputs, before };

  const mutating = step.action.type !== 'read';

  if (mutating) {
    const discriminating = step.expectedEffects.filter((assertion) => {
      const wasTrue = evaluator.evaluate(assertion, beforeContext);
      const isTrue = evaluator.evaluate(assertion, afterContext);
      if (wasTrue.skipped || isTrue.skipped) return false;
      return !wasTrue.passed && isTrue.passed;
    });

    if (discriminating.length === 0) {
      issues.push({
        code: 'NO_DISCRIMINATING_EFFECT',
        message:
          'step "' +
          step.id +
          '" changes state but no expected effect was false before the ' +
          'action and true after it. Nothing here can tell a successful action from a swallowed ' +
          'one.',
      });
    }
  } else {
    // A read needs no transition. What it needs is that the source exists and the value parses,
    // which is checked where the output is extracted rather than as a state change.
    const flips = step.expectedEffects.some((assertion) => {
      const wasTrue = evaluator.evaluate(assertion, beforeContext);
      const isTrue = evaluator.evaluate(assertion, afterContext);
      return !wasTrue.passed && isTrue.passed;
    });
    if (flips) {
      issues.push({
        code: 'READ_STEP_CHANGED_STATE',
        message: 'step "' + step.id + '" is a read but one of its expected effects changed value.',
      });
    }
  }

  // EVERY expected effect must actually HOLD after the action. Requiring one DISCRIMINATING effect
  // says the action did something; this says nothing we recorded about it is false. Without it a
  // step can carry an assertion that was never true after the action, distil cleanly, and then
  // fail on the first replay - and the failure looks like drift in the application rather than a
  // defect in the recording.
  for (const effect of step.expectedEffects) {
    const outcome = evaluator.evaluate(effect, afterContext);
    if (!outcome.skipped && !outcome.passed) {
      issues.push({
        code: 'EXPECTED_EFFECT_FALSE_AFTER_ACTION',
        message:
          'expected effect "' +
          effect.id +
          '" on step "' +
          step.id +
          '" is FALSE after the ' +
          'action it is supposed to prove: ' +
          outcome.detail,
      });
    }
  }

  for (const invariant of step.invariants) {
    const wasTrue = evaluator.evaluate(invariant, beforeContext);
    const isTrue = evaluator.evaluate(invariant, afterContext);

    if (!wasTrue.skipped && !wasTrue.passed && isTrue.passed) {
      issues.push({
        code: 'INVARIANT_IS_AN_EFFECT',
        message:
          'invariant "' +
          invariant.id +
          '" on step "' +
          step.id +
          '" was false before the ' +
          'action and true after it. That is an expected effect, not an invariant.',
      });
      continue;
    }

    // An invariant holds on BOTH SIDES of the step. The failure this catches is specific and
    // nasty: an identity check chosen from the FROM screen that does not exist on the TO screen
    // distils cleanly, then fails on the first replay - reported against the step that carries it,
    // one step after the transition that is actually wrong.
    if (!wasTrue.skipped && !wasTrue.passed) {
      issues.push({
        code: 'INVARIANT_FALSE_BEFORE_ACTION',
        message:
          'invariant "' +
          invariant.id +
          '" on step "' +
          step.id +
          '" was already false BEFORE ' +
          'the action: ' +
          wasTrue.detail,
      });
    }
    if (!isTrue.skipped && !isTrue.passed) {
      issues.push({
        code: 'INVARIANT_FALSE_AFTER_ACTION',
        message:
          'invariant "' +
          invariant.id +
          '" on step "' +
          step.id +
          '" is false AFTER the action, ' +
          'so it does not hold across the step: ' +
          isTrue.detail,
      });
    }
  }

  return issues;
}

/** Static checks. No observations needed, so approval can run these on any stored artifact. */
export function validateArtifactStructure(artifact: CapabilityArtifact): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const seenStates = new Set<string>();
  for (const state of artifact.states) {
    if (seenStates.has(state.id)) {
      issues.push({
        code: 'DUPLICATE_STATE_ID',
        message: 'state "' + state.id + '" is declared twice',
      });
    }
    seenStates.add(state.id);
  }

  const seenSteps = new Set<string>();
  for (const step of artifact.steps) {
    if (seenSteps.has(step.id)) {
      issues.push({
        code: 'DUPLICATE_STEP_ID',
        message: 'step "' + step.id + '" is declared twice',
      });
    }
    seenSteps.add(step.id);

    if (RISK_ORDER[step.risk] > RISK_ORDER[artifact.policy.maxRiskAllowed]) {
      issues.push({
        code: 'STEP_EXCEEDS_POLICY_RISK',
        message:
          'step "' +
          step.id +
          '" is ' +
          step.risk +
          ' but the capability policy allows at most ' +
          artifact.policy.maxRiskAllowed,
      });
    }

    if (step.action.type !== 'read' && step.expectedEffects.length === 0) {
      issues.push({
        code: 'MUTATING_STEP_HAS_NO_EFFECTS',
        message: 'step "' + step.id + '" changes state but declares no expected effects',
      });
    }

    if (step.retries.backoffMs.length < step.retries.max) {
      issues.push({
        code: 'RETRY_BACKOFF_UNDERSPECIFIED',
        message:
          'step "' +
          step.id +
          '" allows ' +
          step.retries.max +
          ' retries but declares only ' +
          step.retries.backoffMs.length +
          ' backoff delays. Every wait is declared explicitly.',
      });
    }
  }

  // You have to be able to RECOGNISE that you are finished, which means the success state has to be
  // one the system can identify on its own after a resume. A non-resumable success state would mean
  // completion could only ever be inferred from having executed the steps, which is precisely the
  // inference this design refuses to make.
  const success = artifact.states.find((state) => state.id === artifact.successState);
  if (success !== undefined && !success.resumeEligible) {
    issues.push({
      code: 'SUCCESS_STATE_NOT_RESUME_ELIGIBLE',
      message:
        'successState "' +
        artifact.successState +
        '" is not resumeEligible, so completion could ' +
        'not be declared after a human handoff',
    });
  }

  return issues;
}
