import { z } from 'zod';

/**
 * [MUST] The risk vocabulary.
 *
 * SAFE_REVERSIBLE   - reading, navigating, filling a form that has not been submitted.
 * RISKY_REVERSIBLE  - changes state, but a human can undo it.
 * IRREVERSIBLE      - cannot be undone from inside the application. "Submit Request" lives here.
 */
export const RiskClassSchema = z.enum(['SAFE_REVERSIBLE', 'RISKY_REVERSIBLE', 'IRREVERSIBLE']);
export type RiskClass = z.infer<typeof RiskClassSchema>;

/**
 * Total order over RiskClass.
 *
 * This exists so that "effective risk is the maximum of three sources" (the action's own class, the
 * resolved control's class, and the safety profile's class for that control) is a well-defined
 * statement rather than a sentence in a design doc. The three sources are combined in PHASE 7; the
 * ordering they combine under is fixed here.
 */
export const RISK_ORDER: Readonly<Record<RiskClass, number>> = {
  SAFE_REVERSIBLE: 0,
  RISKY_REVERSIBLE: 1,
  IRREVERSIBLE: 2,
};

/** The most dangerous of the supplied classes. With no arguments, the safest class. */
export function maxRisk(...classes: readonly RiskClass[]): RiskClass {
  let highest: RiskClass = 'SAFE_REVERSIBLE';
  for (const candidate of classes) {
    if (RISK_ORDER[candidate] > RISK_ORDER[highest]) highest = candidate;
  }
  return highest;
}

/** True when `actual` is at least as dangerous as `threshold`. */
export function riskAtLeast(actual: RiskClass, threshold: RiskClass): boolean {
  return RISK_ORDER[actual] >= RISK_ORDER[threshold];
}
