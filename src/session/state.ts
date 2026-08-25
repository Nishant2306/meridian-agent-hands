import {
  SESSION_TRANSITIONS,
  STATE_ALLOWS_ACTOR,
  isTerminalSessionState,
  type LeaseOwner,
  type SessionState,
} from '../types/session.js';
import { IllegalSessionTransitionError } from './errors.js';

export interface SessionTransition {
  readonly from: SessionState;
  readonly to: SessionState;
  readonly at: number;
  readonly reason: string;
}

/**
 * The session state machine. Illegal transitions throw; they are never quietly ignored.
 *
 * The history is kept because the handoff story is only credible if you can show the sequence
 * afterwards: automation ran, it paused, a person took control, the system revalidated, and the
 * SYSTEM declared the outcome.
 */
export class SessionStateMachine {
  #state: SessionState;
  readonly #history: SessionTransition[] = [];
  readonly #now: () => number;

  constructor(options: { initial?: SessionState; now?: () => number } = {}) {
    this.#state = options.initial ?? 'AUTOMATION_RUNNING';
    this.#now = options.now ?? (() => Date.now());
  }

  get state(): SessionState {
    return this.#state;
  }

  get history(): readonly SessionTransition[] {
    return this.#history;
  }

  get isTerminal(): boolean {
    return isTerminalSessionState(this.#state);
  }

  canTransitionTo(next: SessionState): boolean {
    return SESSION_TRANSITIONS[this.#state].includes(next);
  }

  transitionTo(next: SessionState, reason: string): SessionTransition {
    if (!this.canTransitionTo(next)) {
      throw new IllegalSessionTransitionError(
        `illegal session transition ${this.#state} -> ${next}. Legal from ${this.#state}: ` +
          `${SESSION_TRANSITIONS[this.#state].join(', ') || '(none, terminal)'}`,
      );
    }

    const transition: SessionTransition = { from: this.#state, to: next, at: this.#now(), reason };
    this.#state = next;
    this.#history.push(transition);
    return transition;
  }

  /** Which owner, if any, may issue software actions right now. */
  actorAllowedNow(): LeaseOwner | null {
    return STATE_ALLOWS_ACTOR[this.#state];
  }
}
