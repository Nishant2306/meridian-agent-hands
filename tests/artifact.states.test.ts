import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AssertionEvaluator } from '../src/artifact/assertions.js';
import { CapabilityArtifactSchema, type CapabilityArtifact } from '../src/artifact/schema.js';
import {
  checkResumeEligibleExclusivity,
  checkStepDiscrimination,
  matchState,
  validateArtifactStructure,
} from '../src/artifact/validate.js';
import { DefaultTargetResolver } from '../src/perception/resolver.js';
import { loadObservation, type SavedScreen } from './helpers/observations.js';

const EXAMPLE_PATH = fileURLToPath(
  new URL('../examples/artifacts/prepare_subaccount_review@1.0.0.example.json', import.meta.url),
);

export function loadExample(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')));
}

const evaluator = new AssertionEvaluator(new DefaultTargetResolver());
const artifact = loadExample();

/** The values the recorded discovery walk actually used. */
const PARAMS = {
  memberId: '10001',
  accountType: 'Savings',
  nickname: 'Vacation',
  initialDeposit: '250.00',
};

const ALL_SCREENS: SavedScreen[] = [
  'search',
  'search-results',
  'search-no-results',
  'member',
  'subaccount-new',
  'subaccount-form-rejected',
  'subaccount-review',
];

describe('the example artifact', () => {
  it('validates against the schema and the structural rules', () => {
    expect(validateArtifactStructure(artifact)).toEqual([]);
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.capabilityVersion).toBe('1.0.0');
    expect(artifact.status).toBe('draft');
  });

  it('says plainly that it was not produced by a discovery run', () => {
    // Hard Rule 3. This artifact is documentation, and its provenance must never be mistakable for
    // the output of a real model run.
    expect(artifact.provenance.discoveryRunId).toContain('HAND-AUTHORED');
    expect(artifact.provenance.model).toContain('NO-MODEL-WAS-CALLED');
  });

  it('carries no rendered goal and no goalDigest', () => {
    // A SHA of "...member 10001..." is a member id in a costume: a hundred thousand five-digit ids
    // against a known template is seconds of work.
    expect(artifact.provenance.goalTemplate).toContain('{{memberId}}');
    expect(artifact.provenance.goalTemplate).not.toContain('10001');
    expect(artifact.provenance).not.toHaveProperty('goalDigest');
    expect(artifact.provenance).not.toHaveProperty('goal');
  });

  it('contains no mark ids anywhere', () => {
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain('markId');
    expect(serialized).not.toContain('observationId');
  });

  it('keeps every step at or below its own policy ceiling, which excludes IRREVERSIBLE', () => {
    expect(artifact.policy.maxRiskAllowed).toBe('RISKY_REVERSIBLE');
    for (const step of artifact.steps) {
      expect(step.risk).not.toBe('IRREVERSIBLE');
    }
  });
});

describe('states, matched against the observations the walk really produced', () => {
  it('[MUST] never matches two resume-eligible states on the same screen', () => {
    const issues = checkResumeEligibleExclusivity(
      artifact,
      ALL_SCREENS.map((screen) => loadObservation(screen)),
      evaluator,
      PARAMS,
    );
    expect(issues).toEqual([]);
  });

  it('recognises the member record and the review screen', () => {
    const memberDetails = artifact.states.find((state) => state.id === 'member-details');
    const review = artifact.states.find((state) => state.id === 'review');
    if (memberDetails === undefined || review === undefined) throw new Error('states missing');

    const onMember = {
      observation: loadObservation('member'),
      params: PARAMS,
      inputs: artifact.inputs,
    };
    const onReview = {
      observation: loadObservation('subaccount-review'),
      params: PARAMS,
      inputs: artifact.inputs,
    };

    expect(matchState(memberDetails, evaluator, onMember).matched).toBe(true);
    expect(matchState(review, evaluator, onReview).matched).toBe(true);
    expect(matchState(review, evaluator, onMember).matched).toBe(false);
    expect(matchState(memberDetails, evaluator, onReview).matched).toBe(false);
  });

  it('[MUST] a half-filled form matches NO resume-eligible state', () => {
    // The correct and cheap outcome: the run goes back to a human rather than guessing which half
    // of the work was already done.
    const context = {
      observation: loadObservation('subaccount-new'),
      params: PARAMS,
      inputs: artifact.inputs,
    };

    const resumable = artifact.states.filter((state) => state.resumeEligible);
    for (const state of resumable) {
      expect(matchState(state, evaluator, context).matched).toBe(false);
    }

    // ...while the NON-resumable step-precondition state does match it. That overlap is allowed
    // precisely because nothing ever has to choose between them.
    const formState = artifact.states.find((state) => state.id === 'subaccount-form');
    if (formState === undefined) throw new Error('subaccount-form missing');
    expect(matchState(formState, evaluator, context).matched).toBe(true);
  });
});

