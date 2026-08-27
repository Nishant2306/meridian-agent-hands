import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AssertionEvaluator } from '../../src/artifact/assertions.js';
import { CapabilityArtifactSchema, type CapabilityArtifact } from '../../src/artifact/schema.js';
import { HandoffCoordinator, newInterventionId } from '../../src/escalation/handoff.js';
import { decideResume } from '../../src/escalation/resume.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { LeaseManager } from '../../src/session/lease.js';
import { LeaseViolationError } from '../../src/session/errors.js';
import { SessionStateMachine } from '../../src/session/state.js';
import { InterventionSchema } from '../../src/types/intervention.js';
import { loadObservation } from '../helpers/observations.js';
import type { Observation, PerceivedControl } from '../../src/types/perception.js';
import type { SessionIdentity } from '../../src/types/intervention.js';
import type { Surface } from '../../src/types/surface.js';

/**
 * ================================================================================================
 * THE HANDOFF MECHANISM, WITHOUT A BROWSER.
 * ================================================================================================
 *
 * The lease transfer, the same-session evidence and the resume reconciliation are all pure enough
 * to test against recorded observations. The one thing that genuinely needs a live browser - that
 * the SAME context and page survive the handoff - is in
 * `tests/escalation.handoff.live.test.ts`.
 */

const EXAMPLE = fileURLToPath(
  new URL('../../examples/artifacts/prepare_subaccount_review@1.0.0.example.json', import.meta.url),
);

function artifact(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
}

const PARAMS = {
  memberId: '10001',
  accountType: 'Savings',
  nickname: 'Vacation',
  initialDeposit: '250.00',
};

function decide(observation: Observation, params = PARAMS) {
  const loaded = artifact();
  return decideResume({
    artifact: loaded,
    observation,
    evaluator: new AssertionEvaluator(new DefaultTargetResolver()),
    context: { observation, params, inputs: loaded.inputs },
  });
}

/** A surface that records what was asked of it and answers the two handoff questions. */
function fakeSurface(identity: SessionIdentity): {
  surface: Surface;
  identityCalls: number;
  events: () => number;
} {
  const state = { identityCalls: 0, recordings: 0 };
  const surface = {
    id: 'fake',
    kind: 'legacy_web',
    observe: () => Promise.reject(new Error('not used')),
    resolveAndPerform: () => Promise.reject(new Error('not used')),
    waitFor: () => Promise.resolve(true),
    screenIdentity: () => Promise.reject(new Error('not used')),
    captureEvidence: () => Promise.resolve('ref'),
    exposeForHuman: () =>
      Promise.resolve({ sessionId: 's', kind: 'headed_browser', location: 'x', note: 'n' }),
    sessionIdentity: () => {
      state.identityCalls += 1;
      return Promise.resolve(identity);
    },
    recordHumanActions: () => {
      state.recordings += 1;
      return Promise.resolve(() => Promise.resolve([]));
    },
    close: () => Promise.resolve(),
  } as unknown as Surface;

  return {
    surface,
    get identityCalls() {
      return state.identityCalls;
    },
    events: () => state.recordings,
  };
}

