import { z } from 'zod';

/**
 * Money is NEVER a JS float.
 *
 * $250.00 is { currency: 'USD', minorUnits: 25000 }. Equality compares minorUnits, so the three
 * renderings a single value has in this system - the caller's "250.00", the input field's "250",
 * and the review screen's "$250.00" - all compare equal, and none of them ever round.
 */
export const MoneySchema = z.object({
  currency: z.literal('USD'),
  minorUnits: z.number().int(),
});
export type Money = z.infer<typeof MoneySchema>;

/** US dollars are the only currency in v1; the field exists so adding others is not a schema change. */
export const DEFAULT_CURRENCY = 'USD' as const;

const MONEY_TEXT = /^(-?)\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse human-rendered currency text into minor units.
 *
 * Accepts "250", "250.5", "250.00", "$250.00", "$1,234.56", "-$12.00".
 * Returns null - it does not throw - for anything else, because the common caller is comparing
 * observed screen text and "this text is not money" is an ordinary answer, not an exception.
 */
export function parseMoney(text: string): Money | null {
  const match = MONEY_TEXT.exec(text.trim());
  if (!match) return null;

  const [, sign, wholeRaw, fractionRaw] = match;
  if (wholeRaw === undefined) return null;

  const whole = wholeRaw.replaceAll(',', '');
  const fraction = (fractionRaw ?? '').padEnd(2, '0');

  const minorUnits = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(minorUnits)) return null;

  return { currency: DEFAULT_CURRENCY, minorUnits: sign === '-' ? -minorUnits : minorUnits };
}

/** Render minor units as the app renders them: "$1,234.56". */
export function formatMoney(money: Money): string {
  const negative = money.minorUnits < 0;
  const absolute = Math.abs(money.minorUnits);
  const whole = Math.floor(absolute / 100).toLocaleString('en-US');
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${whole}.${fraction}`;
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minorUnits === b.minorUnits;
}
