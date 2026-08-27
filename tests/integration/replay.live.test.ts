import { beforeAll, describe, expect, it } from 'vitest';
import { distill } from '../../src/artifact/distill.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { CONFIG_ROOT, runScriptedDiscovery } from '../../scripts/lib/scripted-run.js';
import { HAPPY_PATH, INPUTS } from '../../scripts/lib/happy-path.js';
import { replayAgainstFixture } from '../../scripts/lib/replay-harness.js';
import type { ReplayOutcome } from '../../src/replay/engine.js';

/**
 * THE END-TO-END SLICE.
 *
 *     the model discovers  ->  the artifact becomes a capability  ->  replay invokes it
 *
 * The artifact under test here is DISTILLED FROM A RUN, not hand-written: discovery drives the
 * real fixture with a scripted client, the distiller produces a capability, and replay executes
 * that capability with no model anywhere in the loop.
 */
describe('replaying a freshly distilled capability', () => {
  let artifact: CapabilityArtifact;

  beforeAll(async () => {
    const { outcome } = await runScriptedDiscovery({ script: HAPPY_PATH, runtimeInputs: INPUTS });
    expect(outcome.result.status).toBe('success');

    const distilled = distill({
      run: outcome.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });
    if (!distilled.ok) {
      throw new Error(
        distilled.issues.map((issue) => issue.code + ': ' + issue.message).join('; '),
      );
    }
    artifact = distilled.artifact;
  }, 180_000);

  it('replays the happy path, with typed outputs and ZERO llm calls', async () => {
    const outcome = await replayAgainstFixture({ artifact, params: INPUTS });

    expect(outcome.result.status).toBe('success');
    if (outcome.result.status !== 'success') return;

    expect(outcome.result.completionMode).toBe('automation');
    expect(outcome.result.outputs['reviewStatus']).toBe('PENDING REVIEW');
    expect(outcome.result.outputs['accountType']).toBe('Savings');
    expect(outcome.result.outputs['memberName']).toBe('Avery Lin');

    // Layer 3 of the no-LLM proof, at run time.
    expect(outcome.result.metrics.llmCalls).toBe(0);
  }, 180_000);

  it('[MUST] replays for member 10002, whom discovery never saw', async () => {
    // The capability was recorded against 10001. If anything from that run had been baked in -
    // a row key, a name, an assertion - this is where it would surface.
    const outcome = await replayAgainstFixture({
      artifact,
      params: { ...INPUTS, memberId: '10002', nickname: 'Rainy Day' },
    });

    expect(outcome.result.status).toBe('success');
    if (outcome.result.status !== 'success') return;
    expect(outcome.result.outputs['memberName']).toBe('Jordan Reyes');
    expect(outcome.result.outputs['reviewStatus']).toBe('PENDING REVIEW');
  }, 180_000);

  it('[MUST] SKIPS the nickname step when no nickname is supplied, and records the skip', async () => {
    // D16. The step's value binding has nothing to resolve to, so the step is skipped rather than
    // attempted - and the skip appears in the step results rather than passing silently.
    const outcome = await replayAgainstFixture({
      artifact,
      params: { memberId: '10001', accountType: 'Checking', initialDeposit: '75.00' },
    });

    expect(outcome.result.status).toBe('success');

    const skipped = outcome.steps.filter((step) => step.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.stepId).toContain('nickname');
    expect(skipped[0]?.detail).toContain('was not supplied');

    // Everything else still ran.
    expect(outcome.steps.filter((step) => step.status === 'performed').length).toBeGreaterThan(5);
    expect(outcome.steps.some((step) => step.status === 'failed')).toBe(false);
  }, 180_000);

  it('is DETERMINISTIC: three runs, identical steps, tiers and outputs', async () => {
    const runs: ReplayOutcome[] = [];
    for (let index = 0; index < 3; index += 1) {
      runs.push(await replayAgainstFixture({ artifact, params: INPUTS }));
    }

    const shape = (outcome: ReplayOutcome) =>
      outcome.steps.map((step) => step.stepId + ':' + step.status + ':' + String(step.tierUsed));

    const [first, second, third] = runs;
    if (first === undefined || second === undefined || third === undefined) return;

    expect(shape(second)).toEqual(shape(first));
    expect(shape(third)).toEqual(shape(first));

    for (const outcome of runs) {
      expect(outcome.result.status).toBe('success');
      if (outcome.result.status !== 'success') continue;
      expect(outcome.result.outputs).toEqual(
        first.result.status === 'success' ? first.result.outputs : {},
      );
      expect(outcome.result.metrics.llmCalls).toBe(0);
    }

    // The fixture regenerates every class name and element id on each boot, and each run booted a
    // fresh fixture. Identical tiers across three boots is the accessibility-first claim holding.
    expect(shape(first).some((entry) => entry.includes('T5_STRUCTURAL_ROW'))).toBe(true);
  }, 300_000);
});
