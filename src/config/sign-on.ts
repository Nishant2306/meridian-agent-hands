import type { TargetDescriptor } from '../types/control.js';

/**
 * ==============================================================================================
 * [MUST] AUTHENTICATION IS NOT PART OF THE CAPABILITY.
 * ==============================================================================================
 *
 * Signing on is DEPLOYMENT configuration: it belongs to the environment a capability runs in, not
 * to the capability itself. A capability that carried a credential would be a capability that
 * could be replayed into an account, and every copy of the artifact would be a copy of the
 * credential's blast radius.
 *
 * So the sign-on descriptors live here, outside any artifact, and the credentials travel as SECRET
 * REFERENCES resolved by the executor. Both the discovery CLI and the replay session broker use
 * this one definition, so there is exactly one place that knows how to authenticate.
 *
 * The capability begins at "authenticated, on the entry screen". Everything before that is the
 * broker's job.
 */
export interface SignOnConfig {
  operator: TargetDescriptor;
  passcode: TargetDescriptor;
  submit: TargetDescriptor;
  operatorSecretRef: string;
  passcodeSecretRef: string;
  /** Text that proves the session is authenticated and the entry screen has loaded. */
  authenticatedText: string;
}

const descriptor = (
  semantic: TargetDescriptor['semantic'],
  recordedTier: TargetDescriptor['recordedTier'],
): TargetDescriptor => ({ semantic, recordedTier });

/**
 * MERIDIAN Core Servicing sign-on.
 *
 * The two credential fields have NO accessible name - the label is the table cell to their left -
 * so they resolve at T3, exactly like the form fields the capability itself operates.
 */
export const MERIDIAN_SIGN_ON: SignOnConfig = {
  operator: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Operator ID'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  passcode: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Passcode'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  submit: descriptor({ role: 'button', name: 'Log In', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME'),
  operatorSecretRef: 'operatorId',
  passcodeSecretRef: 'operatorPasscode',
  authenticatedText: 'Member Search',
};

/**
 * The fixture accepts ANY non-empty operator id and passcode, and no credential is stored in this
 * repository. These are placeholders that travel the same path a real secret would: as a
 * secretRef, resolved by the executor, never seen by a model and never written to an event.
 */
export function fixtureCredentials(): Record<string, string> {
  return {
    operatorId: process.env['OPERATOR_ID'] ?? 'fixture-operator',
    operatorPasscode: process.env['OPERATOR_PASSCODE'] ?? 'fixture-passcode',
  };
}
