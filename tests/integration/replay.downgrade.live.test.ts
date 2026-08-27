import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { distill } from '../../src/artifact/distill.js';
import { EvidenceWriter } from '../../src/evidence/logger.js';
import { formatResultForHuman } from '../../src/replay/report.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { CONFIG_ROOT, runScriptedDiscovery } from '../../scripts/lib/scripted-run.js';
import { HAPPY_PATH, INPUTS } from '../../scripts/lib/happy-path.js';
import { replayAgainstFixture } from '../../scripts/lib/replay-harness.js';

/**
 * ================================================================================================
 * A TIER DOWNGRADE IS CARRIED ALL THE WAY OUT: STEP RESULT, EVIDENCE FILE, METRICS.
 * ================================================================================================
 *
 * Flagged after PHASE 5 and deferred to here, because producing a screen that resolves one tier
 * weaker is fixture work.
 *
 * WHAT WAS ALREADY PROVEN, AND WHY IT WAS NOT ENOUGH. `resolver.ts` sets `trace.downgraded`, and a
 * PHASE 2 test pins that at the resolver level. Above that line nothing was asserted: the replay
 * engine carries `downgraded` per step, the evidence logger writes it, and the discovery loop
 * counts `locatorTierDowngrades` - and no test drove a real replay against a drifted screen to see
 * whether any of that arrives. PHASE 10 quotes the number as evidence, so PHASE 10 must not be
 * where it is discovered to be zero.
 *
 * DETERMINISM ACROSS FRESH BOOTS IS A DIFFERENT CLAIM. That test shows the tier does not MOVE when
 * the page is unchanged. It says nothing about whether a move is caught when it happens.
 *
 * THE DRIFT IS REALISTIC, NOT SYNTHETIC. The vendor rewords a button. The visible label changes;
 * the legacy-stable `name=` attribute does not, because the server's form handling depends on it.
 * So the capability keeps working, at a weaker tier, which is exactly the moment worth noticing -
 * well before it breaks outright.
 */
describe('a locator tier downgrade reaches the step result, the evidence and the metrics', () => {
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

  it('records the Continue button at T1 with a stable-attribute hint to fall back to', () => {
    // The precondition for the whole test. If the recorded descriptor carried no weaker evidence,
    // a relabel would be a FAILURE rather than a downgrade, and there would be nothing to measure.
    const step = artifact.steps.find(
      (candidate) =>
        candidate.action.type !== 'navigate' &&
        candidate.action.target.semantic.name === 'Continue',
    );

    expect(step).toBeDefined();
    expect(step?.action.type).not.toBe('navigate');
    if (step === undefined || step.action.type === 'navigate') return;

    expect(step.action.target.recordedTier).toBe('T1_EXACT_ROLE_NAME');
    expect(step.action.target.adapterHints?.web?.stableAttribute?.name).toBe(
      'ctl00$Main$btnContinue',
    );
  });

  it('still SUCCEEDS against the drifted screen, one tier weaker', async () => {
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { relabelContinueButton: 'Continue to review' },
    });

    // A downgrade is a DRIFT SIGNAL, not a failure. The capability did its job.
    expect(outcome.result.status).toBe('success');

    const downgraded = outcome.steps.filter((step) => step.downgraded);
    expect(downgraded.length).toBeGreaterThan(0);
    expect(downgraded[0]?.tierUsed).toBe('T4_STABLE_ATTRIBUTE');
  }, 120_000);

  it('counts the downgrade in metrics.locatorTierDowngrades', async () => {
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { relabelContinueButton: 'Continue to review' },
    });

    // The number PHASE 10 quotes.
    expect(outcome.result.metrics.locatorTierDowngrades).toBeGreaterThan(0);
  }, 120_000);

  it('writes the downgrade into the evidence file', async () => {
    const evidence = new EvidenceWriter({ runId: 'downgrade-' + Date.now() });

    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      evidence,
      faults: { relabelContinueButton: 'Continue to review' },
    });
    expect(outcome.result.status).toBe('success');

    const events = readFileSync(evidence.runDir + '/events.jsonl', 'utf8')
      .trim()
      .split(String.fromCharCode(10))
      .map((line) => JSON.parse(line) as { type: string; downgraded?: boolean; tierUsed?: string });

    // The claim PHASE 10 will make is "replay resolved at a weaker tier than recorded". That claim
    // is read off the evidence bundle, so the evidence bundle is where it has to be true.
    const performed = events.filter((event) => event.type === 'action_performed');
    expect(performed.some((event) => event.downgraded === true)).toBe(true);
    expect(
      performed.some(
        (event) => event.downgraded === true && event.tierUsed === 'T4_STABLE_ATTRIBUTE',
      ),
    ).toBe(true);
  }, 120_000);

  it('does NOT report a downgrade when the screen is unchanged', async () => {
    // The negative control. Without it, an implementation that marked every step `downgraded`
    // would pass every assertion above.
    const outcome = await replayAgainstFixture({ artifact, params: INPUTS });

    expect(outcome.result.status).toBe('success');
    expect(outcome.steps.some((step) => step.downgraded)).toBe(false);
    expect(outcome.result.metrics.locatorTierDowngrades).toBe(0);
  }, 120_000);

  it('surfaces the downgrade to a human when the run also fails', async () => {
    // A drifted screen AND a restricted member. The report has to say both things: the failure is
    // an entitlement problem, and separately, a locator resolved weaker than recorded.
    const outcome = await replayAgainstFixture({
      artifact,
      params: { ...INPUTS, memberId: '10003', nickname: 'Restricted' },
      faults: { relabelContinueButton: 'Continue to review' },
    });

    const report = formatResultForHuman({ artifact, outcome });
    expect(report).toContain('PERMISSION_DENIED');
    expect(report).toContain('tiers attempted:');
  }, 120_000);
});
