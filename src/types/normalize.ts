import { formatMoney, moneyEquals, parseMoney, type Money } from './money.js';
import type { ValueType } from './values.js';

/**
 * ============================================================================================
 * [MUST] `value_matches_param` COMPARES BY DECLARED TYPE, NOT BY STRING.
 * ============================================================================================
 *
 * One value, three renderings, all on the same run:
 *
 *     the caller passes      "250.00"
 *     the input field holds  "250"
 *     the review screen says "$250.00"
 *
 * String equality fails on the first real run. Comparison is therefore performed in the DECLARED
 * TYPE's own space: currency compares minor units, strings compare after whitespace/case folding,
 * enums compare exactly after trimming, and pattern-typed identifiers are normalized per their
 * declared pattern before comparison.
 */

/**
 * The declared shape a value must be compared under - the comparison-relevant subset of an
 * InputDefinition or a DeclaredOutput, so both can be compared through one function.
 */
export interface DeclaredShape {
  readonly type: ValueType;
  readonly values?: readonly string[];
  readonly pattern?: string;
}

export type NormalizedValue = { kind: 'currency'; money: Money } | { kind: 'text'; text: string };

/**
 * Whitespace and case folding used everywhere a "normalized" comparison is called for - including
 * accessible-name matching in perception. One implementation, so `nameMatch: 'normalized'` and
 * `value_matches_param` can never drift apart.
 *
 * Legacy server-rendered HTML is full of `&nbsp;`, so a normalizer that only handles ASCII
 * space will fail on this fixture specifically. The non-ASCII space characters are built from
 * char codes rather than written as literals, so the intent survives any editor or tool that
 * silently normalizes invisible characters in source.
 */
const UNICODE_SPACES = String.fromCharCode(0x00a0, 0x2007, 0x202f);
// `\\s` is deliberate: inside a template literal a single backslash-s would collapse to the
// character `s`, quietly producing a regex that strips the letter s out of every name.
const WHITESPACE_RUN = new RegExp(`[\\s${UNICODE_SPACES}]+`, 'g');

export function normalizeText(raw: string): string {
  return raw.replace(WHITESPACE_RUN, ' ').trim();
}

/** Lower-cased with `toLowerCase`, not `toLocaleLowerCase`: replay must not depend on host locale. */
export function foldCase(raw: string): string {
  return raw.toLowerCase();
}

/**
 * Conservative detector for "this pattern admits digits and nothing else".
 *
 * Deliberately narrow. A general "derive the alphabet of a regex" implementation is a research
 * project, and a wrong answer here silently mangles values before comparing them. Anything this
 * does not recognise falls through to plain trimmed comparison, which is safe.
 */
function isDigitsOnlyPattern(pattern: string): boolean {
  return /^\^?(\\d|\[0-9\])(\{\d+(,\d*)?\}|\+|\*)?\$?$/.test(pattern);
}

/**
 * Put a raw string into the comparison space of its declared type.
 * Returns null when the text cannot be interpreted under that type at all (e.g. non-money text
 * declared as currency) - the caller decides whether that is a mismatch or a parse error.
 */
export function normalizeDeclared(raw: string, shape: DeclaredShape): NormalizedValue | null {
  switch (shape.type) {
    case 'currency': {
      const money = parseMoney(raw);
      return money === null ? null : { kind: 'currency', money };
    }
    case 'enum': {
      // Enum members are declared literals; case is meaningful ("Savings", "PENDING REVIEW").
      return { kind: 'text', text: normalizeText(raw) };
    }
    case 'string': {
      const trimmed = normalizeText(raw);
      if (shape.pattern && isDigitsOnlyPattern(shape.pattern)) {
        const digits = trimmed.replace(/\D/g, '');
        // Only accept the stripped form if it actually satisfies the declared pattern; otherwise
        // keep the original so a genuine mismatch stays visible instead of being normalized away.
        return new RegExp(shape.pattern).test(digits)
          ? { kind: 'text', text: digits }
          : { kind: 'text', text: trimmed };
      }
      return { kind: 'text', text: foldCase(trimmed) };
    }
  }
}

export function normalizedEquals(a: NormalizedValue, b: NormalizedValue): boolean {
  if (a.kind === 'currency' && b.kind === 'currency') return moneyEquals(a.money, b.money);
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text;
  return false;
}

/**
 * Render an invocation parameter as text so it can be normalized alongside observed screen text.
 * Returns null for values that have no defensible textual form - an unknown object is a contract
 * violation, not something to coerce with String().
 */
export function toComparableText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'object' && value !== null) {
    const candidate = value as Partial<Money>;
    if (candidate.currency === 'USD' && typeof candidate.minorUnits === 'number') {
      return formatMoney({ currency: 'USD', minorUnits: candidate.minorUnits });
    }
  }
  return null;
}

/**
 * The comparison behind the `value_matches_param` assertion.
 * Returns false - never throws - when either side cannot be interpreted under the declared type.
 */
export function valueMatchesParam(
  observedText: string,
  paramValue: unknown,
  shape: DeclaredShape,
): boolean {
  const paramText = toComparableText(paramValue);
  if (paramText === null) return false;

  const observed = normalizeDeclared(observedText, shape);
  const expected = normalizeDeclared(paramText, shape);
  if (observed === null || expected === null) return false;

  return normalizedEquals(observed, expected);
}
