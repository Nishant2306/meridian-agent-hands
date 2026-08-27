import { beforeAll, describe, expect, it } from 'vitest';
import { distill } from '../../src/artifact/distill.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { CONFIG_ROOT } from '../../scripts/lib/scripted-run.js';
import type { DiscoveryOutcome } from '../../src/agent/loop.js';
import { runScriptedDiscovery } from '../../scripts/lib/scripted-run.js';
import { ENCOUNTERS_A_CONDITION, HAPPY_PATH, INPUTS } from '../../scripts/lib/happy-path.js';

describe('discovery, end to end, with a scripted model', () => {
  let happy: DiscoveryOutcome;
  let modelSaw: string;

  beforeAll(async () => {
    const harness = await runScriptedDiscovery({ script: HAPPY_PATH, runtimeInputs: INPUTS });
    happy = harness.outcome;
    modelSaw = harness.client.calls.join(String.fromCharCode(10));
  }, 180_000);

  it('reaches the goal, and the SYSTEM is what declares it', () => {
    expect(happy.result.status).toBe('success');
    if (happy.result.status !== 'success') return;
    expect(happy.result.completionMode).toBe('automation');
    expect(happy.result.outputs['reviewStatus']).toBe('PENDING REVIEW');
    expect(happy.result.outputs['accountType']).toBe('Savings');
    expect(happy.record.successObservationId).not.toBeNull();
  });

  it('[MUST] never shows the model a value it typed, and never a secret', () => {
    expect(modelSaw).toContain('[PARAM:memberId]');
    expect(modelSaw).toContain('[PARAM:initialDeposit]');
    expect(modelSaw).not.toContain('fixture-passcode');
    expect(modelSaw).not.toContain('fixture-operator');
  });

  it('does NOT blind-substitute over values the model read off the page', () => {
    // The member name was READ, not typed. Masking it would mean handing the model a lie about
    // what the application says. See src/agent/boundary.ts.
    expect(modelSaw).toContain('Avery Lin');
  });
});

