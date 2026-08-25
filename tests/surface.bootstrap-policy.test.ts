import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_ALLOWED_ACTIONS,
  bootstrapResolvedCheck,
  bootstrapStaticCheck,
  IRREVERSIBLE_NAME_PATTERNS,
  navigationTarget,
} from '../src/surface/bootstrap-policy.js';
import type { SurfaceAction } from '../src/types/action.js';
import type { TargetDescriptor } from '../src/types/control.js';
import { loadObservation } from './helpers/observations.js';

const ORIGIN = 'http://127.0.0.1:4180';

const target: TargetDescriptor = {
  semantic: { role: 'button', name: 'Submit Request', nameMatch: 'exact' },
  recordedTier: 'T1_EXACT_ROLE_NAME',
};

const navigate = (segments: string[]): SurfaceAction => ({
  type: 'navigate',
  pathSegments: segments.map((value) => ({ kind: 'literal', value })),
});

describe('the bootstrap safety minimum', () => {
  it('allows exactly the five action types and nothing else', () => {
    expect([...BOOTSTRAP_ALLOWED_ACTIONS].sort()).toEqual([
      'click',
      'navigate',
      'read',
      'select',
      'type',
    ]);
  });

  it('allows navigation inside the configured fixture origin', () => {
    expect(bootstrapStaticCheck(navigate(['member', '10001']), ORIGIN).allowed).toBe(true);
  });

  it('[MUST] blocks navigation to any other origin', () => {
    const decision = bootstrapStaticCheck(navigate(['http://evil.example.com/steal']), ORIGIN);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.error).toBe('ALLOWLIST_VIOLATION');
    expect(decision.reason).toContain('evil.example.com');
  });

  it('catches an absolute URL smuggled in as a path segment', () => {
    // This is why the target is RESOLVED against the origin rather than pattern-matched: joining
    // an absolute URL re-bases the result, and the origin comparison then sees it.
    const target = navigationTarget(
      [{ kind: 'literal', value: 'https://attacker.test/callback' }],
      ORIGIN,
    );
    expect(target?.origin).toBe('https://attacker.test');
    expect(bootstrapStaticCheck(navigate(['https://attacker.test/callback']), ORIGIN).allowed).toBe(
      false,
    );
  });

  it('[MUST] blocks a click on the resolved "Submit Request" button', () => {
    const review = loadObservation('subaccount-review');
    const submit = review.controls.find((control) => control.name === 'Submit Request');
    expect(submit).toBeDefined();
    if (submit === undefined) return;

    const decision = bootstrapResolvedCheck({ type: 'click', target }, submit);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.error).toBe('POLICY_BLOCKED');
    expect(decision.reason).toContain('Submit Request');
  });

  it('blocks every action type on an irreversible control, including read', () => {
    const review = loadObservation('subaccount-review');
    const submit = review.controls.find((control) => control.name === 'Submit Request');
    if (submit === undefined) throw new Error('fixture capture no longer has a Submit Request');

    // "We allow SOME interactions with the irreversible control" is a sentence that invites
    // exceptions. The minimum stays boring on purpose.
    for (const action of [
      { type: 'click', target },
      { type: 'read', target },
      { type: 'type', target, value: { kind: 'literal', value: 'x' } },
    ] as SurfaceAction[]) {
      expect(bootstrapResolvedCheck(action, submit).allowed).toBe(false);
    }
  });

  it('allows a click on an ordinary control on the same screen', () => {
    const review = loadObservation('subaccount-review');
    const back = review.controls.find((control) => control.name === 'Back');
    expect(back).toBeDefined();
    if (back === undefined) return;
    expect(bootstrapResolvedCheck({ type: 'click', target }, back).allowed).toBe(true);
  });

  it('is broader than this one fixture button', () => {
    // A minimum that only blocks the exact button in the demo is a demo, not a minimum.
    const dangerous = ['Delete Member', 'Wire Funds', 'Approve Request', 'Close Account'];
    for (const name of dangerous) {
      expect(IRREVERSIBLE_NAME_PATTERNS.some((pattern) => pattern.test(name))).toBe(true);
    }
    for (const safe of ['Search', 'Continue', 'Member Search', 'Open', 'Back']) {
      expect(IRREVERSIBLE_NAME_PATTERNS.some((pattern) => pattern.test(safe))).toBe(false);
    }
  });
});
