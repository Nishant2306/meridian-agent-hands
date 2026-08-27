import { beforeAll, describe, expect, it } from 'vitest';
import { distill } from '../src/artifact/distill.js';
import { LeaseViolationError } from '../src/session/errors.js';
import type { CapabilityArtifact } from '../src/artifact/schema.js';
import { DefaultTargetResolver } from '../src/perception/resolver.js';
import { CONFIG_ROOT, runScriptedDiscovery } from '../scripts/lib/scripted-run.js';
import { HAPPY_PATH, INPUTS } from '../scripts/lib/happy-path.js';
import { replayAgainstFixture } from '../scripts/lib/replay-harness.js';
import type { Intervention } from '../src/types/intervention.js';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvidenceWriter } from '../src/evidence/logger.js';
import { Pseudonymizer } from '../src/redaction/pseudonymize.js';
import { FAULT_TEXT } from '../fixtures/legacy-app/faults.js';

/**
 * ================================================================================================
 * THE WHOLE HANDOFF, AGAINST A REAL BROWSER.
 * ================================================================================================
 *
 *   replay runs -> an unrecognised blocking modal appears -> the run STOPS and escalates
 *   -> the lease moves to HUMAN -> the operator clears the modal in THE SAME WINDOW
 *   -> resume -> the SYSTEM re-observes, decides where it is, finishes the work
 *   -> the SYSTEM declares success, completionMode 'human_assisted'
 *
 * The operator here is a callback rather than a person, and it holds the HUMAN lease and acts
 * through the same input path a person's clicks would land on. Everything around it - the lease
 * transfer, the session state machine, the identity evidence, the resume reconciliation - is
 * exactly the code the headed console drives.
 *
 * [MUST] The assertion that makes this more than theatre: the browser context and page target are
 * UNCHANGED across the handoff. A handoff that quietly opened a second browser would look identical
 * in a screenshot and in a log, and would have thrown away the authenticated session.
 */