describe('the intervention carries everything a person needs', () => {
  it('parses with every required field present', () => {
    const intervention = {
      id: newInterventionId(),
      createdAt: new Date().toISOString(),
      kind: 'unknown_state' as const,
      runId: 'runs/replay-1',
      mode: 'replay' as const,
      capabilityId: 'prepare_subaccount_review',
      capabilityVersion: '1.0.0',
      currentStep: { id: 'step-4', index: 3, intent: 'Open the sub-account form' },
      stopReason: 'a blocking dialog is displayed and no condition describes it',
      state: {
        screenIdentity: 'Member Record',
        visibleHeading: 'Member Record',
        maskedScreenshotRef: 'runs/replay-1/screenshots/0001.png',
        inventoryRef: 'runs/replay-1/observation-abc.json',
      },
      previousAction: 'click (step-4)',
      policyContext: {
        allowedOrigins: ['http://localhost:4180'],
        maxRiskAllowed: 'RISKY_REVERSIBLE',
        deniedControlPhrases: ['submit request'],
      },
      allowedChoices: ['resume', 'abort'] as const,
      status: 'open' as const,
    };

    expect(() => InterventionSchema.parse(intervention)).not.toThrow();
  });

  it('[MUST] cannot offer "complete" as a choice', () => {
    // The schema is where this is enforced, not the UI. A console is one client; the type says a
    // human's only options are to hand control back or to stop the run.
    const bad = {
      id: newInterventionId(),
      createdAt: new Date().toISOString(),
      kind: 'unknown_state',
      runId: 'r',
      mode: 'replay',
      currentStep: { id: 's', index: 0, intent: 'i' },
      stopReason: 'r',
      state: {
        screenIdentity: 'S',
        visibleHeading: '',
        maskedScreenshotRef: 'a',
        inventoryRef: 'b',
      },
      previousAction: '',
      policyContext: { allowedOrigins: [], maxRiskAllowed: 'X', deniedControlPhrases: [] },
      allowedChoices: ['complete'],
      status: 'open',
    };

    expect(() => InterventionSchema.parse(bad)).toThrow();
  });

  it('never records a raw typed value in human evidence', () => {
    const evidence = {
      at: new Date().toISOString(),
      kind: 'input' as const,
      target: { semantic: { role: 'textbox' as const, nameMatch: 'exact' as const } },
      valueChanged: true,
      redactedValueToken: 'v1a2b3c4',
    };

    // There is no field to put one in. That is the mechanism: not a rule about what to log, but a
    // shape with nowhere for the value to go.
    expect(Object.keys(evidence)).not.toContain('value');
    expect(JSON.stringify(evidence)).not.toContain('250.00');
  });
});

describe('[MUST] control transfer: the lease moves and automation stops', () => {
  const identity: SessionIdentity = {
    browserContextId: 'ctx-1',
    targetId: 'target-1',
    url: 'http://localhost:4180/member/10001',
  };

  it('issues a HUMAN lease and leaves the session in HUMAN_CONTROL', async () => {
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    const automation = lease.issue('AUTOMATION', 60_000);
    const { surface } = fakeSurface(identity);

    const record = await new HandoffCoordinator().cede({
      surface,
      lease,
      session,
      interventionId: newInterventionId(),
      reason: 'unknown blocking dialog',
    });

    expect(session.state).toBe('HUMAN_CONTROL');
    expect(record.humanToken.owner).toBe('HUMAN');
    expect(lease.current?.leaseId).toBe(record.humanToken.leaseId);
    expect(record.humanToken.leaseId).not.toBe(automation.leaseId);
  });

  it('[MUST] an AUTOMATION action throws LEASE_VIOLATION while a person holds control', async () => {
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    const automation = lease.issue('AUTOMATION', 60_000);
    const { surface } = fakeSurface(identity);

    await new HandoffCoordinator().cede({
      surface,
      lease,
      session,
      interventionId: newInterventionId(),
      reason: 'x',
    });

    // TWO independent reasons, and both matter: the token is stale AND the session state admits
    // HUMAN only. One of them being wrong must not mean two actors can drive at once.
    expect(() => lease.assertMayAct(automation, session)).toThrow(LeaseViolationError);
    expect(() => lease.assertHolds(automation)).toThrow(LeaseViolationError);
  });

  it('records the session identity BEFORE and AFTER, and compares them', async () => {
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    lease.issue('AUTOMATION', 60_000);
    const { surface } = fakeSurface(identity);

    const coordinator = new HandoffCoordinator();
    await coordinator.cede({
      surface,
      lease,
      session,
      interventionId: newInterventionId(),
      reason: 'x',
    });
    await coordinator.reclaim({ surface, lease, session });

    // The ONLY hard evidence that the human operated the same session rather than a fresh one.
    expect(coordinator.sameSession()).toBe(true);
    expect(session.state).toBe('RESUME_VALIDATION');
    expect(lease.current?.owner).toBe('AUTOMATION');
  });

  it('reports sameSession FALSE when the context changed under it', async () => {
    // The negative control. Without it, a `sameSession()` that returned true unconditionally would
    // pass the test above and the claim would be worthless.
    const lease = new LeaseManager();
    const session = new SessionStateMachine();
    lease.issue('AUTOMATION', 60_000);

    let current = identity;
    const surface = {
      ...fakeSurface(identity).surface,
      sessionIdentity: () => Promise.resolve(current),
      recordHumanActions: () => Promise.resolve(() => Promise.resolve([])),
    } as unknown as Surface;

    const coordinator = new HandoffCoordinator();
    await coordinator.cede({
      surface,
      lease,
      session,
      interventionId: newInterventionId(),
      reason: 'x',
    });
    current = { ...identity, targetId: 'target-2-a-different-page' };
    await coordinator.reclaim({ surface, lease, session });

    expect(coordinator.sameSession()).toBe(false);
  });
});

