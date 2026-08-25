import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConditionProfile, loadSafetyProfile, profileHash } from '../src/artifact/profiles.js';
import {
  detectCondition,
  detectMatches,
  effectiveDetectors,
  GLOBAL_DETECTORS,
} from '../src/artifact/detectors.js';
import {
  classifyControlRisk,
  contextualDenyReason,
  isIrreversibleControl,
} from '../src/artifact/policy.js';
import { phraseMatches } from '../src/artifact/phrases.js';
import { IRREVERSIBLE_NAME_PATTERNS } from '../src/surface/bootstrap-policy.js';
import { loadObservation } from './helpers/observations.js';

const CONDITION_PATH = fileURLToPath(
  new URL('../config/condition-profiles/meridian-subaccount/1.0.0.yaml', import.meta.url),
);
const SAFETY_PATH = fileURLToPath(
  new URL('../config/safety-profiles/banking-default/1.0.0.yaml', import.meta.url),
);

const condition = loadConditionProfile(CONDITION_PATH);
const safety = loadSafetyProfile(SAFETY_PATH);

describe('the pinned profiles', () => {
  it('load and identify themselves', () => {
    expect(condition.profile.id).toBe('meridian-subaccount');
    expect(condition.profile.version).toBe('1.0.0');
    expect(safety.profile.id).toBe('banking-default');
    expect(safety.profile.version).toBe('1.0.0');
  });

  it('hash the file text, so a comment cannot be rewritten without moving the pin', () => {
    const text = readFileSync(CONDITION_PATH, 'utf8');
    expect(condition.sha256).toBe(profileHash(text));
    expect(condition.sha256).toMatch(/^[0-9a-f]{64}$/);

    const commentEdited = text.replace('# CONDITION PROFILE', '# CONDITION PROFILE (edited)');
    expect(profileHash(commentEdited)).not.toBe(condition.sha256);
  });

  it('hashes identically whatever line endings git checked out', () => {
    const text = readFileSync(CONDITION_PATH, 'utf8');
    const crlf = text.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10));
    expect(profileHash(crlf)).toBe(profileHash(text));
  });
});

// ------------------------------------------------------------------------------------------------
// THE PROFILE-TO-FIXTURE CONTRACT.
//
// Most screens these detectors match arrive in PHASE 6. Two exist TODAY, and they are tested here
// against real captures, so at least part of the contract is proven honoured BEFORE the hashes are
// pinned into anything. The rest are recorded verbatim in fixtures/legacy-app/README.md, and
// PHASE 6 has to make the fixture match them rather than the other way round.
// ------------------------------------------------------------------------------------------------
describe('detectors that the fixture already satisfies', () => {
  it('[MUST] MEMBER_NOT_FOUND matches the text the fixture really renders for member 99999', () => {
    const observation = loadObservation('search-no-results');

    // The exact text on the screen, captured from a real run.
    const rendered = observation.controls.find((control) =>
      control.name.startsWith('No member found'),
    );
    expect(rendered?.name).toBe('No member found for that ID.');

    const outcome = condition.profile.knownOutcomes.find(
      (entry) => entry.outcome === 'MEMBER_NOT_FOUND',
    );
    expect(outcome).toBeDefined();
    if (outcome === undefined) return;

    expect(detectMatches(outcome.detect, observation)).toBe(true);

    const found = detectCondition(observation, effectiveDetectors(condition.profile));
    expect(found?.kind).toBe('known_outcome');
  });

  it('does not fire MEMBER_NOT_FOUND on a search that found somebody', () => {
    const found = detectCondition(
      loadObservation('search-results'),
      effectiveDetectors(condition.profile),
    );
    expect(found).toBeNull();
  });

  it('[MUST] APPLICATION_VALIDATION_REJECTED matches the alert region the fixture really renders', () => {
    const observation = loadObservation('subaccount-form-rejected');

    const alert = observation.controls.find((control) => control.role === 'alert');
    expect(alert?.name).toBe('You must select an account type.');

    const found = detectCondition(observation, effectiveDetectors(condition.profile));
    expect(found?.kind).toBe('hard_failure');
    if (found?.kind !== 'hard_failure') return;
    expect(found.failure.code).toBe('APPLICATION_VALIDATION_REJECTED');
  });

  it('finds no condition at all on the ordinary screens of the happy path', () => {
    for (const screen of ['search', 'member', 'subaccount-new', 'subaccount-review'] as const) {
      expect(
        detectCondition(loadObservation(screen), effectiveDetectors(condition.profile)),
      ).toBeNull();
    }
  });
});