describe('escalate, hand over, resume', () => {
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

  it('[MUST] end to end: modal -> escalation -> operator -> resume -> human_assisted success', async () => {
    let seen: Intervention | undefined;
    let leaseHeldByHumanBlockedAutomation = false;

    const evidence = new EvidenceWriter({
      runId: 'handoff-' + Date.now(),
      rootDir: mkdtempSync(join(tmpdir(), 'handoff-')),
      pseudonymizer: new Pseudonymizer(),
    });
    evidence.declareSensitive({
      sensitiveNames: new Set(['memberId']),
      values: new Map(Object.entries(INPUTS)),
      recordIdentityParam: 'memberId',
    });

    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      evidence,
      faults: { showUnknownModal: true },
      onEscalation: async ({ intervention, surface, humanToken, coordinator }) => {
        seen = intervention;

        // The AUTOMATION token is dead the moment the HUMAN one is issued. Proven here rather than
        // asserted: the automation's own lease manager refuses it.
        try {
          await surface.resolveAndPerform(
            {
              type: 'click',
              target: {
                semantic: { role: 'button', name: 'Submit attestation', nameMatch: 'exact' },
                recordedTier: 'T1_EXACT_ROLE_NAME',
              },
            },
            { ...humanToken, owner: 'AUTOMATION' },
          );
        } catch (error) {
          leaseHeldByHumanBlockedAutomation = error instanceof LeaseViolationError;
        }

        // Now as the HUMAN. This is the step the automation cannot take: nothing in the pinned
        // profile describes this modal. The code is printed ON SCREEN, so the operator needs no
        // knowledge they do not have - see tests/fixture.human-controls.live.test.ts, which clicks
        // the same controls with a browser.
        const typed = await surface.resolveAndPerform(
          {
            type: 'type',
            target: {
              semantic: {
                role: 'textbox',
                nameMatch: 'normalized',
                nearbyText: ['Attestation code'],
              },
              recordedTier: 'T3_EXTERNAL_LABEL_OR_NEARBY',
            },
            value: { kind: 'literal', value: FAULT_TEXT.attestationCode },
          },
          humanToken,
        );
        expect(typed.result.status, 'the operator could not enter the code').toBe('performed');

        const { result } = await surface.resolveAndPerform(
          {
            type: 'click',
            target: {
              semantic: { role: 'button', name: 'Submit attestation', nameMatch: 'exact' },
              recordedTier: 'T1_EXACT_ROLE_NAME',
            },
          },
          humanToken,
        );
        expect(result.status, 'the operator could not clear the modal').toBe('performed');

        await surface.waitFor({ kind: 'text_present', text: 'Member Record' }, 10_000);
        expect(coordinator.record?.before.targetId).toBeTruthy();
        return 'resume';
      },
    });

    // The run finished, and the SYSTEM said so.
    expect(outcome.result.status).toBe('success');
    if (outcome.result.status !== 'success') return;

    // [MUST] Not 'automation'. A person was involved and the result says so, permanently.
    expect(outcome.result.completionMode).toBe('human_assisted');
    expect(outcome.result.outputs['reviewStatus']).toBe('PENDING REVIEW');
    expect(outcome.result.metrics.humanInterventions).toBe(1);
    expect(outcome.result.metrics.llmCalls).toBe(0);

    // [MUST] THE SAME LIVE SESSION.
    expect(outcome.sameSession).toBe(true);

    // The mutual exclusion was real, not assumed.
    expect(leaseHeldByHumanBlockedAutomation).toBe(true);

    // And the intervention told the operator what they needed.
    expect(seen?.kind).toBe('unknown_state');
    expect(seen?.allowedChoices).toEqual(['resume', 'abort']);
    expect(seen?.currentStep.intent).toBeTruthy();
    // The console polls a MASKED screenshot of the same page. Only the masked image is ever
    // written, so what the operator looks at is the same file a reviewer would find in evidence.
    expect(seen?.state.maskedScreenshotRef).toContain('.png');

    // And the same-session claim is in the EVIDENCE, not only in the return value, because that is
    // where PHASE 10 will read it.
    const events = readFileSync(join(evidence.runDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('handoff_same_session');
    expect(events).toContain('"same":true');
  }, 180_000);

  it('abort ends the run as cancelled, not failed', async () => {
    // A person deciding to stop is not a malfunction. Exit code 25, not 30.
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { showUnknownModal: true },
      onEscalation: async () => 'abort',
    });

    expect(outcome.result.status).toBe('cancelled');
    if (outcome.result.status !== 'cancelled') return;
    expect(outcome.result.reason).toBe('OPERATOR_ABORTED');
  }, 180_000);

  it('[MUST] a human who changes the record gets a HARD FAILURE, not a resume', async () => {
    // The operator "helpfully" navigates to a different member and hands control back. The screen
    // shape matches a known state perfectly; the identity invariant does not. Never continue.
    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { showUnknownModal: true },
      onEscalation: async ({ surface, humanToken }) => {
        await surface.resolveAndPerform(
          {
            type: 'navigate',
            pathSegments: [
              { kind: 'literal', value: 'member' },
              { kind: 'literal', value: '10002' },
            ],
          },
          humanToken,
        );
        return 'resume';
      },
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('INVARIANT_VIOLATED');
    expect(outcome.result.observed).toContain('different record');
  }, 180_000);

  it('a human who leaves the screen somewhere unrecognised comes BACK to a human', async () => {
    // Zero resume points match. The correct answer is another question, not a guess - and the run
    // gives up rather than looping, because a person who cannot resolve it twice will not on the
    // third pass either.
    let asked = 0;

    const outcome = await replayAgainstFixture({
      artifact,
      params: INPUTS,
      faults: { showUnknownModal: true },
      maxInterventions: 2,
      onEscalation: async ({ surface, humanToken }) => {
        asked += 1;
        await surface.resolveAndPerform(
          { type: 'navigate', pathSegments: [{ kind: 'literal', value: 'search' }] },
          humanToken,
        );
        return 'resume';
      },
    });

    expect(asked).toBeGreaterThan(1);
    expect(outcome.result.status).toBe('needs_human');
  }, 180_000);
});