describe('step rules, checked against real before/after observations', () => {
  const step8 = artifact.steps.find((step) => step.id === 'step-8-continue-to-review');
  if (step8 === undefined) throw new Error('step-8 missing');

  const before = loadObservation('subaccount-new');
  const after = loadObservation('subaccount-review');

  it('accepts a step whose effect is false before the action and true after it', () => {
    expect(
      checkStepDiscrimination(step8, before, after, evaluator, PARAMS, artifact.inputs),
    ).toEqual([]);
  });

  it('[MUST] rejects a mutating step whose effects were already true before it acted', () => {
    // If nothing changed, the action did nothing. A click swallowed by a modal looks exactly like
    // this, and it is the single most common way legacy UI automation reports a false success.
    const alwaysTrue = {
      ...step8,
      expectedEffects: [
        {
          id: 'always-true',
          kind: 'text_present' as const,
          expected: { kind: 'literal' as const, value: 'MERIDIAN' },
          description: 'the product name is on screen, which it always is',
        },
      ],
    };

    const issues = checkStepDiscrimination(
      alwaysTrue,
      before,
      after,
      evaluator,
      PARAMS,
      artifact.inputs,
    );
    expect(issues.map((issue) => issue.code)).toContain('NO_DISCRIMINATING_EFFECT');
  });

  it('[MUST] rejects an expected effect that is FALSE after the action', () => {
    // Requiring one DISCRIMINATING effect says the action did something. This says nothing we
    // recorded about it is false. Without it a step can carry an assertion that was never true
    // after the action, distil cleanly, and fail on the first replay - where it looks like drift
    // in the application rather than a defect in the recording.
    const wrong = {
      ...step8,
      expectedEffects: [
        ...step8.expectedEffects,
        {
          id: 'still-on-the-form',
          kind: 'screen_identity' as const,
          expected: { kind: 'literal' as const, value: 'New Sub-Account' },
          description: 'we are still on the form, which we are not',
        },
      ],
    };

    const issues = checkStepDiscrimination(
      wrong,
      before,
      after,
      evaluator,
      PARAMS,
      artifact.inputs,
    );
    expect(issues.map((issue) => issue.code)).toContain('EXPECTED_EFFECT_FALSE_AFTER_ACTION');
  });

  it('[MUST] rejects an invariant that is really an effect', () => {
    const mislabelled = {
      ...step8,
      invariants: [
        {
          id: 'mislabelled',
          kind: 'screen_identity' as const,
          expected: { kind: 'literal' as const, value: 'Review Sub-Account Request' },
          description: 'we are on the review screen, which is a transition, not an invariant',
        },
      ],
    };

    const issues = checkStepDiscrimination(
      mislabelled,
      before,
      after,
      evaluator,
      PARAMS,
      artifact.inputs,
    );
    expect(issues.map((issue) => issue.code)).toContain('INVARIANT_IS_AN_EFFECT');
  });

  it('rejects a step whose risk exceeds the capability policy', () => {
    const tooRisky: CapabilityArtifact = {
      ...artifact,
      steps: artifact.steps.map((step) =>
        step.id === step8.id ? { ...step, risk: 'IRREVERSIBLE' as const } : step,
      ),
    };
    expect(validateArtifactStructure(tooRisky).map((issue) => issue.code)).toContain(
      'STEP_EXCEEDS_POLICY_RISK',
    );
  });

  it('rejects a step that allows more retries than it declares backoffs for', () => {
    const underspecified: CapabilityArtifact = {
      ...artifact,
      steps: artifact.steps.map((step) =>
        step.id === step8.id ? { ...step, retries: { max: 3, backoffMs: [100] } } : step,
      ),
    };
    expect(validateArtifactStructure(underspecified).map((issue) => issue.code)).toContain(
      'RETRY_BACKOFF_UNDERSPECIFIED',
    );
  });

  it('rejects a success state nobody could recognise after a handoff', () => {
    const unrecognisable: CapabilityArtifact = {
      ...artifact,
      states: artifact.states.map((state) =>
        state.id === artifact.successState ? { ...state, resumeEligible: false } : state,
      ),
    };
    expect(validateArtifactStructure(unrecognisable).map((issue) => issue.code)).toContain(
      'SUCCESS_STATE_NOT_RESUME_ELIGIBLE',
    );
  });
});

describe('conditional assertions', () => {
  const nicknameQualifier = artifact.states
    .find((state) => state.id === 'subaccount-form-complete')
    ?.qualifiers.find((assertion) => assertion.when?.paramPresent === 'nickname');

  it('[MUST] is SKIPPED, not failed, when its parameter was not supplied', () => {
    expect(nicknameQualifier).toBeDefined();
    if (nicknameQualifier === undefined) return;

    const withoutNickname = { memberId: '10001', accountType: 'Savings', initialDeposit: '250.00' };
    const outcome = evaluator.evaluate(nicknameQualifier, {
      observation: loadObservation('subaccount-new'),
      params: withoutNickname,
      inputs: artifact.inputs,
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.passed).toBe(true);
    expect(outcome.detail).toContain('nickname');
  });

  it('is evaluated, and can fail, when the parameter WAS supplied', () => {
    if (nicknameQualifier === undefined) return;
    const outcome = evaluator.evaluate(nicknameQualifier, {
      observation: loadObservation('subaccount-new'),
      params: PARAMS,
      inputs: artifact.inputs,
    });

    expect(outcome.skipped).toBe(false);
    expect(outcome.passed).toBe(false);
  });
});

describe('typed comparison inside assertions', () => {
  it('[MUST] matches "250.00" against the "$250.00" the review screen rendered', () => {
    const depositQualifier = {
      id: 'deposit-check',
      kind: 'value_matches_param' as const,
      target: artifact.outputs[2]?.source.target ?? artifact.recordIdentity.target,
      expected: { kind: 'param' as const, name: 'initialDeposit' },
      description: 'compares as currency',
    };

    // Point it at the deposit cell on the review screen.
    const depositCell = {
      ...depositQualifier,
      target: {
        semantic: {
          role: 'cell' as const,
          nameMatch: 'normalized' as const,
          nearbyText: ['Initial Deposit'],
        },
        recordedTier: 'T3_EXTERNAL_LABEL_OR_NEARBY' as const,
      },
    };

    const outcome = evaluator.evaluate(depositCell, {
      observation: loadObservation('subaccount-review'),
      params: PARAMS,
      inputs: artifact.inputs,
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.detail).toContain('compared as currency');
  });
});
