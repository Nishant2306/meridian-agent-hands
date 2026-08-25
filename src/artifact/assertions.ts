import { valueMatchesParam, normalizeText, foldCase } from '../types/normalize.js';
import type { Assertion } from '../types/assertion.js';
import { assertionApplies } from '../types/assertion.js';
import type { Observation, PerceivedControl } from '../types/perception.js';
import type { TargetResolver } from '../types/surface.js';
import type { InputDefinition } from '../types/spec.js';
import { bindDescriptor } from '../perception/bind.js';

/**
 * ==============================================================================================
 * ONE ASSERTION EVALUATOR.
 * ==============================================================================================
 *
 * Used by artifact validation now (mutual exclusivity of resumable states), and by replay in
 * PHASE 5 for preconditions, expected effects, invariants and resume validation. There is exactly
 * one implementation and it goes through the ONE TargetResolver, so an assertion cannot mean one
 * thing at distillation time and something else at replay time.
 *
 * Assertions are evaluated over an OBSERVATION, not over the raw page. That is deliberate: an
 * assertion should be true of what the system can SEE. A check that passes against page text the
 * perception layer never surfaced is a check that will pass on a screen the agent cannot operate.
 */
export interface AssertionContext {
  observation: Observation;
  /** Invocation values, by input name. Used by value_matches_param and by parameterized row keys. */
  params: Readonly<Record<string, string>>;
  /** Declared types, by input name. This is what makes comparison typed rather than textual. */
  inputs: readonly InputDefinition[];
  /** Required only by screen_identity_changed. */
  before?: Observation;
}

export interface AssertionOutcome {
  assertionId: string;
  /** True when the assertion was not applicable, because its `when` guard was not satisfied. */
  skipped: boolean;
  passed: boolean;
  detail: string;
}

/**
 * A control comparable text.
 *
 * `value` for a form control, `name` for everything else. A table cell has no value: what it shows
 * IS its accessible name, and an evaluator that only looked at `value` would find every read-only
 * screen empty.
 */
function comparableText(control: PerceivedControl): string {
  return control.value !== undefined && control.value !== '' ? control.value : control.name;
}

function screenText(observation: Observation): string {
  const parts = [
    observation.screenIdentity.canonicalScreenName,
    observation.screenIdentity.title,
    ...observation.screenIdentity.headings,
  ];
  for (const control of observation.controls) {
    parts.push(control.name);
    if (control.value !== undefined) parts.push(control.value);
  }
  return parts.join(' | ');
}

export class AssertionEvaluator {
  readonly #resolver: TargetResolver;

  constructor(resolver: TargetResolver) {
    this.#resolver = resolver;
  }

  evaluate(assertion: Assertion, context: AssertionContext): AssertionOutcome {
    const supplied = new Set(Object.keys(context.params));

    // A conditional assertion whose parameter was not supplied is SKIPPED, not failed. Without
    // this, every legitimate invocation that omits an optional input reports INVARIANT_VIOLATED.
    if (!assertionApplies(assertion, supplied)) {
      return {
        assertionId: assertion.id,
        skipped: true,
        passed: true,
        detail:
          'skipped: parameter "' + (assertion.when?.paramPresent ?? '') + '" was not supplied',
      };
    }

    const result = this.#check(assertion, context);
    return { assertionId: assertion.id, skipped: false, ...result };
  }

  evaluateAll(
    assertions: readonly Assertion[],
    context: AssertionContext,
  ): { passed: boolean; outcomes: AssertionOutcome[] } {
    const outcomes = assertions.map((assertion) => this.evaluate(assertion, context));
    return { passed: outcomes.every((outcome) => outcome.passed), outcomes };
  }

  #expectedText(assertion: Assertion, context: AssertionContext): string | undefined {
    const expected = assertion.expected;
    if (expected === undefined) return undefined;
    return expected.kind === 'literal' ? expected.value : context.params[expected.name];
  }

  #resolveTarget(
    assertion: Assertion,
    context: AssertionContext,
  ): { control?: PerceivedControl; detail: string } {
    if (assertion.target === undefined) return { detail: 'assertion declares no target' };
    const bound = bindDescriptor(assertion.target, context.params);
    const resolution = this.#resolver.resolve(context.observation, bound);
    return resolution.ok
      ? { control: resolution.control, detail: 'resolved at ' + (resolution.trace.tierUsed ?? '?') }
      : { detail: resolution.error + ': ' + resolution.detail };
  }

  #check(assertion: Assertion, context: AssertionContext): { passed: boolean; detail: string } {
    const { observation } = context;

    switch (assertion.kind) {
      case 'screen_identity': {
        const expected = this.#expectedText(assertion, context) ?? '';
        const actual = observation.screenIdentity.canonicalScreenName;
        return {
          passed: foldCase(normalizeText(actual)) === foldCase(normalizeText(expected)),
          detail: 'screen is "' + actual + '", expected "' + expected + '"',
        };
      }

      case 'screen_identity_changed': {
        if (context.before === undefined) {
          return { passed: false, detail: 'no prior observation to compare against' };
        }
        const from = context.before.screenIdentity.canonicalScreenName;
        const to = observation.screenIdentity.canonicalScreenName;
        return { passed: from !== to, detail: 'screen went from "' + from + '" to "' + to + '"' };
      }

      case 'text_present': {
        const expected = this.#expectedText(assertion, context) ?? '';
        const haystack = foldCase(normalizeText(screenText(observation)));
        return {
          passed: haystack.includes(foldCase(normalizeText(expected))),
          detail: 'looked for "' + expected + '" in the perceived screen text',
        };
      }

      case 'control_visible': {
        const resolved = this.#resolveTarget(assertion, context);
        return { passed: resolved.control !== undefined, detail: resolved.detail };
      }

      case 'value_equals': {
        const resolved = this.#resolveTarget(assertion, context);
        if (resolved.control === undefined) return { passed: false, detail: resolved.detail };
        const expected = this.#expectedText(assertion, context) ?? '';
        const actual = comparableText(resolved.control);
        return {
          passed: foldCase(normalizeText(actual)) === foldCase(normalizeText(expected)),
          detail: 'control shows "' + actual + '", expected "' + expected + '"',
        };
      }

      case 'value_matches_param': {
        const expectedMatcher = assertion.expected;
        if (expectedMatcher === undefined || expectedMatcher.kind !== 'param') {
          return { passed: false, detail: 'value_matches_param requires a param expectation' };
        }
        const resolved = this.#resolveTarget(assertion, context);
        if (resolved.control === undefined) return { passed: false, detail: resolved.detail };

        const paramName = expectedMatcher.name;
        const paramValue = context.params[paramName];
        if (paramValue === undefined) {
          return { passed: false, detail: 'no value supplied for parameter "' + paramName + '"' };
        }

        // TYPED comparison, in the declared type own space. The caller passes "250.00", the field
        // holds "250" and the review screen renders "$250.00".
        const declared = context.inputs.find((input) => input.name === paramName);
        const shape = declared ?? { type: 'string' as const };
        const actual = comparableText(resolved.control);

        return {
          passed: valueMatchesParam(actual, paramValue, shape),
          detail:
            'control shows "' +
            actual +
            '", parameter ' +
            paramName +
            ' is "' +
            paramValue +
            '" (compared as ' +
            shape.type +
            ')',
        };
      }
    }
  }
}
