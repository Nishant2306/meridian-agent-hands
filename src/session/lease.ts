import { randomUUID } from 'node:crypto';
import type { LeaseOwner, LeaseToken } from '../types/session.js';
import { LeaseViolationError } from './errors.js';
import type { SessionStateMachine } from './state.js';

export const DEFAULT_LEASE_TTL_MS = 120_000;

/**
 * Exactly one lease is current at any moment.
 *
 * Issuing a lease INVALIDATES the previous one. That is the whole mutual-exclusion mechanism: when
 * control is ceded to a person, the automation's token stops working the instant the human's token
 * is issued, and any in-flight automation action that arrives afterwards is rejected rather than
 * racing the human.
 */
export class LeaseManager {
  #current: LeaseToken | null = null;
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  get current(): LeaseToken | null {
    return this.#current;
  }

  issue(owner: LeaseOwner, ttlMs: number = DEFAULT_LEASE_TTL_MS): LeaseToken {
    const token: LeaseToken = {
      leaseId: randomUUID(),
      owner,
      expiresAt: this.#now() + ttlMs,
    };
    this.#current = token;
    return token;
  }

  /** Extend the current lease. Only the holder may renew, and only before it expires. */
  renew(token: LeaseToken, ttlMs: number = DEFAULT_LEASE_TTL_MS): LeaseToken {
    this.assertHolds(token);
    const renewed: LeaseToken = { ...token, expiresAt: this.#now() + ttlMs };
    this.#current = renewed;
    return renewed;
  }

  revoke(): void {
    this.#current = null;
  }

  /** Token validity only: is this the current lease, held by its stated owner, unexpired? */
  assertHolds(token: LeaseToken): void {
    if (this.#current === null) {
      throw new LeaseViolationError('no lease is currently issued; the surface accepts no actions');
    }
    if (this.#current.leaseId !== token.leaseId) {
      throw new LeaseViolationError(
        `stale lease ${token.leaseId}: control now belongs to lease ${this.#current.leaseId} ` +
          `(${this.#current.owner})`,
      );
    }
    if (this.#current.owner !== token.owner) {
      throw new LeaseViolationError(
        `lease ${token.leaseId} presented as ${token.owner} but is held by ${this.#current.owner}`,
      );
    }
    if (this.#now() >= this.#current.expiresAt) {
      throw new LeaseViolationError(`lease ${token.leaseId} expired at ${this.#current.expiresAt}`);
    }
  }

  /**
   * Step 1 of the input path: token validity AND whether the session state lets this owner act.
   *
   * The state check is not redundant. A valid AUTOMATION token is worthless while the session is
   * in HUMAN_CONTROL, and that is exactly the case the handoff has to get right.
   */
  assertMayAct(token: LeaseToken, session: SessionStateMachine): void {
    this.assertHolds(token);

    const allowed = session.actorAllowedNow();
    if (allowed === null) {
      throw new LeaseViolationError(
        `no actor may issue software actions while the session is ${session.state}`,
      );
    }
    if (allowed !== token.owner) {
      throw new LeaseViolationError(
        `session is ${session.state}, which admits ${allowed} actions only; token owner is ` +
          `${token.owner}`,
      );
    }
  }
}
