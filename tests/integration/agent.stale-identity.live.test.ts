import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceWriter } from '../../src/evidence/logger.js';
import { call, findMark, param, type ScriptedTurn } from '../../scripts/lib/scripted-llm.js';
import { runScriptedDiscovery } from '../../scripts/lib/scripted-run.js';

/**
 * ================================================================================================
 * THE GATE 3 RUN, DRIVEN THROUGH THE REAL LOOP.
 * ================================================================================================
 *
 * `tests/unit/agent.completion.identity` proves the verifier picks the right candidate and
 * `tests/unit/agent.outstanding` proves the refusal tracker says the right thing. Neither proves
 * the LOOP wires them together, and that gap is exactly the one this project keeps falling into:
 * the mechanism works and the path nobody exercised does not.
 *
 * So this drives a real browser and the real discovery loop with a scripted client that reproduces
 * what the model actually did:
 *
 *   - binds the record identity on the New Sub-Account form, to a summary line that will not
 *     resolve on the review screen
 *   - reaches the review screen, binds the outputs, proposes completion
 *   - is refused, because the only identity binding is stale
 *   - rebinds the identity to the review screen's Member ID cell
 *   - proposes completion again, and succeeds
 *
 * The run that produced this failure never reached the last two steps: it was told "Bound the
 * record identity. The system will check it, not you." and had no reason to think anything had
 * changed. The assertion on the acknowledgement text is the one that would have caught it.
 */
const INPUTS = {
  memberId: '10001',
  accountType: 'Savings',
  nickname: 'Vacation',
  initialDeposit: '250.00',
};

const STALE_IDENTITY_THEN_RECOVER: ScriptedTurn[] = [
  (inv) => [
    call('type_text', {
      markId: findMark(inv, { role: 'textbox', name: 'Member ID' }),
      value: param('memberId'),
      intent: 'Put the requested member id into the search field.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'button', name: 'Search' }),
      intent: 'Run the member search.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'link', name: 'Open' }),
      intent: 'Open the member record from the results row.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'link', name: 'New Sub-Account' }),
      intent: 'Start a new sub-account for this member.',
    }),
  ],
  // THE DEFECTIVE BINDING. On the form screen the identity is a summary line - a `text` node that
  // does not exist on the review screen where completion is checked.
  (inv) => [
    call('propose_record_identity', {
      markId: findMark(inv, { role: 'text', near: 'New Sub-Account' }),
      intent: 'The summary line names the member this form is for.',
    }),
    call('select_option', {
      markId: findMark(inv, { role: 'combobox', near: 'Account Type' }),
      value: param('accountType'),
      intent: 'Choose the requested account type.',
    }),
  ],
  (inv) => [
    call('type_text', {
      markId: findMark(inv, { role: 'textbox', near: 'Nickname' }),
      value: param('nickname'),
      intent: 'Type the requested nickname.',
    }),
  ],
  (inv) => [
    call('type_text', {
      markId: findMark(inv, { role: 'textbox', near: 'Initial Deposit' }),
      value: param('initialDeposit'),
      intent: 'Type the requested initial deposit.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'button', name: 'Continue' }),
      intent: 'Advance to the review screen.',
    }),
  ],
  (inv) => [
    call('read_value', {
      markId: findMark(inv, { role: 'cell', near: 'Member Name' }),
      outputName: 'memberName',
      parseAs: 'text',
      intent: 'The cell beside the Member Name label.',
    }),
    call('read_value', {
      markId: findMark(inv, { role: 'cell', near: 'Account Type' }),
      outputName: 'accountType',
      parseAs: 'text',
      intent: 'The cell beside the Account Type label.',
    }),
    call('read_value', {
      markId: findMark(inv, { role: 'cell', near: 'Status' }),
      outputName: 'reviewStatus',
      parseAs: 'text',
      intent: 'The cell beside the Status label.',
    }),
  ],
  () => [
    call('propose_goal_reached', {
      summary: 'The sub-account request is prepared and waiting on the review screen.',
      outputs: {},
    }),
  ],
  // Refused. The model does what the real one did: rebinds the identity on THIS screen.
  (inv) => [
    call('propose_record_identity', {
      markId: findMark(inv, { role: 'cell', near: 'Member ID' }),
      intent: 'The cell beside the Member ID label shows which member this request is for.',
    }),
  ],
  () => [
    call('propose_goal_reached', {
      summary: 'The sub-account request is prepared and waiting on the review screen.',
      outputs: {},
    }),
  ],
];

describe('a stale record-identity binding, end to end', () => {
  it('[MUST] is refused as STALE, then recovers and completes', async () => {
    // The EVIDENCE TRANSCRIPT rather than the scripted client's own record, because the client only
    // keeps turns that carry an inventory and the acknowledgement under test carries none. This is
    // also the artefact a reviewer reads, so asserting on it is asserting on what they would see.
    const evidence = new EvidenceWriter({
      runId: 'stale-identity',
      rootDir: mkdtempSync(join(tmpdir(), 'stale-identity-')),
    });

    const { outcome } = await runScriptedDiscovery({
      script: STALE_IDENTITY_THEN_RECOVER,
      runtimeInputs: INPUTS,
      evidence,
    });

    expect(outcome.result.status).toBe('success');

    // Everything the model was shown, in order.
    const shown = readFileSync(join(evidence.runDir, 'transcript.jsonl'), 'utf8');

    // 1. The refusal happened, and it said STALE rather than "not visible on the current screen".
    expect(shown).toContain('could NOT confirm the goal was met');
    expect(shown).toContain('STALE, not missing');
    expect(shown).toContain('New Sub-Account');
    expect(shown).not.toContain('the record identity is not visible on the current screen');

    // 2. The acknowledgement for the fix told it what to do next. This is the sentence whose
    //    absence ended the real run.
    expect(shown).toContain('That was the last thing blocking completion');
    expect(shown).toContain('propose_goal_reached again');

    // 3. And the artifact-bound identity is the one proven on the SUCCESS screen, not the form
    //    binding the model proposed first. Replay re-checks this descriptor on this screen.
    expect(outcome.record.recordIdentity?.screenName).toBe('Review Sub-Account Request');
    expect(outcome.record.recordIdentity?.target.semantic.role).toBe('cell');
    expect(outcome.record.successObservationId).not.toBeNull();
  }, 180_000);
});