describe('distilling the happy path', () => {
  let happy: DiscoveryOutcome;

  beforeAll(async () => {
    happy = (await runScriptedDiscovery({ script: HAPPY_PATH, runtimeInputs: INPUTS })).outcome;
  }, 180_000);

  it('[MUST] keeps ALL THREE fills that happened on the sub-account form', () => {
    // The regression this whole algorithm exists for. Three fills all leave you on the same screen,
    // so a state-only backward walk deletes two of them - and replay then fails on Continue, in a
    // way that looks nothing like a distiller bug.
    const result = distill({
      run: happy.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.issues.map((issue) => issue.code + ': ' + issue.message).join('; '));
    }

    const fills = result.artifact.steps.filter(
      (step) => step.action.type === 'type' || step.action.type === 'select',
    );
    const boundParams = fills
      .map((step) =>
        'value' in step.action && step.action.value.kind === 'param' ? step.action.value.name : '',
      )
      .filter((name) => name !== '');

    expect(boundParams).toContain('accountType');
    expect(boundParams).toContain('nickname');
    expect(boundParams).toContain('initialDeposit');
    expect(boundParams.filter((name) => name !== 'memberId')).toHaveLength(3);
  });

  it('[MUST] contains no value from this invocation, and no mark ids', () => {
    const result = distill({
      run: happy.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));

    const serialized = JSON.stringify(result.artifact);
    expect(serialized).not.toContain('10001');
    expect(serialized).not.toContain('Vacation');
    expect(serialized).not.toContain('Avery Lin');
    expect(serialized).not.toContain('markId');
    // "Savings" IS allowed: it is a declared enum member, a contract constant, not a runtime value.
    expect(serialized).toContain('Savings');
  });

  it('[MUST] already carries VERIFIED profile pins, before anyone approves it', () => {
    const result = distill({
      run: happy.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));

    expect(result.artifact.status).toBe('draft');
    expect(result.artifact.profiles.condition.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifact.profiles.safety.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifact.provenance.model).toContain('NO-MODEL-WAS-CALLED');
    expect(result.artifact.provenance.goalTemplate).toContain('{{memberId}}');
  });

  it('parameterizes the row key and never the member id', () => {
    const result = distill({
      run: happy.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));

    const openStep = result.artifact.steps.find(
      (step) => step.action.type === 'click' && step.action.target.semantic.name === 'Open',
    );
    expect(openStep).toBeDefined();
    if (openStep === undefined || openStep.action.type === 'navigate') return;
    expect(openStep.action.target.semantic.rowKey?.cellText).toEqual({
      kind: 'param',
      name: 'memberId',
    });
  });

  it('records the STRUCTURAL tier for the result-row link, not the tier that fired', () => {
    const result = distill({
      run: happy.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));

    // This run searched for ONE member, so the results screen had one row and role-plus-name
    // resolved the link uniquely. The row key is still what the descriptor depends on.
    const openStep = result.artifact.steps.find(
      (step) => step.action.type === 'click' && step.action.target.semantic.rowKey !== undefined,
    );
    expect(openStep).toBeDefined();
    if (openStep === undefined || openStep.action.type === 'navigate') return;
    expect(openStep.action.target.recordedTier).toBe('T5_STRUCTURAL_ROW');
  });

  it('is readable: no note restates its intent, and no id is machine-generated', () => {
    const result = distill({
      run: happy.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));

    for (const step of result.artifact.steps) {
      // `intent` is the model's account, `notes` is the system's. A field that always restates its
      // neighbour is noise in the first document a reviewer reads.
      if (step.notes !== undefined) expect(step.notes).not.toBe(step.intent);

      for (const effect of [...step.expectedEffects, ...step.invariants]) {
        expect(effect.id).not.toMatch(/\.proposed-\d+$/);
        expect(effect.id.startsWith(step.id + '.')).toBe(true);
      }
    }
  });

  it('builds a resumable complete state and a non-resumable precondition state', () => {
    const result = distill({
      run: happy.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));

    const form = result.artifact.states.find((state) => state.id === 'new-sub-account');
    const complete = result.artifact.states.find(
      (state) => state.id === 'new-sub-account-complete',
    );

    expect(form?.resumeEligible).toBe(false);
    expect(complete?.resumeEligible).toBe(true);
    expect(complete?.qualifiers.length).toBeGreaterThanOrEqual(3);

    const success = result.artifact.states.find(
      (state) => state.id === result.artifact.successState,
    );
    expect(success?.resumeEligible).toBe(true);
  });
});

describe('[MUST] a condition the run MET never enters the artifact', () => {
  it('records it as evidence and keeps it out of the executable capability', async () => {
    // This run searches for a member that does not exist before doing the real work, so it meets
    // MEMBER_NOT_FOUND on the way. That is worth recording. It is NOT worth executing: an artifact
    // carrying a "proposed but maybe active" condition is an artifact whose behaviour nobody
    // reviewed, and the whole point of the pinned condition profile is that a human reviewed it.
    const { outcome } = await runScriptedDiscovery({
      script: ENCOUNTERS_A_CONDITION,
      runtimeInputs: INPUTS,
    });

    expect(outcome.result.status).toBe('success');

    const met = outcome.record.encounteredConditions;
    expect(met.length).toBeGreaterThan(0);
    expect(met.map((entry) => entry.detectorId)).toContain('member-not-found');

    const result = distill({
      run: outcome.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));

    // Capability-specific ADDITIONS only, and this capability adds nothing.
    expect(result.artifact.knownOutcomes).toEqual([]);
    expect(result.artifact.recoveries).toEqual([]);
    expect(result.artifact.hardFailures).toEqual([]);
    expect(JSON.stringify(result.artifact)).not.toContain('member-not-found');
  }, 180_000);
});
