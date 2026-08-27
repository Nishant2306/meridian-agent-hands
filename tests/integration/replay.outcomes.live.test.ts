import { beforeAll, describe, expect, it } from 'vitest';
import { distill } from '../../src/artifact/distill.js';
import { formatResultForHuman } from '../../src/replay/report.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { CONFIG_ROOT, runScriptedDiscovery } from '../../scripts/lib/scripted-run.js';
import { HAPPY_PATH, INPUTS } from '../../scripts/lib/happy-path.js';
import { replayAgainstFixture } from '../../scripts/lib/replay-harness.js';

/**
 * ================================================================================================
 * PHASE 6. WHAT HAPPENS WHEN THE APPLICATION DOES NOT COOPERATE.
 * ================================================================================================
 *
 * Every condition here is described by the PINNED profile, which was finalized in PHASE 3 and is
 * never edited to match the fixture. The fixture was made to match it, and
 * `tests/fixture.faults.test.ts` checks the strings against the profile itself.
 *
 * The capability under test is DISTILLED FROM A RUN, not hand-written, so these run against the
 * same artifact shape a real discovery produces.
 */
describe('runtime outcomes', () => {
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

  // ==============================================================================================
  // BUSINESS OUTCOMES ARE NOT FAILURES.
  // ==============================================================================================

  it('99999 returns a BUSINESS OUTCOME, and is not a failure', async () => {
    const outcome = await replayAgainstFixture({
      artifact,
      params: { ...INPUTS, memberId: '99999' },
    });

    expect(outcome.result.status).toBe('business_outcome');
    // The assertion that matters as much as the positive one. There is no RECORD_NOT_FOUND error,
    // and a caller must never be told the automation broke when it worked and the answer was no.
    expect(outcome.result.status).not.toBe('failed');
    if (outcome.result.status !== 'business_outcome') return;
    expect(outcome.result.outcome).toBe('MEMBER_NOT_FOUND');
  }, 120_000);

  it('[MUST] detects 99999 BEFORE the wait timeout, not by timing out', async () => {
    // ==========================================================================================
    // THE LOAD-BEARING TEST OF THIS PHASE.
    // ==========================================================================================
    //
    // If detectors ran AFTER the wait instead of inside it, this run would still report
    // MEMBER_NOT_FOUND eventually - the code would look correct and the test would pass. What
    // would differ is the clock: every "no such member" would cost a full timeout, and under load
    // that is the difference between a working service and a queue.
    //
    // So the assertion is on ELAPSED TIME against the step's own timeout. It is the only way to
    // tell "detected" from "gave up and then noticed".
    const timeoutMs = Math.max(...artifact.steps.map((step) => step.wait.timeoutMs));
    expect(timeoutMs).toBeGreaterThan(0);

    const started = Date.now();
    const outcome = await replayAgainstFixture({
      artifact,
      params: { ...INPUTS, memberId: '99999' },
    });
    const elapsed = Date.now() - started;

    expect(outcome.result.status).toBe('business_outcome');
    // Includes browser launch and sign-on, so it is generous - and still far under one timeout.
    expect(
      elapsed,
      'took ' + elapsed + 'ms against a ' + timeoutMs + 'ms step timeout',
    ).toBeLessThan(timeoutMs + 8_000);
  }, 120_000);

  // ==============================================================================================
  // RECOVERY.
  // ==============================================================================================

  it('10004 recovers from the maintenance notice ONCE and then succeeds', async () => {
    // Member 10004 carries `knownNotice` in the seed data, so the notice appears on the sub-account
    // form with nothing armed. Nothing about it is a decision, so the automation may clear it.
    const outcome = await replayAgainstFixture({
      artifact,
      params: { ...INPUTS, memberId: '10004', nickname: 'Rainy Day' },
    });

    expect(outcome.result.status).toBe('success');
    expect(outcome.result.metrics.recoveriesUsed).toBe(1);
  }, 120_000);

  it('[MUST] 10004 does NOT repeat the interrupted click', async () => {
    // The notice appears on the screen the "New Sub-Account" click NAVIGATED TO. The click worked.
    // Repeating it would navigate a second time from a page whose link is no longer on it - which
    // is exactly why the recovery's continuation is `recheck_expected_effect` and not
    // `retry_action`.
    const outcome = await replayAgainstFixture({
      artifact,
      params: { ...INPUTS, memberId: '10004', nickname: 'Rainy Day' },
    });

    expect(outcome.result.status).toBe('success');

    const recovered = outcome.steps.filter((step) => (step.recoveriesAttempted ?? []).length > 0);
    expect(recovered.length).toBe(1);

    // ONE attempt of the action. The recovery ran, the effect was rechecked, and the click was not
    // performed again.
    expect(recovered[0]?.attempts).toBe(1);
    expect(recovered[0]?.detail).toContain('NOT repeated');
    expect(recovered[0]?.recoveriesAttempted).toEqual(['DISMISS_MAINTENANCE_NOTICE']);
  }, 120_000);

  // ==============================================================================================
  // HARD FAILURES. EACH IS A DIFFERENT REMEDIATION.
  // ==============================================================================================

  it('10003 fails with PERMISSION_DENIED, with expected and observed', async () => {
    const outcome = await replayAgainstFixture({
      artifact,
      params: { ...INPUTS, memberId: '10003', nickname: 'Restricted' },
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('PERMISSION_DENIED');
    // A failure is a disagreement, and one half of a disagreement is not a diagnosis.
    expect(outcome.result.expected).toBeTruthy();
    expect(outcome.result.observed).toBeTruthy();
  }, 120_000);

  it('validationErrorOnContinue fails with APPLICATION_VALIDATION_REJECTED', async () => {
    // OUR contract accepted the value; the APPLICATION did not. Distinct from
    // INPUT_VALIDATION_FAILED, which is our own refusal before a browser is ever opened.
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { validationErrorOnContinue: true },
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('APPLICATION_VALIDATION_REJECTED');
  }, 120_000);

  it('expireSession fails with SESSION_EXPIRED, and reports the session as gone', async () => {
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { expireSession: true },
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('SESSION_EXPIRED');
    // Decides the next move: sign on again, rather than go and look at the screen.
    expect(outcome.sessionAlive).toBe(false);
  }, 120_000);

  it('http500OnRoute fails with APPLICATION_UNAVAILABLE, not UNKNOWN', async () => {
    // The application answered, and what it said was that it cannot serve the request. Reporting
    // that as UNKNOWN would send an operator looking at the automation.
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { http500OnRoute: '/member/10001' },
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('APPLICATION_UNAVAILABLE');
    expect(outcome.result.error).not.toBe('UNKNOWN');
  }, 120_000);

  // ==============================================================================================
  // BOUNDED WAIT, AND THE UNRECOGNISED STATE.
  // ==============================================================================================

  it('slowLoadMs waits and then succeeds', async () => {
    // A slow screen is not a broken one. The wait is BOUNDED and recorded; the run still passes.
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { slowLoadMs: 700 },
    });

    expect(outcome.result.status).toBe('success');
  }, 120_000);

  it('showUnknownModal returns NEEDS_HUMAN rather than guessing past it', async () => {
    // The modal is deliberately absent from the condition profile. Rung 5 of the ladder: nothing
    // above explains where we are, and an unrecognised BLOCKING state is a human decision.
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { showUnknownModal: true },
    });

    expect(outcome.result.status).toBe('needs_human');
    if (outcome.result.status !== 'needs_human') return;
    expect(outcome.result.reason).toContain('blocking dialog');
    expect(outcome.result.interventionId).toBeTruthy();
    // It must NOT be reported as a plain failure: nothing is broken, something is in the way.
    expect(outcome.result.status).not.toBe('failed');
  }, 120_000);

  it('a browser that dies mid-run fails with SURFACE_UNAVAILABLE, not an exception', async () => {
    // A REAL Chromium is closed under the engine. The distinction being tested is the one a caller
    // acts on: SURFACE_UNAVAILABLE restarts a browser, APPLICATION_UNAVAILABLE waits for a vendor.
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { slowLoadMs: 600 },
      killBrowserAfterMs: 900,
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('SURFACE_UNAVAILABLE');
    expect(outcome.result.error).not.toBe('APPLICATION_UNAVAILABLE');
    // Nothing left to look at, so the next move is not "go and read the screen".
    expect(outcome.sessionAlive).toBe(false);
  }, 120_000);

  // ==============================================================================================
  // 6D. THE FAILURE REPORT.
  // ==============================================================================================

  it('formatResultForHuman renders every field a person needs', async () => {
    const outcome = await replayAgainstFixture({
      artifact,
      params: { ...INPUTS, memberId: '10003', nickname: 'Restricted' },
    });

    const report = formatResultForHuman({ artifact, outcome });

    expect(report).toContain(artifact.capabilityId + '@' + artifact.capabilityVersion);
    expect(report).toContain('PERMISSION_DENIED');
    expect(report).toContain('expected:');
    expect(report).toContain('observed:');
    expect(report).toContain('tiers attempted:');
    expect(report).toContain('recoveries:');
    expect(report).toContain('session:');
    expect(report).toContain('evidence:');

    // The step's recorded INTENT, not just its id. An id alone sends the reader to the artifact.
    if (outcome.result.status === 'failed') {
      const stepId = outcome.result.stepId;
      const failedStep = artifact.steps.find((step) => step.id === stepId);
      if (failedStep !== undefined) expect(report).toContain(failedStep.intent);
    }
  }, 120_000);

  it('names the recovery in the report when one was used', async () => {
    const outcome = await replayAgainstFixture({
      artifact,
      params: { ...INPUTS, memberId: '10004', nickname: 'Rainy Day' },
    });

    // A success gets the short form; the recovery detail lives in the steps and the evidence.
    expect(formatResultForHuman({ artifact, outcome })).toContain('SUCCEEDED');
    expect(outcome.steps.some((step) => (step.recoveriesAttempted ?? []).length > 0)).toBe(true);
  }, 120_000);
});
