import { describe, expect, it } from 'vitest';
import { verifyCompletion } from '../../src/agent/completion.js';
import { buildDescriptor } from '../../src/agent/descriptors.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { loadDiscoverySpec } from '../../src/config/spec.js';
import { fileURLToPath } from 'node:url';
import type { Observation, PerceivedControl } from '../../src/types/perception.js';
import type { OutputBinding, RecordIdentityBinding } from '../../src/types/discovery.js';
import { loadObservation } from '../helpers/observations.js';

/**
 * ================================================================================================
 * THE RECORD IDENTITY IS CHECKED ON A SCREEN THE MODEL WAS NOT LOOKING AT WHEN IT BOUND IT.
 * ================================================================================================
 *
 * This is the GATE 3 discovery failure, reproduced from recorded observations with no browser and
 * no model. The run did everything right and was refused:
 *
 *   turn 7   bound the identity to the Member Record "Member ID" cell   - resolves on review
 *   turn 10  REBOUND it to "Member Name: Avery Lin (10001)" on the form - does NOT resolve on review
 *   turn 25  proposed completion; the check re-resolved the LAST binding against the review screen
 *            and reported "the record identity is not visible on the current screen"
 *
 * The identity was on the review screen the whole time, in the cell the model had designated first.
 *
 * WHY "REFUSE A REPLACEMENT THAT DOES NOT RESOLVE WHERE THE FIRST ONE DID" WOULD NOT HAVE HELPED,
 * and the reason the choice is deferred to completion instead: the first binding does not resolve
 * on the form screen either. The two are asserted below, because the alternative design is the
 * obvious one and this is the evidence against it.
 */

const SPEC = loadDiscoverySpec(
  fileURLToPath(new URL('../../config/specs/prepare_subaccount_review.yaml', import.meta.url)),
).spec;

const INPUTS = {
  memberId: '10001',
  accountType: 'Savings',
  nickname: 'Holiday Fund',
  initialDeposit: '250.00',
};

const resolver = new DefaultTargetResolver();

function descriptorFor(control: PerceivedControl, observation: Observation) {
  const built = buildDescriptor(control, {
    observation,
    resolver,
    runtimeValues: Object.values(INPUTS),
    runtimeInputs: INPUTS,
  });
  if ('error' in built) throw new Error(built.error);
  return built.descriptor;
}

function identityOn(screen: 'member' | 'subaccount-new'): RecordIdentityBinding {
  const observation = loadObservation(screen);
  const control =
    screen === 'member'
      ? observation.controls.find(
          (candidate) => candidate.role === 'cell' && candidate.nearbyText.includes('Member ID'),
        )
      : observation.controls.find(
          (candidate) => candidate.role === 'text' && candidate.name.startsWith('Member Name:'),
        );
  if (control === undefined) throw new Error('fixture is missing the control for ' + screen);

  return {
    param: 'memberId',
    observationId: observation.observationId,
    screenName: observation.screenIdentity.canonicalScreenName,
    target: descriptorFor(control, observation),
    observedValue: '10001',
  };
}

/** The three declared outputs, bound off the review screen the way a run binds them. */
function outputsOnReview(): OutputBinding[] {
  const review = loadObservation('subaccount-review');
  const byLabel = (label: string): PerceivedControl => {
    const found = review.controls.find(
      (candidate) => candidate.role === 'cell' && candidate.nearbyText.includes(label),
    );
    if (found === undefined) throw new Error('no cell near "' + label + '" in the review fixture');
    return found;
  };

  const bind = (label: string, name: string, observedValue: string): OutputBinding => ({
    name,
    observationId: review.observationId,
    target: descriptorFor(byLabel(label), review),
    parseAs: 'text',
    observedValue,
  });

  return [
    bind('Member Name', 'memberName', 'Avery Lin'),
    bind('Account Type', 'accountType', 'Savings'),
    bind('Status', 'reviewStatus', 'PENDING REVIEW'),
  ];
}

function verifyOnReview(candidates: readonly RecordIdentityBinding[]) {
  return verifyCompletion({
    fresh: loadObservation('subaccount-review'),
    spec: SPEC,
    outputs: outputsOnReview(),
    recordIdentityCandidates: candidates,
    runtimeInputs: INPUTS,
    resolver,
  });
}

