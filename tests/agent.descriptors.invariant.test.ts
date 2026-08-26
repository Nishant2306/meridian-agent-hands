import { describe, expect, it } from 'vitest';
import { buildDescriptor, DescriptorSynthesisError } from '../src/agent/descriptors.js';
import { bindDescriptor } from '../src/perception/bind.js';
import { DefaultTargetResolver } from '../src/perception/resolver.js';
import { loadObservation, type SavedScreen } from './helpers/observations.js';
import type { Observation, PerceivedControl } from '../src/types/perception.js';
import type { TargetDescriptor } from '../src/types/control.js';

/**
 * ================================================================================================
 * [MUST] A DESCRIPTOR SYNTHESIZED FROM A PERCEIVED CONTROL RESOLVES BACK TO THAT CONTROL.
 * ================================================================================================
 *
 * Exhaustive and browser-free: every recorded observation, every perceived control on it. The
 * recorded observations are real captures written verbatim by `npm run inventory`, and the
 * resolver is pure, so a saved observation is a complete input to this.
 *
 * HONESTY ABOUT WHAT THIS TEST CATCHES. It would NOT have caught the GATE 1 failure. There the
 * descriptor synthesized for the member-name paragraph DID resolve back to its own control, in
 * this exact way - the break was one layer lower, where the resolved control is turned into a
 * Playwright locator. This file pins the resolver-level invariant; the addressing-level invariant
 * that actually failed is pinned by `tests/perception.addressing.live.test.ts`, which needs a
 * browser because a locator is only real against a live page.
 *
 * Both are worth having. This one is exhaustive and runs in milliseconds.
 */

const SCREENS: readonly SavedScreen[] = [
  'search',
  'search-results',
  'search-no-results',
  'member',
  'subaccount-new',
  'subaccount-form-rejected',
  'subaccount-review',
];

/** The values a discovery run would have in hand on these screens. */
const RUNTIME_INPUTS = {
  memberId: '10001',
  accountType: 'Savings',
  nickname: 'Vacation',
  initialDeposit: '250.00',
};
const RUNTIME_VALUES = Object.values(RUNTIME_INPUTS);

function context(observation: Observation): Parameters<typeof buildDescriptor>[1] {
  return {
    observation,
    resolver: new DefaultTargetResolver(),
    runtimeValues: RUNTIME_VALUES,
    runtimeInputs: RUNTIME_INPUTS,
  };
}

const ACTIONABLE: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
]);

/** A control synthesis can actually describe, so the liar resolver below has something to lie about. */
function firstDescribable(observation: Observation): PerceivedControl {
  const found = observation.controls.find(
    (control) => !('error' in buildDescriptor(control, context(observation))),
  );
  if (found === undefined) throw new Error('no describable control on this observation');
  return found;
}

function descriptorOf(built: ReturnType<typeof buildDescriptor>): TargetDescriptor {
  if ('error' in built) throw new Error('expected a descriptor, got: ' + built.error);
  return built.descriptor;
}

function describeControl(control: PerceivedControl): string {
  return 'mark ' + control.markId + ' ' + control.role + ' "' + control.name + '"';
}

describe.each(SCREENS)('descriptor synthesis on %s', (screen) => {
  const observation = loadObservation(screen);

  it('produces a descriptor that resolves back to its own control, for every control', () => {
    const resolver = new DefaultTargetResolver();
    const undescribable: string[] = [];
    let checked = 0;

    for (const control of observation.controls) {
      const built = buildDescriptor(control, context(observation));

      if ('error' in built) {
        // A legitimate outcome: some nodes carry no identifying evidence at all. It must be
        // REPORTED rather than counted as a pass, which is what the next test does.
        undescribable.push(describeControl(control));
        continue;
      }

      const resolution = resolver.resolve(
        observation,
        bindDescriptor(built.descriptor, RUNTIME_INPUTS),
      );

      expect(resolution.ok, describeControl(control) + ' -> ' + built.rationale).toBe(true);
      expect(resolution.ok && resolution.control.markId, describeControl(control)).toBe(
        control.markId,
      );
      checked += 1;
    }

    expect(checked).toBeGreaterThan(0);
  });

  it('describes every actionable control, unless refusing is the correct answer', () => {
    // A button, link or field the model may be asked to act on should be describable. The ONE
    // legitimate refusal is an actionable control that shares its role and name with a sibling and
    // has no row cell corresponding to an invocation parameter: on the four-row search results,
    // three of the four links named "Open" are exactly that. There is no descriptor for "the third
    // Open" that is not ordinal, and an ordinal descriptor is one row-order change away from
    // operating on the wrong member's record. Refusing is the design working.
    const actionable = observation.controls.filter((control) => ACTIONABLE.has(control.role));

    for (const control of actionable) {
      if (!('error' in buildDescriptor(control, context(observation)))) continue;

      const namesakes = observation.controls.filter(
        (other) => other.role === control.role && other.name === control.name,
      );
      const hasParameterizedRow = (control.rowCellTexts ?? []).some((cell) =>
        RUNTIME_VALUES.some((value) => cell.trim() === value),
      );

      expect(
        namesakes.length,
        describeControl(control) + ' is undescribable but unique',
      ).toBeGreaterThan(1);
      expect(
        hasParameterizedRow,
        describeControl(control) + ' has a parameterizable row and should be describable',
      ).toBe(false);
    }
  });

  it('describes the one Open link the invocation actually names', () => {
    // The other side of the rule above. The row for the member we were asked about IS describable,
    // and it is described by the PARAMETER, not by this member's id.
    const openLinks = observation.controls.filter(
      (control) => control.role === 'link' && control.name === 'Open',
    );
    if (openLinks.length === 0) return;

    const described = openLinks
      .map((control) => buildDescriptor(control, context(observation)))
      .filter((built) => !('error' in built));

    expect(described).toHaveLength(1);
    const json = JSON.stringify(described[0]);
    expect(json).toContain('memberId');
    expect(json).not.toContain('10001');
  });
});

