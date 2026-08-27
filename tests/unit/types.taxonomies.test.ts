import { describe, expect, it } from 'vitest';
import {
  BusinessOutcomeCodeSchema,
  ErrorCodeSchema,
  ProposalRejectionCodeSchema,
} from '../../src/types/outcomes.js';
import { ArtifactActionSchema } from '../../src/types/proposal.js';
import { assertionApplies, type Assertion } from '../../src/types/assertion.js';
import type { TargetDescriptor } from '../../src/types/control.js';

const someTarget: TargetDescriptor = {
  semantic: { role: 'button', name: 'Continue', nameMatch: 'exact' },
  recordedTier: 'T1_EXACT_ROLE_NAME',
};

describe('the two taxonomies stay separate', () => {
  it('has no RECORD_NOT_FOUND error - a missing record is a business outcome', () => {
    expect(ErrorCodeSchema.options).not.toContain('RECORD_NOT_FOUND');
    expect(BusinessOutcomeCodeSchema.options).toContain('MEMBER_NOT_FOUND');
  });

  it('shares no code between business outcomes and errors', () => {
    const errors = new Set<string>(ErrorCodeSchema.options);
    for (const outcome of BusinessOutcomeCodeSchema.options) {
      expect(errors.has(outcome)).toBe(false);
    }
  });

  it('keeps proposal rejections out of the error taxonomy', () => {
    // A stale proposal sends feedback to the model and the loop CONTINUES. It is not a run failure,
    // and it must never be counted as one.
    expect(ProposalRejectionCodeSchema.options).toContain('STALE_OBSERVATION_CONTEXT');
    expect(ErrorCodeSchema.options).not.toContain('STALE_OBSERVATION_CONTEXT');
  });

  it("distinguishes our validation from the application's", () => {
    expect(ErrorCodeSchema.options).toContain('INPUT_VALIDATION_FAILED');
    expect(ErrorCodeSchema.options).toContain('APPLICATION_VALIDATION_REJECTED');
  });

  it('distinguishes a bad application response from a dead surface', () => {
    expect(ErrorCodeSchema.options).toContain('APPLICATION_UNAVAILABLE');
    expect(ErrorCodeSchema.options).toContain('SURFACE_UNAVAILABLE');
  });
});

describe('an ArtifactAction cannot carry a mark', () => {
  it('drops a markId that someone tries to smuggle through', () => {
    const parsed = ArtifactActionSchema.parse({
      type: 'click',
      target: someTarget,
      markId: 7,
      observationId: 'obs-1',
    });

    expect(parsed).not.toHaveProperty('markId');
    expect(parsed).not.toHaveProperty('observationId');
  });
});

describe('conditional assertions', () => {
  const nicknameAssertion: Assertion = {
    id: 'nickname-echoed',
    kind: 'value_matches_param',
    target: someTarget,
    expected: { kind: 'param', name: 'nickname' },
    description: 'the review screen shows the nickname that was supplied',
    when: { paramPresent: 'nickname' },
  };

  it('fires when the optional param was supplied', () => {
    expect(assertionApplies(nicknameAssertion, new Set(['memberId', 'nickname']))).toBe(true);
  });

  it('does not fire when the optional param was omitted', () => {
    // Without the guard, every legitimate no-nickname invocation would report INVARIANT_VIOLATED.
    expect(assertionApplies(nicknameAssertion, new Set(['memberId']))).toBe(false);
  });

  it('always fires when unguarded', () => {
    const unguarded: Assertion = {
      id: 'on-review-screen',
      kind: 'screen_identity',
      description: 'we are on the review screen',
    };
    expect(assertionApplies(unguarded, new Set())).toBe(true);
  });
});
