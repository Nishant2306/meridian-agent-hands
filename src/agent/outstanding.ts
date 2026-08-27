import type { CompletionReason } from './completion.js';

const NL = String.fromCharCode(10);

/**
 * ================================================================================================
 * THE REASONS THE LAST COMPLETION PROPOSAL WAS REFUSED, AND WHEN TO SAY THEY ARE GONE.
 * ================================================================================================
 *
 * Everything else in the discovery loop gives the model feedback on FAILURE. That left one hole and
 * a real run fell into it: the completion check refused because the record identity binding was
 * stale, the model correctly rebound it to the right control on the right screen, and the
 * acknowledgement it received was the same bland line it had already been given twice -
 *
 *     "Bound the record identity. The system will check it, not you."
 *
 * Nothing said "that was the blocker". The model never proposed completion again, and the run ended
 * on the repeated-action rule eight steps later. See DECISIONS.md D80.
 *
 * ------------------------------------------------------------------------------------------------
 * REASON-SPECIFIC, NOT GENERIC, AND THAT DISTINCTION IS THE WHOLE DESIGN
 * ------------------------------------------------------------------------------------------------
 * The cheap fix is to append "you have an outstanding refusal" to every acknowledgement. That turns
 * completion into polling: the model re-proposes after each action, and every refusal is another
 * model call against the step budget. This speaks ONCE, when a NAMED reason actually becomes false,
 * which is the same shape as the failure guidance everywhere else in this package.
 *
 * A refusal is also about a SCREEN. Once the run navigates, the reasons describe a page the model
 * can no longer see, so they are dropped rather than carried forward into an announcement that
 * would be false.
 */
export class OutstandingRefusal {
  #reasons: readonly CompletionReason[] = [];
  #screen: string | null = null;

  /** Reasons a completion check just produced, and the screen it checked. */
  set(reasons: readonly CompletionReason[], screen: string): void {
    this.#reasons = reasons;
    this.#screen = screen;
  }

  clear(): void {
    this.#reasons = [];
    this.#screen = null;
  }

  /** Called with every screen the model is shown. A refusal does not survive a navigation. */
  observedScreen(screen: string): void {
    if (this.#screen !== null && screen !== this.#screen) this.clear();
  }

  get reasons(): readonly CompletionReason[] {
    return this.#reasons;
  }

  /**
   * Remove the reasons an action has just addressed, and return what to tell the model.
   *
   * Empty string when nothing was outstanding or nothing matched, so a caller can append it
   * unconditionally and stay silent in the ordinary case.
   */
  resolve(matches: (reason: CompletionReason) => boolean): string {
    if (this.#reasons.length === 0) return '';
    const addressed = this.#reasons.filter(matches);
    if (addressed.length === 0) return '';

    this.#reasons = this.#reasons.filter((reason) => !matches(reason));

    if (this.#reasons.length === 0) {
      this.#screen = null;
      return NL + 'That was the last thing blocking completion. Call propose_goal_reached again.';
    }
    return (
      NL +
      'That addressed one of the reasons the last completion check was refused. Still outstanding:' +
      NL +
      this.#reasons.map((reason) => '  - ' + reason.message).join(NL)
    );
  }
}

/** An action that binds the record identity addresses any identity reason. */
export const isIdentityReason = (reason: CompletionReason): boolean =>
  reason.code.startsWith('IDENTITY_');

/** An action that binds output `name` addresses only reasons about THAT output. */
export const isOutputReason =
  (name: string) =>
  (reason: CompletionReason): boolean =>
    reason.code.startsWith('OUTPUT_') && reason.outputName === name;