describe('the safety profile', () => {
  it('[MUST] refuses at least everything the PHASE 2 bootstrap minimum refuses', () => {
    // PHASE 7 replaces the hardcoded minimum with an engine driven by this profile. If the profile
    // were narrower, that replacement would ship a WEAKER guardrail than PHASE 2 already had, and
    // nothing else in the build would notice.
    const namesTheMinimumRefuses = [
      'Submit Request',
      'Delete Member',
      'Remove Beneficiary',
      'Close Account',
      'Transfer Funds',
      'Wire Payment',
      'Approve Request',
      'Authorize Payment',
      'Post Transaction',
    ];

    for (const name of namesTheMinimumRefuses) {
      const bootstrapRefuses = IRREVERSIBLE_NAME_PATTERNS.some((pattern) => pattern.test(name));
      expect(bootstrapRefuses).toBe(true);
      expect(isIrreversibleControl(name, safety.profile)).not.toBeNull();
    }
  });

  it('leaves ordinary controls alone', () => {
    for (const name of ['Search', 'Continue', 'Open', 'Back', 'New Sub-Account']) {
      expect(isIrreversibleControl(name, safety.profile)).toBeNull();
    }
  });

  it('matches whole words, so "Undeleted items" is not a delete', () => {
    expect(phraseMatches('Delete Member', 'delete')).toBe(true);
    expect(phraseMatches('Undeleted items', 'delete')).toBe(false);
    expect(phraseMatches('Submit Request', 'submit request')).toBe(true);
    expect(phraseMatches('Request Submitted', 'submit request')).toBe(false);
  });

  it('[MUST] denies Continue on a review screen and allows it on a form', () => {
    // The rule pure name matching cannot express. Same control name, opposite meaning.
    expect(
      contextualDenyReason('Review Sub-Account Request', 'Continue', safety.profile),
    ).not.toBeNull();
    expect(contextualDenyReason('New Sub-Account', 'Continue', safety.profile)).toBeNull();
  });

  it('classifies risk, and assumes the worst about controls nobody described', () => {
    expect(classifyControlRisk('Submit Request', safety.profile)).toBe('IRREVERSIBLE');
    expect(classifyControlRisk('Search', safety.profile)).toBe('SAFE_REVERSIBLE');
    expect(classifyControlRisk('Continue', safety.profile)).toBe('RISKY_REVERSIBLE');
    // Never seen before. Assumed to change something.
    expect(classifyControlRisk('Reticulate Splines', safety.profile)).toBe('RISKY_REVERSIBLE');
    expect(safety.profile.defaultRisk).toBe('RISKY_REVERSIBLE');
  });
});

describe('detector layering', () => {
  it('[MUST] always includes the global engine detectors', () => {
    const effective = effectiveDetectors(condition.profile);
    expect(effective.system).toEqual(GLOBAL_DETECTORS);

    const codes = effective.system.map((detector) => detector.code);
    for (const required of [
      'ALLOWLIST_VIOLATION',
      'LEASE_VIOLATION',
      'SURFACE_UNAVAILABLE',
      'POLICY_BLOCKED',
      'SESSION_EXPIRED',
    ]) {
      expect(codes).toContain(required);
    }
  });

  it('adds capability-specific detectors on top of the profile, never instead of it', () => {
    const effective = effectiveDetectors(condition.profile, {
      hardFailures: [
        {
          id: 'capability.custom',
          code: 'PRECONDITION_FAILED',
          description: 'a capability-specific condition',
          detect: { kind: 'text', phrase: 'something specific' },
        },
      ],
    });

    expect(effective.hardFailures).toHaveLength(condition.profile.hardFailures.length + 1);
    expect(effective.hardFailures.map((failure) => failure.id)).toContain('permission-denied');
  });

  it('[MUST] returns the OUTCOME, not the recovery, when a screen carries both', () => {
    // A recovery is an ACTION. Terminal states are evaluated first precisely so that we never act
    // on a run that is already decided: dismissing the notice and retrying would spend an action,
    // and possibly change state, on a question the application had already answered.
    const observation = loadObservation('search-no-results');
    const withNotice = {
      ...observation,
      controls: [
        ...observation.controls,
        {
          markId: 998,
          role: 'text' as const,
          name: 'Scheduled maintenance begins at 22:00.',
          enabled: true,
          contextPath: ['contentFrame'],
          nearbyText: [],
          stableAttributes: {},
          box: { x: 0, y: 0, width: 0, height: 0 },
          containers: [],
        },
      ],
    };

    // Both detectors match this screen.
    const detectors = effectiveDetectors(condition.profile);
    expect(
      detectMatches(detectors.recoveries[0]?.detect ?? { kind: 'text', phrase: 'x' }, withNotice),
    ).toBe(true);
    expect(
      detectMatches(
        detectors.knownOutcomes[0]?.detect ?? { kind: 'text', phrase: 'x' },
        withNotice,
      ),
    ).toBe(true);

    const found = detectCondition(withNotice, detectors);
    expect(found?.kind).toBe('known_outcome');
  });

  it('[MUST] a raised global-safety condition outranks anything on the screen', () => {
    // If a guardrail stopped us, that is the answer, whatever the page happens to say.
    const found = detectCondition(
      loadObservation('search-no-results'),
      effectiveDetectors(condition.profile),
      {
        systemRaised: {
          detectorId: 'global.blocked-irreversible-action',
          reason: 'refusing to click "Submit Request"',
        },
      },
    );

    expect(found?.kind).toBe('system');
    if (found?.kind !== 'system') return;
    expect(found.detector.code).toBe('POLICY_BLOCKED');
  });

  it('falls through to needs_human when nothing explains where we are', () => {
    const found = detectCondition(
      loadObservation('member'),
      effectiveDetectors(condition.profile),
      {
        screenRecognised: false,
      },
    );
    expect(found?.kind).toBe('needs_human');
  });

  it('[MUST] reports a permission problem rather than a stale business outcome', () => {
    // Ordering matters. A screen that shows both a denial and a leftover "No member found" is a
    // permission problem; calling it MEMBER_NOT_FOUND would tell a caller the member does not
    // exist when the truth is that we were not allowed to look.
    const observation = loadObservation('search-no-results');
    const withDenial = {
      ...observation,
      controls: [
        ...observation.controls,
        {
          markId: 999,
          role: 'text' as const,
          name: 'You do not have permission to view this member.',
          enabled: true,
          contextPath: ['contentFrame'],
          nearbyText: [],
          stableAttributes: {},
          box: { x: 0, y: 0, width: 0, height: 0 },
          containers: [],
        },
      ],
    };

    const found = detectCondition(withDenial, effectiveDetectors(condition.profile));
    expect(found?.kind).toBe('hard_failure');
    if (found?.kind !== 'hard_failure') return;
    expect(found.failure.code).toBe('PERMISSION_DENIED');
  });
});