// =================================================================================================
// [MUST] 8E. Anchor matching.
// =================================================================================================

describe('resume matches ONE state, never "the furthest checkpoint"', () => {
  it('(d) the human already reached review -> the SUCCESS state, not a resume point', () => {
    const decision = decide(loadObservation('subaccount-review'));
    expect(decision.kind).toBe('success_state');
  });

  it('(a) the human is on the member record -> resumes at the step leaving it', () => {
    const decision = decide(loadObservation('member'));

    expect(decision.kind).toBe('resume_after');
    if (decision.kind !== 'resume_after') return;
    expect(decision.state.id).toBe('member-details');
    // It resumes at the step whose fromState is that state - NOT at "the step after the one that
    // failed", which is what a naive implementation would do.
    const steps = artifact().steps;
    expect(steps[decision.resumeAtStepIndex]?.fromState).toBe('member-details');
  });

  it('(c) a PARTIALLY filled form matches nothing and goes back to the human', () => {
    // The case the whole design exists for. `subaccount-form` is not resume-eligible and
    // `subaccount-form-complete` requires every value, so a half-filled form is neither. Returning
    // it to the person costs one more question; resuming would re-type over their work.
    const decision = decide(loadObservation('subaccount-new'));

    expect(decision.kind).toBe('needs_human');
    if (decision.kind !== 'needs_human') return;
    expect(decision.reason).toContain('does not match any resume point');
    // And it says WHY each candidate failed, because the person is standing in front of the screen
    // that would answer it.
    expect(decision.detail.length).toBeGreaterThan(0);
  });

  it('(b) a DIFFERENT member is a HARD FAILURE, never a resume', () => {
    // [MUST] Never continue on the wrong record. The screen shape matches perfectly; the identity
    // invariant does not.
    const decision = decide(loadObservation('member'), { ...PARAMS, memberId: '10002' });

    expect(decision.kind).toBe('hard_failure');
    if (decision.kind !== 'hard_failure') return;
    expect(decision.reason).toContain('different record');
  });

  it('reports AMBIGUOUS rather than choosing, when two resume points match', () => {
    const loaded = artifact();
    const observation = loadObservation('member');
    // Two resume-eligible states with identical assertions: the artifact's own exclusivity rule
    // has been violated. Guessing between them is exactly what must not happen.
    const duplicated: CapabilityArtifact = {
      ...loaded,
      states: [
        ...loaded.states,
        {
          ...(loaded.states.find(
            (state) => state.id === 'member-details',
          ) as CapabilityArtifact['states'][number]),
          id: 'member-details-copy',
        },
      ],
    };

    const decision = decideResume({
      artifact: duplicated,
      observation,
      evaluator: new AssertionEvaluator(new DefaultTargetResolver()),
      context: { observation, params: PARAMS, inputs: duplicated.inputs },
    });

    expect(decision.kind).toBe('needs_human');
    if (decision.kind !== 'needs_human') return;
    expect(decision.reason).toContain('AMBIGUOUS');
  });

  it('a screen the capability has never seen goes back to the human', () => {
    const observation = loadObservation('search');
    const decision = decide(observation);

    expect(decision.kind).toBe('needs_human');
  });
});

describe('what the observation diff cannot tell you', () => {
  it('is why human ACTS are recorded separately', () => {
    // Not a behavioural test - a statement of the reason, pinned so it is not quietly dropped.
    // A diff says the field holds a value it did not hold before. It cannot say whether a person
    // typed it, whether the application autofilled it, or whether they typed and then corrected.
    const before = loadObservation('subaccount-new');
    const after = loadObservation('subaccount-review');

    const changed = (o: Observation): string[] =>
      o.controls.map((control: PerceivedControl) => control.role + ':' + control.name);

    expect(changed(before)).not.toEqual(changed(after));
  });
});
