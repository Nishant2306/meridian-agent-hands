import { describe, expect, it } from 'vitest';
import { formatMoney, moneyEquals, parseMoney } from '../src/types/money.js';

describe('Money', () => {
  it('parses the three renderings one value has on a single run', () => {
    const fromCaller = parseMoney('250.00');
    const fromField = parseMoney('250');
    const fromScreen = parseMoney('$250.00');

    expect(fromCaller).toEqual({ currency: 'USD', minorUnits: 25000 });
    expect(fromField).toEqual({ currency: 'USD', minorUnits: 25000 });
    expect(fromScreen).toEqual({ currency: 'USD', minorUnits: 25000 });
  });

  it('parses grouped thousands and single-digit fractions', () => {
    expect(parseMoney('$1,234.56')).toEqual({ currency: 'USD', minorUnits: 123456 });
    expect(parseMoney('250.5')).toEqual({ currency: 'USD', minorUnits: 25050 });
    expect(parseMoney('-$12.00')).toEqual({ currency: 'USD', minorUnits: -1200 });
  });

  it('returns null rather than throwing for text that is not money', () => {
    for (const text of ['', 'PENDING REVIEW', '250.000', '12,34', 'twelve', '$']) {
      expect(parseMoney(text)).toBeNull();
    }
  });

  it('never introduces a float', () => {
    // 0.1 + 0.2 territory: parse, add, format, and the cents stay exact.
    const a = parseMoney('0.10');
    const b = parseMoney('0.20');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const sum = {
      currency: 'USD' as const,
      minorUnits: (a?.minorUnits ?? 0) + (b?.minorUnits ?? 0),
    };
    expect(formatMoney(sum)).toBe('$0.30');
  });

  it('formats minor units the way the application renders them', () => {
    expect(formatMoney({ currency: 'USD', minorUnits: 25000 })).toBe('$250.00');
    expect(formatMoney({ currency: 'USD', minorUnits: 123456 })).toBe('$1,234.56');
    expect(formatMoney({ currency: 'USD', minorUnits: 5 })).toBe('$0.05');
    expect(formatMoney({ currency: 'USD', minorUnits: -1200 })).toBe('-$12.00');
  });

  it('round-trips through format and parse', () => {
    for (const minorUnits of [0, 5, 99, 100, 25000, 123456, 1875000]) {
      expect(parseMoney(formatMoney({ currency: 'USD', minorUnits }))).toEqual({
        currency: 'USD',
        minorUnits,
      });
    }
  });

  it('compares by minor units', () => {
    expect(
      moneyEquals({ currency: 'USD', minorUnits: 25000 }, { currency: 'USD', minorUnits: 25000 }),
    ).toBe(true);
    expect(
      moneyEquals({ currency: 'USD', minorUnits: 25000 }, { currency: 'USD', minorUnits: 25001 }),
    ).toBe(false);
  });
});
