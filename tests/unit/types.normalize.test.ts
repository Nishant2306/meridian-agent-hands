import { describe, expect, it } from 'vitest';
import { normalizeText, valueMatchesParam } from '../../src/types/normalize.js';
import { maxRisk, riskAtLeast, RISK_ORDER } from '../../src/types/risk.js';

describe('value_matches_param compares by declared type', () => {
  it('matches currency across all three renderings of the same amount', () => {
    const shape = { type: 'currency' } as const;
    expect(valueMatchesParam('$250.00', '250.00', shape)).toBe(true);
    expect(valueMatchesParam('250', '250.00', shape)).toBe(true);
    expect(valueMatchesParam('$250.00', '250', shape)).toBe(true);
    expect(valueMatchesParam('$250.00', { currency: 'USD', minorUnits: 25000 }, shape)).toBe(true);
  });

  it('does not match currency amounts that differ by a cent', () => {
    expect(valueMatchesParam('$250.01', '250.00', { type: 'currency' })).toBe(false);
  });

  it('folds whitespace and case for plain strings', () => {
    const shape = { type: 'string' } as const;
    expect(valueMatchesParam('  Avery   Lin ', 'avery lin', shape)).toBe(true);
    // Non-breaking space, which legacy server-rendered HTML is full of.
    expect(valueMatchesParam('Avery Lin', 'Avery Lin', shape)).toBe(true);
    expect(valueMatchesParam('Avery Linn', 'Avery Lin', shape)).toBe(false);
  });

  it('normalizes pattern-typed identifiers per the declared pattern', () => {
    const shape = { type: 'string', pattern: '^[0-9]{5}$' } as const;
    expect(valueMatchesParam('10001', '10001', shape)).toBe(true);
    // The screen renders it with surrounding punctuation; the param does not.
    expect(valueMatchesParam(' 10001 ', '10001', shape)).toBe(true);
    expect(valueMatchesParam('Member #10001', '10001', shape)).toBe(true);
    expect(valueMatchesParam('10002', '10001', shape)).toBe(false);
  });

  it('keeps enum comparison case-sensitive after trimming', () => {
    const shape = { type: 'enum', values: ['Savings', 'Checking'] } as const;
    expect(valueMatchesParam('  Savings ', 'Savings', shape)).toBe(true);
    expect(valueMatchesParam('savings', 'Savings', shape)).toBe(false);
  });

  it('returns false instead of throwing when a side cannot be interpreted', () => {
    expect(valueMatchesParam('PENDING REVIEW', '250.00', { type: 'currency' })).toBe(false);
    expect(valueMatchesParam('250.00', { nope: true }, { type: 'currency' })).toBe(false);
  });
});

describe('normalizeText', () => {
  it('collapses the non-breaking spaces legacy HTML emits, and nothing else', () => {
    const nbsp = String.fromCharCode(0x00a0);
    expect(normalizeText(`Review` + nbsp + `Sub-Account` + nbsp + `Request`)).toBe(
      'Review Sub-Account Request',
    );
    // Guards a real bug: a regex built in a template literal where `\s` collapses to `s` would
    // strip every letter s and return 'Saving' here.
    expect(normalizeText('Savings')).toBe('Savings');
  });

  it('collapses every kind of whitespace legacy HTML produces', () => {
    expect(normalizeText('  Review   Sub-Account\n\tRequest  ')).toBe('Review Sub-Account Request');
  });
});

describe('RiskClass ordering', () => {
  it('orders the three classes', () => {
    expect(RISK_ORDER.SAFE_REVERSIBLE).toBeLessThan(RISK_ORDER.RISKY_REVERSIBLE);
    expect(RISK_ORDER.RISKY_REVERSIBLE).toBeLessThan(RISK_ORDER.IRREVERSIBLE);
  });

  it('takes the maximum of the contributing sources', () => {
    expect(maxRisk()).toBe('SAFE_REVERSIBLE');
    expect(maxRisk('SAFE_REVERSIBLE', 'RISKY_REVERSIBLE')).toBe('RISKY_REVERSIBLE');
    expect(maxRisk('SAFE_REVERSIBLE', 'IRREVERSIBLE', 'RISKY_REVERSIBLE')).toBe('IRREVERSIBLE');
  });

  it('answers "is this at least as dangerous as"', () => {
    expect(riskAtLeast('IRREVERSIBLE', 'RISKY_REVERSIBLE')).toBe(true);
    expect(riskAtLeast('SAFE_REVERSIBLE', 'RISKY_REVERSIBLE')).toBe(false);
  });
});
