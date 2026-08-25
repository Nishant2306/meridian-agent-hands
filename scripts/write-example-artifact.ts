import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CapabilityArtifactSchema, type CapabilityArtifact } from '../src/artifact/schema.js';
import { contentHash } from '../src/artifact/hash.js';
import { profileHash } from '../src/artifact/profiles.js';
import { validateArtifactStructure } from '../src/artifact/validate.js';
import { loadDiscoverySpec } from '../src/config/spec.js';
import type { Assertion } from '../src/types/assertion.js';
import type { TargetDescriptor } from '../src/types/control.js';

/**
 * Writes examples/artifacts/prepare_subaccount_review@1.0.0.example.json.
 *
 * ==============================================================================================
 * THIS ARTIFACT IS HAND-AUTHORED FOR DOCUMENTATION. IT IS NOT THE OUTPUT OF A DISCOVERY RUN.
 * ==============================================================================================
 * No model was called to produce it and its provenance block says so in plain text. It exists so
 * that docs/SCHEMA.md has something real to annotate and so the schema has something real to
 * validate, before PHASE 4 exists to produce the genuine article.
 *
 * What IS real about it:
 *   - the profile SHA-256 pins are computed here from the actual profile files on disk
 *   - the specHash is computed from the actual DiscoverySpec
 *   - every TargetDescriptor was taken from a real capture in tests/fixtures/observations
 *   - it passes the same schema and the same structural validation as any distilled artifact
 */

const CONDITION_PROFILE = 'config/condition-profiles/meridian-subaccount/1.0.0.yaml';
const SAFETY_PROFILE = 'config/safety-profiles/banking-default/1.0.0.yaml';
const SPEC = 'config/specs/prepare_subaccount_review.yaml';
const OUT_DIR = 'examples/artifacts';
const OUT_FILE = OUT_DIR + '/prepare_subaccount_review@1.0.0.example.json';

const literal = (value: string): Assertion['expected'] => ({ kind: 'literal', value });
const param = (name: string): Assertion['expected'] => ({ kind: 'param', name });

const descriptor = (
  semantic: TargetDescriptor['semantic'],
  recordedTier: TargetDescriptor['recordedTier'],
  adapterHints?: TargetDescriptor['adapterHints'],
): TargetDescriptor => ({
  semantic,
  recordedTier,
  ...(adapterHints === undefined ? {} : { adapterHints }),
});

const web = (name: string): TargetDescriptor['adapterHints'] => ({
  web: { contextPath: ['contentFrame'], stableAttribute: { name } },
});

