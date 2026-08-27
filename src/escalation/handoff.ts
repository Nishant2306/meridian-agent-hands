import { randomUUID } from 'node:crypto';
import type { EvidenceWriter } from '../evidence/logger.js';
import type { LeaseManager } from '../session/lease.js';
import type { SessionStateMachine } from '../session/state.js';
import type { HumanActionEvidence, SessionIdentity } from '../types/intervention.js';
import type { LeaseToken } from '../types/session.js';
import type { Surface } from '../types/surface.js';

/**
 * ================================================================================================
 * CONTROL TRANSFER. THE SAME PROCESS, THE SAME CONTEXT, THE SAME PAGE.
 * ================================================================================================
 *
 * The whole point of this phase, and the thing that is easy to fake convincingly:
 *
 *   AUTOMATION_RUNNING
 *     -> PAUSING            automation has stopped issuing actions
 *     -> [AUTOMATION lease released, HUMAN lease issued]
 *     -> HUMAN_CONTROL      the person acts in the browser window that is already on their screen
 *     -> RESUME_VALIDATION  the human lease is released, the system re-observes and decides
 *
 * The run process stays alive. The browser context is NOT recreated. The page is NOT reloaded. A
 * handoff that closed the browser and opened a new one would look identical in a screenshot, in a
 * log, and in a demo - and it would have thrown away the authenticated session, which is the one
 * thing the automation had that the person needs.
 *
 * So `SessionIdentity` is captured BEFORE control is ceded and again when it comes back, and both
 * are written to the evidence. PHASE 10 asserts they match. It is the only hard evidence here;
 * everything else about the handoff is a claim.
 *
 * MUTUAL EXCLUSION IS THE LEASE. Issuing the HUMAN token invalidates the AUTOMATION token, and the
 * session state independently refuses AUTOMATION actions while HUMAN_CONTROL holds. Two checks,
 * because one of them being wrong should not mean two actors can drive at once.
 *
 * THE HONEST LIMIT: the lease governs SOFTWARE-issued actions. In the headed-browser transport a
 * person types on a real keyboard into a real window, and those keystrokes do not pass through
 * `resolveAndPerform` and are not gated by anything here. That is stated in REPORT.md rather than
 * papered over. It is also why `recordHumanActions` exists: if the acts cannot be gated, they can
 * at least be witnessed.
 */

export interface HandoffRecord {
  readonly interventionId: string;
  readonly humanToken: LeaseToken;
  readonly before: SessionIdentity;
  /** Set when control comes back. */
  after?: SessionIdentity;
  readonly startedAt: string;
}

export interface CedeOptions {
  surface: Surface;
  lease: LeaseManager;
  session: SessionStateMachine;
  evidence?: EvidenceWriter | undefined;
  interventionId: string;
  reason: string;
  /** How long the person has before the lease lapses. Generous: a person is not a retry loop. */
  humanLeaseTtlMs?: number;
}

const DEFAULT_HUMAN_LEASE_TTL_MS = 30 * 60 * 1000;

export class HandoffCoordinator {
  #record: HandoffRecord | null = null;
  #stopRecording: (() => Promise<HumanActionEvidence[]>) | null = null;

  get record(): HandoffRecord | null {
    return this.#record;
  }

