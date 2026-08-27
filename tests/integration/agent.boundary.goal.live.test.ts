import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceWriter } from '../../src/evidence/logger.js';
import { pseudonymizerFromEnv } from '../../src/redaction/pseudonymize.js';
import { HAPPY_PATH, INPUTS } from '../../scripts/lib/happy-path.js';
import { runScriptedDiscovery } from '../../scripts/lib/scripted-run.js';

/**
 * ================================================================================================
 * WHAT CROSSES THE MODEL BOUNDARY, VERSUS WHAT REACHES DISK.
 * ================================================================================================
 *
 * The second evidence run succeeded and its console line read:
 *
 *     goal:  find member [memberId:subject-01] ... nickname [nickname:subject-01]
 *
 * which looks exactly like the model was handed a labelled goal and told to find a member whose id
 * it had never been given. It was not. `say()` pushes the content into `turns` VERBATIM and writes a
 * separate pseudonymized copy to the transcript; the provider client sends `turn.content` unchanged.
 * The labels are a property of the recording, not of the message.
 *
 * That distinction has now caused a wrong first diagnosis twice, so it is a test rather than a
 * comment. Both halves are asserted in one run, because either alone would let the other regress:
 * an outbound message that quietly started carrying labels would be a real defect, and a transcript
 * that quietly started carrying values would be a real leak.
 */
describe('the goal at the model boundary', () => {
  it('[MUST] goes out with real values and reaches disk labelled', async () => {
    const goal =
      'In MERIDIAN Core Servicing, find member 10001 and prepare a new sub-account request for ' +
      'them of type Savings with nickname Vacation and an initial deposit of 250.00. Advance to ' +
      'the review screen and stop there. Do not submit the request.';

    const evidence = new EvidenceWriter({
      runId: 'boundary-goal',
      rootDir: mkdtempSync(join(tmpdir(), 'boundary-goal-')),
      pseudonymizer: pseudonymizerFromEnv(),
    });
    evidence.declareSensitive({
      sensitiveNames: new Set(['memberId', 'nickname', 'initialDeposit']),
      values: new Map(Object.entries(INPUTS)),
      recordIdentityParam: 'memberId',
    });

    const { client, outcome } = await runScriptedDiscovery({
      script: HAPPY_PATH,
      runtimeInputs: INPUTS,
      goal,
      evidence,
    });

    expect(outcome.result.status).toBe('success');

    // ------------------------------------------------------------------------------------------
    // OUTBOUND. This is the string the provider client was handed.
    // ------------------------------------------------------------------------------------------
    const sent = client.calls[0] ?? '';
    expect(sent).toContain('GOAL: In MERIDIAN Core Servicing, find member 10001');
    expect(sent).toContain('nickname Vacation');
    expect(sent).not.toContain('[memberId:');
    expect(sent).not.toContain('{{');

    // ------------------------------------------------------------------------------------------
    // ON DISK. The same turn, pseudonymized by the one seam every persisted file goes through.
    // ------------------------------------------------------------------------------------------
    const transcript = readFileSync(join(evidence.runDir, 'transcript.jsonl'), 'utf8');
    const firstTurn = JSON.parse(transcript.split(String.fromCharCode(10))[0] ?? '{}') as {
      content?: string;
    };
    expect(firstTurn.content).toContain('[memberId:');
    expect(firstTurn.content).not.toContain('find member 10001');
  }, 180_000);
});
