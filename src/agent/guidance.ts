import type { ErrorCode } from '../types/outcomes.js';
import type { PerceivedControl } from '../types/perception.js';

/**
 * ================================================================================================
 * WHAT THE MODEL IS TOLD WHEN SOMETHING IT PROPOSED DID NOT HAPPEN.
 * ================================================================================================
 *
 * At GATE 1 the model proposed the same read four times and the run died on the repeated-action
 * rule. The rule fired correctly. The problem was upstream: every attempt came back as
 *
 *     "Could not read the record identity there: the control is no longer present on the screen"
 *
 * which is a statement about the SCREEN. The screen had not changed - 22 controls before, 22 after -
 * so the model had nothing to act on, no reason to believe a different choice would help, and
 * re-proposing was a rational response to the information it was given.
 *
 * Two rules follow, and they are separate:
 *
 *   1. Say what to DO, not just what happened. Every error code implies a different next move, and
 *      if two codes imply the same move they should not have been two codes.
 *
 *   2. A repeat is itself information. The second identical failure means the first message did
 *      not land, so the second one says so explicitly and names the alternatives. The
 *      repeated-action rule stays as the backstop it was meant to be, rather than the only signal.
 *
 * This module is pure so the guidance can be tested without a browser or a model.
 */

export type FailureCode =
  ErrorCode | 'UNKNOWN_MARK' | 'UNDESCRIBABLE_CONTROL' | 'STALE_OBSERVATION_CONTEXT';

/** What the model should try next, in terms it can act on. */
function nextMove(code: FailureCode): string {
  switch (code) {
    case 'CONTROL_NOT_FOUND':
      return (
        'Do not re-propose the same target. Look at the numbered inventory on the current ' +
        'screen and pick a DIFFERENT mark, or take a different approach to the same goal.'
      );
    case 'AMBIGUOUS_CONTROL':
      return (
        'Several controls match equally well, so the choice is not yours to disambiguate by ' +
        'position. Pick a mark in a row that is identified by one of the values you were given, ' +
        'or choose a different control.'
      );
    case 'LOCATOR_CONFLICT':
      return (
        'Two ways of identifying that control disagree, which usually means the screen changed ' +
        'under it. Re-observe and choose again from what is there now.'
      );
    case 'UNDESCRIBABLE_CONTROL':
      return (
        'That element carries nothing that could identify it in a later run except its own text, ' +
        'and its own text may be different next time. If you need the VALUE it shows, it is ' +
        'already in the inventory you were given - read it there rather than acting on it. If you ' +
        'need to act, choose a labelled control.'
      );
    case 'UNKNOWN_MARK':
      return 'Use a mark id from the most recent inventory.';
    case 'STALE_OBSERVATION_CONTEXT':
      return 'The screen changed after you chose. Re-read the current inventory and choose again.';
    case 'POLICY_BLOCKED':
    case 'ALLOWLIST_VIOLATION':
      return (
        'That control is off limits and will not become available. Achieve the goal without it, ' +
        'or stop and say you cannot.'
      );
    case 'EFFECT_NOT_OBSERVED':
      return (
        'The action was performed and nothing on the screen changed. Either it was not the ' +
        'control you wanted, or this screen needs something else done first.'
      );
    case 'APPLICATION_VALIDATION_REJECTED':
      return 'The application rejected the value. Read the error it is showing and correct it.';
    default:
      return 'Look at the current screen and choose again.';
  }
}

export interface FailureFeedbackInput {
  readonly code: FailureCode;
  readonly reason: string;
  /** What the model asked for, so the message names it rather than making it guess. */
  readonly control?: Pick<PerceivedControl, 'markId' | 'role' | 'name'>;
  /** How many times this exact target has failed this exact way, including this one. */
  readonly attempt: number;
}

/** A stable key for "the same proposal failing the same way". */
export function failureKey(code: FailureCode, markId: number | undefined): string {
  return code + '@' + (markId ?? 'none');
}

export function failureFeedback(input: FailureFeedbackInput): string {
  const nl = String.fromCharCode(10);
  const what =
    input.control === undefined
      ? 'That action did not happen'
      : 'Mark ' +
        input.control.markId +
        ' (' +
        input.control.role +
        ' "' +
        input.control.name +
        '") could not be used';

  const lines = [what + ' - ' + input.code + ': ' + input.reason];

  if (input.attempt > 1) {
    // The escalation. Repeating the first message would be repeating what already did not work.
    lines.push(
      'You have now tried this ' +
        input.attempt +
        ' times and it has failed the same way each time. It will keep failing. Something ' +
        'different is required.',
    );
  }

  lines.push(nextMove(input.code));
  return lines.join(nl);
}
