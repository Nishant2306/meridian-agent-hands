import type { AssertionContext, AssertionEvaluator } from '../artifact/assertions.js';
import { matchState } from '../artifact/validate.js';
import type { CapabilityArtifact, State } from '../artifact/schema.js';
import type { Observation } from '../types/perception.js';

/**
 * ================================================================================================
 * [MUST] SAFE RESUME IS ANCHOR MATCHING, NOT "THE FURTHEST CHECKPOINT THAT HOLDS".
 * ================================================================================================
 *
 * The tempting implementation walks the states in order and resumes after the last one that still
 * holds. It is wrong, and it is wrong in a way that produces a plausible-looking run against the
 * wrong record.
 *
 * Checkpoints are NOT monotonic:
 *   - a member id is visible on the search results, the member record, the form and the review
 *   - a heading can appear inside a modal that is sitting on top of a different screen
 *   - a person can navigate straight to a later route without filling anything required on the way
 *   - two states can hold at once, which is exactly why resume-eligible states must be mutually
 *     exclusive and why the distiller checks that they are
 *
 * So resume asks a different question: WHICH ONE state does this screen match? Exactly one is a
 * resume point. Zero means we do not know where we are. More than one means the artifact's own
 * exclusivity has been violated by something the human did. Both of those go back to the person.
 *
 * ------------------------------------------------------------------------------------------------
 * A PARTIALLY FILLED FORM MATCHING NOTHING IS THE CORRECT ANSWER
 * ------------------------------------------------------------------------------------------------
 * `subaccount-form` is NOT resume-eligible; `subaccount-form-complete` is, and it carries qualifiers
 * for each required value. A form with the account type chosen and the deposit empty matches
 * neither: not the empty form, not the complete one. That returns to the human, and it costs one
 * more question rather than a run that silently re-fills a field somebody had already corrected.
 *
 * Treating "the form screen is showing" as a resume point would have resumed by re-typing over the
 * operator's work. That is the failure this design exists to prevent, and it is cheap to avoid.
 */

export type ResumeDecision =
  /** The whole success condition holds. Validate outputs and let the SYSTEM declare success. */
  | { kind: 'success_state'; observation: Observation }
  /** Exactly one resume-eligible state matched. Continue from the step after it. */
  | { kind: 'resume_after'; state: State; resumeAtStepIndex: number; observation: Observation }
  /** Nothing matched, or more than one did. Back to the human, with the reason. */
  | { kind: 'needs_human'; reason: string; detail: string[]; observation: Observation }
  /** An invariant is false: we are on a DIFFERENT record. Never continue. */
  | { kind: 'hard_failure'; reason: string; observation: Observation };

export interface ResumeInput {
  artifact: CapabilityArtifact;
  observation: Observation;
  evaluator: AssertionEvaluator;
  context: AssertionContext;
}

/**
 * The FIRST step whose `fromState` is this state - where automation picks up again.
 *
 * A state with no step leaving it is a dead end: the artifact says we can be here and says nothing
 * about what to do next. Reported rather than guessed.
 */
export function stepIndexAfter(artifact: CapabilityArtifact, stateId: string): number | null {
  const index = artifact.steps.findIndex((step) => step.fromState === stateId);
  return index === -1 ? null : index;
}

export function decideResume(input: ResumeInput): ResumeDecision {
  const { artifact, observation, evaluator, context } = input;

  // ------------------------------------------------------------------------------------------
  // 1. Did the human finish the job?
  //
  // Checked FIRST, because if the whole success condition holds there is nothing left to resume
  // and no reason to reason about intermediate states at all.
  // ------------------------------------------------------------------------------------------
  const success = artifact.states.find((state) => state.id === artifact.successState);
  if (success !== undefined && matchState(success, evaluator, context).matched) {
    return { kind: 'success_state', observation };
  }

  // ------------------------------------------------------------------------------------------
  // 2. INVARIANTS FIRST, across every state, before asking where we are.
  //
  // The invariants are what say "this is still the record we were asked about". If one is false we
  // are looking at a DIFFERENT member, and no amount of matching a screen shape makes it safe to
  // carry on. This is checked before the state search rather than inside it, so that a screen which
  // matches nothing AND is the wrong record is reported as the wrong record - the more serious of
  // the two, and the one that must never be answered with "please have another look".
  // ------------------------------------------------------------------------------------------
  const identityFailures: string[] = [];
  for (const state of artifact.states) {
    if (state.invariants.length === 0) continue;
    const outcomes = evaluator.evaluateAll(state.invariants, context).outcomes;
    // Only meaningful where the SCREEN part of the state matches: a member-record invariant says
    // nothing on the review screen, and demanding it everywhere would fail every resume.
    const screenHolds = evaluator.evaluateAll(state.screenAssertions, context).passed;
    if (!screenHolds) continue;
    for (const outcome of outcomes) {
      if (!outcome.passed)
        identityFailures.push(state.id + '/' + outcome.assertionId + ': ' + outcome.detail);
    }
  }
  if (identityFailures.length > 0) {
    return {
      kind: 'hard_failure',
      reason:
        'the screen matches a known state but its record-identity invariant does not hold, which ' +
        'means this is a different record than the one requested: ' +
        identityFailures.join('; '),
      observation,
    };
  }

  // ------------------------------------------------------------------------------------------
  // 3. Which ONE resume-eligible state is this?
  // ------------------------------------------------------------------------------------------
  const eligible = artifact.states.filter((state) => state.resumeEligible);
  const matches = eligible.filter((state) => matchState(state, evaluator, context).matched);

  if (matches.length === 1) {
    const state = matches[0] as State;
    const index = stepIndexAfter(artifact, state.id);
    if (index === null) {
      return {
        kind: 'needs_human',
        reason: 'no step leaves the state this screen matches',
        detail: [
          'matched "' +
            state.id +
            '", and the capability has no step whose fromState is that ' +
            'state, so there is nothing to resume into',
        ],
        observation,
      };
    }
    return { kind: 'resume_after', state, resumeAtStepIndex: index, observation };
  }

  if (matches.length > 1) {
    return {
      kind: 'needs_human',
      reason: 'AMBIGUOUS: more than one resume point matches this screen',
      detail: matches.map((state) => 'matched "' + state.id + '"'),
      observation,
    };
  }

  // Zero. Say WHY each candidate failed - "we do not know where you are" is not actionable, and
  // the person is standing in front of the screen that would answer it.
  return {
    kind: 'needs_human',
    reason: 'this screen does not match any resume point',
    detail: eligible.map((state) => {
      const failures = matchState(state, evaluator, context).failures;
      return '"' + state.id + '" did not match: ' + (failures[0] ?? 'unknown');
    }),
    observation,
  };
}