// Every one of these was read out of a real capture in tests/fixtures/observations.
const T = {
  searchBox: descriptor(
    { role: 'textbox', name: 'Member ID', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
    web('ctl00$Main$txtMemberId'),
  ),
  searchButton: descriptor(
    { role: 'button', name: 'Search', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
    web('ctl00$Main$btnSearch'),
  ),
  openMemberRow: descriptor(
    {
      role: 'link',
      name: 'Open',
      nameMatch: 'exact',
      rowKey: { cellText: { kind: 'param', name: 'memberId' } },
    },
    'T5_STRUCTURAL_ROW',
  ),
  newSubAccount: descriptor(
    { role: 'link', name: 'New Sub-Account', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
  accountTypeField: descriptor(
    { role: 'combobox', nameMatch: 'normalized', nearbyText: ['Account Type'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
    web('ctl00$Main$ddlAccountType'),
  ),
  nicknameField: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Nickname'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
    web('ctl00$Main$txtNickname'),
  ),
  depositField: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Initial Deposit'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
    web('ctl00$Main$txtInitialDeposit'),
  ),
  continueButton: descriptor(
    { role: 'button', name: 'Continue', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
    web('ctl00$Main$btnContinue'),
  ),
  memberIdCell: descriptor(
    { role: 'cell', nameMatch: 'normalized', nearbyText: ['Member ID'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  memberNameCell: descriptor(
    { role: 'cell', nameMatch: 'normalized', nearbyText: ['Member Name'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  accountTypeCell: descriptor(
    { role: 'cell', nameMatch: 'normalized', nearbyText: ['Account Type'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  statusCell: descriptor(
    { role: 'cell', nameMatch: 'normalized', nearbyText: ['Status'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
} as const;

const onScreen = (id: string, screen: string): Assertion => ({
  id,
  kind: 'screen_identity',
  expected: literal(screen),
  description: 'the screen is "' + screen + '"',
});

const identityInText = (id: string): Assertion => ({
  id,
  kind: 'text_present',
  expected: param('memberId'),
  description:
    'the member id appears in the screen text. This screen does not display the identity in an ' +
    'addressable field, so this is the strongest check available on it.',
});

const identityInCell = (id: string): Assertion => ({
  id,
  kind: 'value_matches_param',
  target: T.memberIdCell,
  expected: param('memberId'),
  description: 'the member id shown on screen is the member we were asked about',
});

const states: CapabilityArtifact['states'] = [
  {
    id: 'member-details',
    description: 'The member record is open and it is the member we were asked about.',
    screenAssertions: [onScreen('member-details.screen', 'Member Record')],
    qualifiers: [],
    invariants: [identityInCell('member-details.identity')],
    resumeEligible: true,
  },
  {
    id: 'subaccount-form',
    description:
      'The sub-account form is open. NOT resume-eligible: it is a step precondition only. It is a ' +
      'strict prefix of subaccount-form-complete, which is harmless because nothing ever has to ' +
      'choose between them.',
    screenAssertions: [onScreen('subaccount-form.screen', 'New Sub-Account')],
    qualifiers: [],
    invariants: [identityInText('subaccount-form.identity')],
    resumeEligible: false,
  },
  {
    id: 'subaccount-form-complete',
    description:
      'The form is open AND filled in with the values we were asked for. A HALF-FILLED form ' +
      'matches this state no better than it matches any other, which is the point: it matches no ' +
      'resumable state at all and the run goes back to a human.',
    screenAssertions: [onScreen('subaccount-form-complete.screen', 'New Sub-Account')],
    qualifiers: [
      {
        id: 'subaccount-form-complete.account-type',
        kind: 'value_matches_param',
        target: T.accountTypeField,
        expected: param('accountType'),
        description: 'the account type field holds the requested account type',
      },
      {
        id: 'subaccount-form-complete.nickname',
        kind: 'value_matches_param',
        target: T.nicknameField,
        expected: param('nickname'),
        description: 'the nickname field holds the requested nickname',
        when: { paramPresent: 'nickname' },
      },
      {
        id: 'subaccount-form-complete.deposit',
        kind: 'value_matches_param',
        target: T.depositField,
        expected: param('initialDeposit'),
        description: 'the initial deposit field holds the requested amount, compared as currency',
      },
    ],
    invariants: [identityInText('subaccount-form-complete.identity')],
    resumeEligible: true,
  },
  {
    id: 'review',
    description: 'The prepared request is on the review screen, unsubmitted.',
    screenAssertions: [
      onScreen('review.screen', 'Review Sub-Account Request'),
      {
        id: 'review.heading',
        kind: 'text_present',
        expected: literal('Review Sub-Account Request'),
        description: 'the review heading is present',
      },
      {
        id: 'review.status',
        kind: 'value_equals',
        target: T.statusCell,
        expected: literal('PENDING REVIEW'),
        description:
          'the application itself reports the request as PENDING REVIEW. A heading alone is not a ' +
          'complete screen identity: the same heading is on screen a moment before the status is.',
      },
    ],
    qualifiers: [],
    invariants: [identityInCell('review.identity')],
    resumeEligible: true,
  },
];

const wait = { timeoutMs: 10000, pollMs: 100 };
const retries = { max: 1, backoffMs: [250] };

const steps: CapabilityArtifact['steps'] = [
  {
    id: 'step-1-enter-member-id',
    intent: 'Put the member id we were asked about into the search field.',
    action: { type: 'type', target: T.searchBox, value: { kind: 'param', name: 'memberId' } },
    expectedEffects: [
      {
        id: 'step-1.field-holds-id',
        kind: 'value_matches_param',
        target: T.searchBox,
        expected: param('memberId'),
        description: 'the search field now holds the member id',
      },
    ],
    invariants: [],
    wait,
    risk: 'SAFE_REVERSIBLE',
    onFailure: 'fail',
    retries,
  },
  {
    id: 'step-2-search',
    intent: 'Run the search.',
    action: { type: 'click', target: T.searchButton },
    expectedEffects: [
      {
        id: 'step-2.results-appeared',
        kind: 'text_present',
        expected: literal('Search Results'),
        description: 'the results region appeared, which it had not before the click',
      },
    ],
    invariants: [],
    wait,
    risk: 'SAFE_REVERSIBLE',
    onFailure: 'try_recoveries_then_fail',
    retries,
    notes:
      'A search that finds nothing is not a failure of this step. It is MEMBER_NOT_FOUND, a ' +
      'business outcome, detected by the pinned condition profile.',
  },
  {
    id: 'step-3-open-member',
    intent: 'Open the member record from the results row for this member id.',
    action: { type: 'click', target: T.openMemberRow },
    toState: 'member-details',
    expectedEffects: [onScreen('step-3.on-member-record', 'Member Record')],
    invariants: [],
    wait,
    risk: 'SAFE_REVERSIBLE',
    onFailure: 'fail',
    retries,
    notes:
      'Every row on the results screen has a link named "Open". The row key is the only thing ' +
      'that separates them, which is why this resolves at T5_STRUCTURAL_ROW.',
  },
  {
    id: 'step-4-open-subaccount-form',
    intent: 'Open the new sub-account form for this member.',
    action: { type: 'click', target: T.newSubAccount },
    fromState: 'member-details',
    toState: 'subaccount-form',
    expectedEffects: [onScreen('step-4.on-form', 'New Sub-Account')],
    invariants: [identityInText('step-4.still-the-same-member')],
    wait,
    risk: 'SAFE_REVERSIBLE',
    onFailure: 'fail',
    retries,
  },
  {
    id: 'step-5-choose-account-type',
    intent: 'Choose the requested account type.',
    action: {
      type: 'select',
      target: T.accountTypeField,
      value: { kind: 'param', name: 'accountType' },
    },
    fromState: 'subaccount-form',
    expectedEffects: [
      {
        id: 'step-5.type-selected',
        kind: 'value_matches_param',
        target: T.accountTypeField,
        expected: param('accountType'),
        description: 'the account type field now holds the requested type',
      },
    ],
    invariants: [identityInText('step-5.still-the-same-member')],
    wait,
    risk: 'SAFE_REVERSIBLE',
    onFailure: 'fail',
    retries,
    notes:
      'This effect is discriminating only because the form starts on a placeholder. If the form ' +
      'pre-selected Savings, selecting Savings would change nothing and this step could not be ' +
      'distinguished from a click that was swallowed.',
  },
];

steps.push(
  {
    id: 'step-6-enter-nickname',
    intent: 'Enter the optional nickname, when one was supplied.',
    action: { type: 'type', target: T.nicknameField, value: { kind: 'param', name: 'nickname' } },
    fromState: 'subaccount-form',
    expectedEffects: [
      {
        id: 'step-6.nickname-entered',
        kind: 'value_matches_param',
        target: T.nicknameField,
        expected: param('nickname'),
        description: 'the nickname field now holds the requested nickname',
        when: { paramPresent: 'nickname' },
      },
    ],
    invariants: [identityInText('step-6.still-the-same-member')],
    wait,
    risk: 'SAFE_REVERSIBLE',
    onFailure: 'fail',
    retries,
    notes:
      'nickname is OPTIONAL. The effect is guarded with when.paramPresent so that an invocation ' +
      'which omits it does not fail an assertion about it. The step itself still needs a skip ' +
      'rule at replay time, since its value binding has nothing to resolve to; that rule is ' +
      'PHASE 5 and is recorded in DECISIONS.md D16.',
  },
  {
    id: 'step-7-enter-deposit',
    intent: 'Enter the opening deposit.',
    action: {
      type: 'type',
      target: T.depositField,
      value: { kind: 'param', name: 'initialDeposit' },
    },
    fromState: 'subaccount-form',
    expectedEffects: [
      {
        id: 'step-7.deposit-entered',
        kind: 'value_matches_param',
        target: T.depositField,
        expected: param('initialDeposit'),
        description:
          'the deposit field holds the requested amount. Compared as CURRENCY: the caller passes ' +
          '"250.00" and the field holds "250".',
      },
    ],
    invariants: [identityInText('step-7.still-the-same-member')],
    wait,
    risk: 'SAFE_REVERSIBLE',
    onFailure: 'fail',
    retries,
  },
  {
    id: 'step-8-continue-to-review',
    intent: 'Advance to the review screen. The request is NOT submitted.',
    action: { type: 'click', target: T.continueButton },
    fromState: 'subaccount-form-complete',
    toState: 'review',
    expectedEffects: [
      onScreen('step-8.on-review', 'Review Sub-Account Request'),
      {
        id: 'step-8.status-pending',
        kind: 'value_equals',
        target: T.statusCell,
        expected: literal('PENDING REVIEW'),
        description: 'the application reports the prepared request as PENDING REVIEW',
      },
    ],
    invariants: [identityInText('step-8.still-the-same-member')],
    wait,
    risk: 'RISKY_REVERSIBLE',
    onFailure: 'fail',
    retries: { max: 0, backoffMs: [] },
    notes:
      'RISKY_REVERSIBLE, not SAFE_REVERSIBLE: this leaves a pending draft behind that somebody has ' +
      'to look at. A person can discard it, so it is reversible, but it is not nothing. The ' +
      'capability policy allows exactly this much and no more, which is what makes "this ' +
      'capability can never take an irreversible action" a checkable statement rather than a ' +
      'promise.',
  },
);

const outputs: CapabilityArtifact['outputs'] = [
  {
    name: 'memberName',
    type: 'string',
    sensitivity: 'pii',
    required: true,
    when: 'success',
    description: 'The member identity displayed on the prepared request.',
    source: { stateId: 'review', target: T.memberNameCell, parse: 'text' },
  },
  {
    name: 'accountType',
    type: 'enum',
    values: ['Savings', 'Checking'],
    sensitivity: 'public',
    required: true,
    when: 'success',
    description: 'The account type shown on the review screen, read back from the application.',
    source: { stateId: 'review', target: T.accountTypeCell, parse: 'text' },
  },
  {
    name: 'reviewStatus',
    type: 'enum',
    values: ['PENDING REVIEW'],
    sensitivity: 'public',
    required: true,
    when: 'success',
    description: 'The status the application reports for the prepared, unsubmitted request.',
    source: { stateId: 'review', target: T.statusCell, parse: 'text' },
  },
];

function build(): CapabilityArtifact {
  const loaded = loadDiscoverySpec(SPEC);
  const spec = loaded.spec;

  const artifact: CapabilityArtifact = {
    schemaVersion: 1,
    capabilityId: spec.capabilityId,
    name: spec.name,
    description: spec.description,
    capabilityVersion: '1.0.0',
    status: 'draft',

    target: {
      product: spec.target.product,
      surfaceKind: 'legacy_web',
      entryPoint: spec.target.entryPoint,
      compatibility: { versionRange: spec.target.compatibility.versionRange },
      // DELIBERATELY TRUNCATED. A patch release of the vendor product should not fail a capability
      // that never touched anything the patch changed.
      fingerprint: [{ kind: 'text', expected: 'MERIDIAN Core v3.2' }],
    },

    // Copied from the DECLARED spec, never re-invented here. The contract has one author.
    inputs: spec.inputs,
    outputs,

    recordIdentity: { param: spec.recordIdentity.param, target: T.memberIdCell },

    preconditions: [
      {
        description:
          'An operator is signed on and the servicing shell is showing the member search screen. ' +
          'Signing on is not part of this capability: it needs a credential, and a capability that ' +
          'holds a credential is a capability that can be replayed into an account.',
        check: onScreen('precondition.signed-on', 'Member Search'),
      },
    ],

    states,
    steps,
    successState: 'review',

    profiles: {
      condition: {
        id: spec.conditionProfile.id,
        version: spec.conditionProfile.version,
        sha256: profileHash(readFileSync(CONDITION_PROFILE, 'utf8')),
      },
      safety: {
        id: spec.safetyProfile.id,
        version: spec.safetyProfile.version,
        sha256: profileHash(readFileSync(SAFETY_PROFILE, 'utf8')),
      },
    },

    // Stricter than the global ceiling on two of three axes. Never weaker on any.
    policy: { maxRiskAllowed: 'RISKY_REVERSIBLE', maxSteps: 40, maxDurationMs: 120000 },

    // Empty on purpose. The effective set is GLOBAL + PINNED PROFILE + these, and this capability
    // adds nothing the profile does not already cover. Repeating a profile detector here would
    // create a second place to keep in step with the first.
    knownOutcomes: [],
    recoveries: [],
    hardFailures: [],

    provenance: {
      discoveryRunId: 'HAND-AUTHORED-EXAMPLE-NO-DISCOVERY-RUN-PRODUCED-THIS',
      model: 'HAND-AUTHORED-EXAMPLE-NO-MODEL-WAS-CALLED',
      promptVersion: 'HAND-AUTHORED-EXAMPLE',
      goalTemplate: spec.goalTemplate,
      specHash: loaded.specHash,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  };

  return CapabilityArtifactSchema.parse(artifact);
}

const artifact = build();

const issues = validateArtifactStructure(artifact);
if (issues.length > 0) {
  for (const issue of issues) console.error(issue.code + ': ' + issue.message);
  process.exitCode = 1;
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(artifact, null, 2), 'utf8');
  console.log('wrote ' + OUT_FILE);
  console.log('content hash: ' + contentHash(artifact));
  console.log('condition pin: ' + artifact.profiles.condition.sha256);
  console.log('safety pin:    ' + artifact.profiles.safety.sha256);
  console.log('spec hash:     ' + artifact.provenance.specHash);
}
