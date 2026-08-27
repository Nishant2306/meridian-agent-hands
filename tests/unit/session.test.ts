import { describe, expect, it } from 'vitest';
import { LeaseManager } from '../../src/session/lease.js';
import { SessionStateMachine } from '../../src/session/state.js';
import { LeaseViolationError, IllegalSessionTransitionError } from '../../src/session/errors.js';

describe('lease tokens', () => {
  it('accepts the current token for the owner the session admits', () => {
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    const token = lease.issue('AUTOMATION');
    expect(() => lease.assertMayAct(token, session)).not.toThrow();
  });

  it('throws when the token is not the current lease', () => {
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    const stale = lease.issue('AUTOMATION');
    lease.issue('AUTOMATION');

    expect(() => lease.assertMayAct(stale, session)).toThrow(LeaseViolationError);
  });

  it('throws when the token has expired', () => {
    let now = 1_000_000;
    const lease = new LeaseManager({ now: () => now });
    const session = new SessionStateMachine();
    const token = lease.issue('AUTOMATION', 5_000);

    now += 5_001;
    expect(() => lease.assertMayAct(token, session)).toThrow(/expired/);
  });

  it('throws when the owner on the token is not the owner holding the lease', () => {
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    const token = lease.issue('AUTOMATION');

    expect(() => lease.assertMayAct({ ...token, owner: 'HUMAN' }, session)).toThrow(
      LeaseViolationError,
    );
  });

  it('throws when nothing is leased at all', () => {
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    const token = lease.issue('AUTOMATION');
    lease.revoke();

    expect(() => lease.assertMayAct(token, session)).toThrow(/no lease/);
  });

  it('rejects a valid AUTOMATION token while a human holds control', () => {
    // This is the case the whole mechanism exists for: the token is genuine and unexpired, and the
    // session state is what makes it worthless.
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    const automation = lease.issue('AUTOMATION');

    session.transitionTo('PAUSING', 'operator requested control');
    session.transitionTo('HUMAN_CONTROL', 'operator took control');
    const human = lease.issue('HUMAN', 60_000);

    expect(() => lease.assertMayAct(automation, session)).toThrow(LeaseViolationError);
    expect(() => lease.assertMayAct(human, session)).not.toThrow();
  });

  it('lets nobody act while the session is PAUSING', () => {
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    const token = lease.issue('AUTOMATION');
    session.transitionTo('PAUSING', 'handing over');

    expect(() => lease.assertMayAct(token, session)).toThrow(/no actor/);
  });

  it('renews only for the holder', () => {
    let now = 1_000;
    const lease = new LeaseManager({ now: () => now });
    const token = lease.issue('AUTOMATION', 1_000);
    now += 500;
    const renewed = lease.renew(token, 1_000);
    expect(renewed.expiresAt).toBe(2_500);
    expect(renewed.leaseId).toBe(token.leaseId);
  });
});

describe('session state machine', () => {
  it('walks the handoff path', () => {
    const session = new SessionStateMachine();
    session.transitionTo('PAUSING', 'pause requested');
    session.transitionTo('HUMAN_CONTROL', 'ceded');
    session.transitionTo('RESUME_VALIDATION', 'human handed back');
    session.transitionTo('AUTOMATION_RUNNING', 'system re-observed and continued');
    expect(session.state).toBe('AUTOMATION_RUNNING');
    expect(session.history).toHaveLength(4);
  });

  it('[MUST] can reach COMPLETED from RESUME_VALIDATION', () => {
    // The human may already have finished the job. The system does not take their word for it: it
    // re-observes and decides. That is why this edge exists.
    const session = new SessionStateMachine();
    session.transitionTo('PAUSING', 'pause');
    session.transitionTo('HUMAN_CONTROL', 'ceded');
    session.transitionTo('RESUME_VALIDATION', 'handed back');
    expect(() =>
      session.transitionTo('COMPLETED', 'system verified the success state'),
    ).not.toThrow();
  });

  it('has no transition that lets a human declare success', () => {
    const session = new SessionStateMachine();
    session.transitionTo('PAUSING', 'pause');
    session.transitionTo('HUMAN_CONTROL', 'ceded');
    expect(() => session.transitionTo('COMPLETED', 'operator says it is done')).toThrow(
      IllegalSessionTransitionError,
    );
  });

  it('throws on an illegal transition', () => {
    const session = new SessionStateMachine();
    expect(() => session.transitionTo('HUMAN_CONTROL', 'skipping the pause')).toThrow(
      /illegal session transition AUTOMATION_RUNNING -> HUMAN_CONTROL/,
    );
  });

  it('throws on any transition out of a terminal state', () => {
    const session = new SessionStateMachine();
    session.transitionTo('FAILED', 'gave up');
    expect(session.isTerminal).toBe(true);
    expect(() => session.transitionTo('AUTOMATION_RUNNING', 'try again')).toThrow(
      IllegalSessionTransitionError,
    );
  });

  it('allows an abort from HUMAN_CONTROL', () => {
    const session = new SessionStateMachine();
    session.transitionTo('PAUSING', 'pause');
    session.transitionTo('HUMAN_CONTROL', 'ceded');
    expect(() => session.transitionTo('ABORTED', 'operator aborted')).not.toThrow();
  });
});
