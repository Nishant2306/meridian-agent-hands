import { call, findMark, param, type ScriptedTurn } from './scripted-llm.js';

export const INPUTS = {
  memberId: '10001',
  accountType: 'Savings',
  nickname: 'Vacation',
  initialDeposit: '250.00',
};

/**
 * The happy path, as a scripted model would drive it.
 *
 * The script finds its marks by READING THE RENDERED INVENTORY, exactly as a model would. It has
 * no privileged access to the Observation, so a descriptor bug cannot hide behind the fake.
 */
export const HAPPY_PATH: ScriptedTurn[] = [
  (inv) => [
    call('type_text', {
      markId: findMark(inv, { role: 'textbox', name: 'Member ID' }),
      value: param('memberId'),
      intent: 'Put the requested member id into the search field, which is labelled Member ID.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'button', name: 'Search' }),
      intent: 'Run the member search using the Search button next to the member id field.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'link', name: 'Open' }),
      intent: 'Open the member record from the results row for the member we were asked about.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'link', name: 'New Sub-Account' }),
      intent: 'Start a new sub-account for this member using the New Sub-Account link.',
    }),
  ],
  (inv) => [
    call('select_option', {
      markId: findMark(inv, { role: 'combobox', near: 'Account Type' }),
      value: param('accountType'),
      intent: 'Choose the requested account type in the select labelled Account Type to its left.',
    }),
  ],
  (inv) => [
    call('type_text', {
      markId: findMark(inv, { role: 'textbox', near: 'Nickname' }),
      value: param('nickname'),
      intent: 'Enter the nickname in the field labelled Nickname (optional) to its left.',
    }),
  ],
  (inv) => [
    call('type_text', {
      markId: findMark(inv, { role: 'textbox', near: 'Initial Deposit' }),
      value: param('initialDeposit'),
      intent: 'Enter the opening deposit in the field labelled Initial Deposit to its left.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'button', name: 'Continue' }),
      intent: 'Advance to the review screen with Continue. This does not submit the request.',
    }),
  ],
  (inv) => [
    call('propose_effect', {
      markId: findMark(inv, { role: 'cell', name: 'PENDING REVIEW' }),
      kind: 'value_equals',
      expected: 'PENDING REVIEW',
      description: 'the application reports the prepared request as PENDING REVIEW',
    }),
    call('propose_state_reached', {
      label: 'subaccount_review',
      evidence: 'the review heading and a PENDING REVIEW status are both on screen',
    }),
  ],
  (inv) => [
    call('propose_record_identity', {
      markId: findMark(inv, { role: 'cell', near: 'Member ID' }),
      intent: 'The cell beside the Member ID label shows which member this request is for.',
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
      intent: 'The cell beside the Account Type label carries the chosen account type.',
    }),
    call('read_value', {
      markId: findMark(inv, { role: 'cell', near: 'Status' }),
      outputName: 'reviewStatus',
      parseAs: 'text',
      intent: 'The cell beside the Status label carries the status the application reports.',
    }),
  ],
  () => [
    call('propose_goal_reached', {
      summary: 'The sub-account request is prepared and waiting on the review screen.',
      outputs: {},
    }),
  ],
];

/**
 * The same path, preceded by a search for a member that does not exist.
 *
 * The run therefore ENCOUNTERS the MEMBER_NOT_FOUND condition on its way to success, which is
 * what makes it useful: a condition a run merely met must never end up in the executable
 * artifact.
 */
export const ENCOUNTERS_A_CONDITION: ScriptedTurn[] = [
  (inv) => [
    call('type_text', {
      markId: findMark(inv, { role: 'textbox', name: 'Member ID' }),
      value: { kind: 'literal', value: '99999' },
      intent: 'Try a member id in the field labelled Member ID to see what the search does.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'button', name: 'Search' }),
      intent: 'Run the member search with the Search button beside the field.',
    }),
  ],
  ...HAPPY_PATH,
];
