import { describe, expect, it } from 'vitest';
import { runScriptedDiscovery } from '../../scripts/lib/scripted-run.js';
import { call, findMark, param, type ScriptedTurn } from '../../scripts/lib/scripted-llm.js';

const INPUTS = {
  memberId: '10001',
  accountType: 'Savings',
  nickname: 'Vacation',
  initialDeposit: '250.00',
};

const proposeDone: ScriptedTurn = () => [
  call('propose_goal_reached', { summary: 'I believe this is done.', outputs: {} }),
];

describe('[MUST] the model may propose completion; only the SYSTEM may declare it', () => {
  it('refuses a hallucinated completion when nothing has been done at all', async () => {
    const { outcome } = await runScriptedDiscovery({
      script: [proposeDone, proposeDone, proposeDone],
      runtimeInputs: INPUTS,
    });

    expect(outcome.result.status).not.toBe('success');
    expect(outcome.record.successObservationId).toBeNull();
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('INVARIANT_VIOLATED');
    // The system said WHY, from its own fresh observation.
    expect(outcome.result.observed).toContain('never bound');
  }, 180_000);

  it('[MUST] refuses completion when the page shows a DIFFERENT member than requested', async () => {
    // Everything else about this run is correct. Every declared output extracts and validates:
    // the member name is a real name, the account type is a declared enum member, and the status
    // really is PENDING REVIEW. The ONLY thing wrong is that it is the wrong member - which is
    // precisely the failure no output check would ever catch.
    const wrongMember: ScriptedTurn[] = [
      (inv) => [
        call('type_text', {
          markId: findMark(inv, { role: 'textbox', name: 'Member ID' }),
          value: { kind: 'literal', value: '10002' },
          intent: 'Search for a member, using the field labelled Member ID.',
        }),
      ],
      (inv) => [
        call('click', {
          markId: findMark(inv, { role: 'button', name: 'Search' }),
          intent: 'Run the member search with the Search button.',
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
      (inv) => [
        call('select_option', {
          markId: findMark(inv, { role: 'combobox', near: 'Account Type' }),
          value: param('accountType'),
          intent: 'Choose the requested account type, labelled Account Type to its left.',
        }),
      ],
      (inv) => [
        call('type_text', {
          markId: findMark(inv, { role: 'textbox', near: 'Initial Deposit' }),
          value: param('initialDeposit'),
          intent: 'Enter the opening deposit, labelled Initial Deposit to its left.',
        }),
      ],
      (inv) => [
        call('click', {
          markId: findMark(inv, { role: 'button', name: 'Continue' }),
          intent: 'Advance to the review screen without submitting anything.',
        }),
      ],
      (inv) => [
        call('propose_record_identity', {
          markId: findMark(inv, { role: 'cell', near: 'Member ID' }),
          intent: 'The cell beside the Member ID label shows which member this is for.',
        }),
        call('read_value', {
          markId: findMark(inv, { role: 'cell', near: 'Member Name' }),
          outputName: 'memberName',
          parseAs: 'text',
          intent: 'The cell beside the Member Name label carries the member identity.',
        }),
        call('read_value', {
          markId: findMark(inv, { role: 'cell', near: 'Account Type' }),
          outputName: 'accountType',
          parseAs: 'text',
          intent: 'The cell beside the Account Type label carries the account type.',
        }),
        call('read_value', {
          markId: findMark(inv, { role: 'cell', near: 'Status' }),
          outputName: 'reviewStatus',
          parseAs: 'text',
          intent: 'The cell beside the Status label carries the reported status.',
        }),
      ],
      proposeDone,
      proposeDone,
      proposeDone,
    ];

    const { outcome } = await runScriptedDiscovery({ script: wrongMember, runtimeInputs: INPUTS });

    expect(outcome.result.status).not.toBe('success');
    expect(outcome.record.successObservationId).toBeNull();
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.observed).toContain('NOT THE RECORD THAT WAS REQUESTED');

    // The outputs really did read back cleanly. Only the identity check stood in the way.
    expect(outcome.record.outputs.map((output) => output.name).sort()).toEqual([
      'accountType',
      'memberName',
      'reviewStatus',
    ]);
  }, 180_000);
});

describe('stopping conditions', () => {
  it('stops after repeated actions that change nothing', async () => {
    const doNothing: ScriptedTurn = (inv) => [
      call('click', {
        markId: findMark(inv, { role: 'link', name: 'Member Search' }),
        intent: 'Open the member search screen from the navigation menu.',
      }),
    ];

    const { outcome } = await runScriptedDiscovery({
      script: [doNothing, doNothing, doNothing, doNothing, doNothing, doNothing],
      runtimeInputs: INPUTS,
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('EFFECT_NOT_OBSERVED');
    expect(outcome.result.observed).toContain('changed nothing observable');
  }, 180_000);
});