describe('the record identity, chosen at completion rather than at bind time', () => {
  it('the evidence against the alternative design: neither binding resolves on the other screen', () => {
    // The rule "reject a replacement that does not resolve where the first one did" would have
    // accepted the replacement, because the first one does not resolve on the form screen. Which
    // screen a binding is checked on is not knowable when it is made.
    const first = identityOn('member');
    const second = identityOn('subaccount-new');
    const form = loadObservation('subaccount-new');
    const review = loadObservation('subaccount-review');

    expect(resolver.resolve(form, first.target).ok, 'first binding on the form screen').toBe(false);
    expect(resolver.resolve(review, first.target).ok, 'first binding on review').toBe(true);
    expect(resolver.resolve(form, second.target).ok, 'second binding on the form').toBe(true);
    expect(resolver.resolve(review, second.target).ok, 'second binding on review').toBe(false);
  });

  it('[MUST] verifies when an EARLIER candidate is the one that resolves on the success screen', () => {
    // The exact GATE 3 sequence. Under last-write-wins this was a refusal.
    const verdict = verifyOnReview([identityOn('member'), identityOn('subaccount-new')]);

    expect(verdict.reasons.map((reason) => reason.code)).toEqual([]);
    expect(verdict.verified).toBe(true);
    // And the binding it kept is the one that works HERE, so the artifact carries that one.
    expect(verdict.recordIdentity?.screenName).toBe('Member Record');
    expect(verdict.recordIdentity?.target.semantic.role).toBe('cell');
  });

  it('order does not matter: the choice is made on evidence, not on recency', () => {
    const verdict = verifyOnReview([identityOn('subaccount-new'), identityOn('member')]);
    expect(verdict.verified).toBe(true);
    expect(verdict.recordIdentity?.screenName).toBe('Member Record');
  });

  it('[MUST] reports a binding that resolves NOWHERE as STALE, naming the screen it came from', () => {
    // "not visible on the current screen" reads as the identity being missing. It was on screen the
    // whole time, in a control the model had not designated - so the message has to say which
    // screen the binding came from and tell the model to bind again here.
    const verdict = verifyOnReview([identityOn('subaccount-new')]);

    expect(verdict.verified).toBe(false);
    const identity = verdict.reasons.find((reason) => reason.code.startsWith('IDENTITY_'));
    expect(identity?.code).toBe('IDENTITY_STALE');
    expect(identity?.message).toContain('STALE, not missing');
    expect(identity?.message).toContain('New Sub-Account');
    expect(identity?.message).toContain('Review Sub-Account Request');
    expect(identity?.message).not.toContain('not visible');
  });

  it('an unbound identity is still its own reason, distinct from a stale one', () => {
    const verdict = verifyOnReview([]);
    expect(verdict.reasons.map((reason) => reason.code)).toContain('IDENTITY_NOT_BOUND');
    expect(verdict.recordIdentity).toBeNull();
  });

  it('[MUST] the WRONG RECORD is still a hard refusal, and says what each control showed', () => {
    // The check this whole mechanism exists for. Nothing above may weaken it: a run that did
    // everything correctly on the wrong member is the failure mode with real consequences.
    const verdict = verifyCompletion({
      fresh: loadObservation('subaccount-review'),
      spec: SPEC,
      outputs: outputsOnReview(),
      recordIdentityCandidates: [identityOn('member')],
      runtimeInputs: { ...INPUTS, memberId: '19999' },
      resolver,
    });

    expect(verdict.verified).toBe(false);
    const identity = verdict.reasons.find((reason) => reason.code.startsWith('IDENTITY_'));
    expect(identity?.code).toBe('IDENTITY_MISMATCH');
    expect(identity?.message).toContain('NOT THE RECORD THAT WAS REQUESTED');
    expect(identity?.message).toContain('19999');
    expect(identity?.message).toContain('10001');
    expect(verdict.recordIdentity).toBeNull();
  });

  it('a control that displays the id inside a sentence still MATCHES, by typed comparison', () => {
    // ==========================================================================================
    // WORTH PINNING, BECAUSE I EXPECTED THE OPPOSITE.
    // ==========================================================================================
    //
    // "Member Name: Avery Lin (10001)" is not the string "10001", and I assumed a loose binding
    // like this would have to be tolerated as a special case. It does not: `memberId` is declared
    // `string` with pattern ^[0-9]{5}$, and a digits-only pattern makes the typed comparison strip
    // non-digits and then re-check the pattern. So the sentence normalizes to "10001" and matches.
    //
    // The re-check is what keeps it safe rather than merely permissive: "100011" strips to six
    // digits, fails the declared pattern, and is compared as its original text - so a longer id
    // that happens to contain this one does NOT match. Both halves are asserted here.
    const form = loadObservation('subaccount-new');

    const verdict = verifyCompletion({
      fresh: form,
      spec: SPEC,
      outputs: [],
      recordIdentityCandidates: [identityOn('subaccount-new')],
      runtimeInputs: INPUTS,
      resolver,
    });
    // `verified` is false here only because this call supplies no outputs; the identity is what is
    // under test, so the assertion is on the identity reasons rather than the verdict.
    expect(verdict.reasons.filter((reason) => reason.code.startsWith('IDENTITY_'))).toEqual([]);
    expect(verdict.recordIdentity?.screenName).toBe('New Sub-Account');

    // The negative control: a different member id is not matched by the same sentence.
    const wrong = verifyCompletion({
      fresh: form,
      spec: SPEC,
      outputs: [],
      recordIdentityCandidates: [identityOn('subaccount-new')],
      runtimeInputs: { ...INPUTS, memberId: '10002' },
      resolver,
    });
    expect(wrong.reasons.find((reason) => reason.code.startsWith('IDENTITY_'))?.code).toBe(
      'IDENTITY_MISMATCH',
    );
  });
});