  /**
   * Hand control to a person. Returns the HUMAN lease token.
   *
   * After this resolves, any `resolveAndPerform` presenting the AUTOMATION token throws
   * LEASE_VIOLATION - both because the token is stale and because the session state admits HUMAN
   * only.
   */
  async cede(options: CedeOptions): Promise<HandoffRecord> {
    const { surface, lease, session, evidence } = options;

    // 1. Stop.
    //
    // From AUTOMATION_RUNNING that means PAUSING first, which admits NO actor at all and is what
    // makes the gap between the two leases safe rather than a race.
    //
    // From RESUME_VALIDATION it does not: the system has ALREADY stopped, it has just finished
    // deciding it does not know where it is, and handing straight back to the person is the
    // modelled transition. That is the second-question case - the human resumed, the screen matched
    // nothing, and we are asking again - and routing it through PAUSING would be an illegal
    // transition. The state table anticipated this; the first version of this method did not.
    const from = session.state;
    // The intervention id belongs in the reason of the transition that actually happened. It used
    // to be attached to a separate event the ENGINE wrote, which was a duplicate on the first
    // intervention and false on the second. D89.
    const why = 'intervention ' + options.interventionId + ': ' + options.reason;
    if (from === 'AUTOMATION_RUNNING') {
      session.transitionTo('PAUSING', why);
      evidence?.append({
        type: 'session_transition',
        at: new Date().toISOString(),
        from: 'AUTOMATION_RUNNING',
        to: 'PAUSING',
        reason: why,
      });
    }

    // 2. Identity BEFORE. Captured while automation still owns the session, so it describes the
    //    session the automation was actually driving.
    const before = (await surface.sessionIdentity?.()) ?? {
      browserContextId: 'unknown',
      targetId: 'unknown',
      url: 'unknown',
    };

    // 3. The lease moves. Issuing invalidates the previous token; there is no window in which both
    //    are valid, because there is only ever one current lease.
    lease.revoke();
    const humanToken = lease.issue('HUMAN', options.humanLeaseTtlMs ?? DEFAULT_HUMAN_LEASE_TTL_MS);

    session.transitionTo('HUMAN_CONTROL', 'operator has control: ' + options.reason);
    evidence?.append({
      type: 'session_transition',
      at: new Date().toISOString(),
      from: from === 'AUTOMATION_RUNNING' ? 'PAUSING' : from,
      to: 'HUMAN_CONTROL',
      reason: 'operator has control: ' + options.reason,
    });
    evidence?.append({
      type: 'lease_issued',
      at: new Date().toISOString(),
      leaseId: humanToken.leaseId,
      owner: 'HUMAN',
      expiresAt: humanToken.expiresAt,
    });
    evidence?.append({
      type: 'handoff_session_identity',
      at: new Date().toISOString(),
      phase: 'before',
      interventionId: options.interventionId,
      browserContextId: before.browserContextId,
      targetId: before.targetId,
      url: before.url,
    });

    // 4. Start witnessing. If the acts cannot be gated, they can at least be recorded.
    this.#stopRecording = (await surface.recordHumanActions?.()) ?? null;

    this.#record = {
      interventionId: options.interventionId,
      humanToken,
      before,
      startedAt: new Date().toISOString(),
    };
    return this.#record;
  }

  /**
   * Take control back. Returns what the person did and the identity of the session it came back on.
   *
   * Does NOT decide anything about the run: that is `decideResume`, deliberately separate. Taking
   * back the lease and deciding whether the work is done are different questions, and a coordinator
   * that answered both would be the place where "the human said it was finished" quietly becomes
   * "the run succeeded".
   */
  async reclaim(options: {
    surface: Surface;
    lease: LeaseManager;
    session: SessionStateMachine;
    evidence?: EvidenceWriter | undefined;
    automationLeaseTtlMs?: number;
  }): Promise<{ humanEvents: HumanActionEvidence[]; after: SessionIdentity; token: LeaseToken }> {
    const record = this.#record;
    if (record === null) throw new Error('reclaim called without a handoff in progress');

    const humanEvents = this.#stopRecording === null ? [] : await this.#stopRecording();
    this.#stopRecording = null;

    const after = (await options.surface.sessionIdentity?.()) ?? {
      browserContextId: 'unknown',
      targetId: 'unknown',
      url: 'unknown',
    };

    options.session.transitionTo('RESUME_VALIDATION', 'operator released control');
    options.evidence?.append({
      type: 'session_transition',
      at: new Date().toISOString(),
      from: 'HUMAN_CONTROL',
      to: 'RESUME_VALIDATION',
      reason: 'operator released control',
    });

    options.lease.revoke();
    const token = options.lease.issue('AUTOMATION', options.automationLeaseTtlMs ?? 10 * 60 * 1000);

    // RECORDED. It was not, so the lease trace of a two-intervention run read
    // "AUTOMATION -> HUMAN -> HUMAN" - which looks like a human lease issued while a human already
    // held one, and is really "the automation lease came back and nobody wrote it down". The
    // handover to a person was evidenced and the handover BACK was not, which is the half a
    // reviewer would doubt. D89.
    options.evidence?.append({
      type: 'lease_issued',
      at: new Date().toISOString(),
      leaseId: token.leaseId,
      owner: 'AUTOMATION',
      expiresAt: token.expiresAt,
    });

    options.evidence?.append({
      type: 'handoff_session_identity',
      at: new Date().toISOString(),
      phase: 'after',
      interventionId: record.interventionId,
      browserContextId: after.browserContextId,
      targetId: after.targetId,
      url: after.url,
    });

    // Recorded as its own event so PHASE 10 does not have to correlate two lines to make the claim.
    options.evidence?.append({
      type: 'handoff_same_session',
      at: new Date().toISOString(),
      interventionId: record.interventionId,
      same:
        record.before.browserContextId === after.browserContextId &&
        record.before.targetId === after.targetId,
      beforeTargetId: record.before.targetId,
      afterTargetId: after.targetId,
    });

    for (const event of humanEvents) {
      options.evidence?.append({
        type: 'human_action',
        at: event.at,
        kind: event.kind,
        role: event.target.semantic.role,
        name: event.target.semantic.name ?? '',
        ...(event.valueChanged === undefined ? {} : { valueChanged: event.valueChanged }),
        ...(event.redactedValueToken === undefined
          ? {}
          : { redactedValueToken: event.redactedValueToken }),
      });
    }

    this.#record = { ...record, after };
    return { humanEvents, after, token };
  }

  /** Did the session survive the handoff? The claim PHASE 10 makes. */
  sameSession(): boolean {
    const record = this.#record;
    if (record?.after === undefined) return false;
    return (
      record.before.browserContextId === record.after.browserContextId &&
      record.before.targetId === record.after.targetId
    );
  }
}

export function newInterventionId(): string {
  return 'iv_' + randomUUID().replace(/-/g, '').slice(0, 22);
}
