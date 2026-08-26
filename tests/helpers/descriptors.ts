import type { TargetDescriptor } from '../../src/types/control.js';

/**
 * Descriptors the browser-driven tests use to walk the fixture to a given screen.
 *
 * These are TEST FIXTURES, not configuration: they describe what a person operating this app would
 * click, so a test can reach the review screen without a second implementation of the flow. Sign-on
 * is deliberately NOT here - it lives in `src/config/sign-on.ts`, which is the one definition both
 * the discovery CLI and the replay broker use, and a copy of it in a test would be the same
 * duplication that `tests/config.sign-on.test.ts` exists to prevent.
 */
const descriptor = (
  semantic: TargetDescriptor['semantic'],
  recordedTier: TargetDescriptor['recordedTier'],
): TargetDescriptor => ({ semantic, recordedTier });

export const FIXTURE_CONTROLS = {
  memberId: descriptor(
    { role: 'textbox', name: 'Member ID', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
  search: descriptor({ role: 'button', name: 'Search', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME'),
  open10001: descriptor(
    {
      role: 'link',
      name: 'Open',
      nameMatch: 'exact',
      rowKey: { cellText: { kind: 'literal', value: '10001' } },
    },
    'T5_STRUCTURAL_ROW',
  ),
  newSubAccount: descriptor(
    { role: 'link', name: 'New Sub-Account', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
  accountType: descriptor(
    { role: 'combobox', nameMatch: 'normalized', nearbyText: ['Account Type'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  nickname: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Nickname (optional)'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  deposit: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Initial Deposit'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  continue: descriptor(
    { role: 'button', name: 'Continue', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
  /** Present so a guardrail test can name it. It must never be clicked. */
  submit: descriptor(
    { role: 'button', name: 'Submit Request', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
} as const;

/** `pathSegments` are TextMatchers, not strings. A string array navigates nowhere in particular. */
export function pathSegments(path: string): { kind: 'literal'; value: string }[] {
  return path
    .replace(/^\//, '')
    .split('/')
    .filter((part) => part !== '')
    .map((value) => ({ kind: 'literal' as const, value }));
}