describe('the invariant is enforced inside synthesis, not just observed by tests', () => {
  it('throws DescriptorSynthesisError rather than returning an unresolvable descriptor', () => {
    const observation = loadObservation('subaccount-new');
    const control = firstDescribable(observation);

    // A resolver that is honest while an attempt is being VALIDATED and then returns the wrong
    // control on the final check. That is the exact shape of the regression this guards: an
    // attempt passes validation, and the descriptor that is actually returned does not hold.
    // A resolver that lied on every call would simply make every attempt fail validation, and
    // synthesis would return an ordinary error without ever reaching the invariant.
    const honest = new DefaultTargetResolver();
    let oks = 0;
    const liar = {
      resolve: (obs: Observation, descriptor: never) => {
        const real = honest.resolve(obs, descriptor);
        if (!real.ok) return real;
        oks += 1;
        // Calls 1 and 2 are attempt validation and the tier read; call 3 is the invariant.
        if (oks < 3) return real;
        return { ...real, control: { ...real.control, markId: 9999 } };
      },
    };

    expect(() =>
      buildDescriptor(control, {
        observation,
        resolver: liar as never,
        runtimeValues: RUNTIME_VALUES,
        runtimeInputs: RUNTIME_INPUTS,
      }),
    ).toThrow(DescriptorSynthesisError);
  });

  it('names both the control and the descriptor in the message', () => {
    const observation = loadObservation('subaccount-new');
    const control = firstDescribable(observation);

    const honest = new DefaultTargetResolver();
    let oks = 0;
    const liar = {
      resolve: (obs: Observation, descriptor: never) => {
        const real = honest.resolve(obs, descriptor);
        if (!real.ok) return real;
        oks += 1;
        if (oks < 3) return real;
        return {
          ok: false as const,
          error: 'CONTROL_NOT_FOUND' as const,
          detail: 'nothing matched',
          trace: real.trace,
        };
      },
    };

    try {
      buildDescriptor(control, {
        observation,
        resolver: liar as never,
        runtimeValues: RUNTIME_VALUES,
        runtimeInputs: RUNTIME_INPUTS,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      // A synthesis bug is a bug in this code. The message has to carry enough to fix it without
      // re-running discovery, because re-running discovery costs a model call.
      expect(error).toBeInstanceOf(DescriptorSynthesisError);
      const message = (error as Error).message;
      expect(message).toContain('SYNTHESIS BUG');
      expect(message).toContain('"' + control.name + '"');
      expect(message).toContain('control:');
      expect(message).toContain('descriptor:');
    }
  });
});

describe('the member-name paragraph, which is the control GATE 1 failed on', () => {
  const observation = loadObservation('subaccount-new');
  const paragraph = observation.controls.find(
    (control) => control.role === 'text' && control.name.startsWith('Member Name'),
  );

  it('is present in the recorded capture', () => {
    expect(paragraph).toBeDefined();
  });

  it('synthesizes a descriptor that resolves back to it', () => {
    const built = buildDescriptor(paragraph as PerceivedControl, context(observation));
    expect('error' in built).toBe(false);

    const resolution = new DefaultTargetResolver().resolve(
      observation,
      bindDescriptor(descriptorOf(built), RUNTIME_INPUTS),
    );
    // It always did. That is why this level of testing could not have caught the defect, and why
    // the addressing-level test exists alongside it.
    expect(resolution.ok && resolution.control.markId).toBe((paragraph as PerceivedControl).markId);
  });

  it('does not carry the member id or name into the descriptor', () => {
    const built = buildDescriptor(paragraph as PerceivedControl, context(observation));
    const json = JSON.stringify(descriptorOf(built));

    // The node's own text is "Member Name: Avery Lin (10001)". A descriptor identifying it BY that
    // text would bake a member into the capability.
    expect(json).not.toContain('10001');
    expect(json).not.toContain('Avery Lin');
  });
});
