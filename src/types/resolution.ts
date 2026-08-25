import { z } from 'zod';
import { LocatorTierSchema } from './control.js';
import { PerceivedControlSchema } from './perception.js';

/**
 * Two INDEPENDENT high-confidence signals that resolve to DIFFERENT controls.
 *
 * Role plus accessible name says control A. The legacy `name` attribute says control B. Exactly
 * one of those is wrong, and nothing in the data says which. In a banking application the correct
 * behaviour is to stop: accepting the earlier tier means clicking a control we have positive
 * evidence is the wrong one.
 */
export const ConflictSchema = z.object({
  tierA: LocatorTierSchema,
  tierB: LocatorTierSchema,
  markIdA: z.number().int().positive(),
  markIdB: z.number().int().positive(),
  detail: z.string(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

export const TierAttemptSchema = z.object({
  tier: LocatorTierSchema,
  candidateCount: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
});
export type TierAttempt = z.infer<typeof TierAttemptSchema>;

/**
 * How a descriptor became a control. Provenance for evidence, and the drift signal that tells an
 * operator a screen is changing under them before it breaks outright.
 */
export const ResolutionTraceSchema = z.object({
  observationId: z.string().min(1),
  tiersAttempted: z.array(TierAttemptSchema),
  /** null when nothing resolved. */
  tierUsed: LocatorTierSchema.nullable(),
  conflicts: z.array(ConflictSchema),
  /**
   * True when the tier that actually worked is weaker than the tier recorded at discovery time.
   * The action still proceeds; the run counts it in metrics.locatorTierDowngrades and the evidence
   * records it. A capability that has quietly slid from T1 to T5 still works and is about to stop.
   */
  downgraded: z.boolean(),
});
export type ResolutionTrace = z.infer<typeof ResolutionTraceSchema>;

/** Only these three failures come out of resolution. All are ErrorCode members. */
export const ResolutionFailureCodeSchema = z.enum([
  'CONTROL_NOT_FOUND',
  'AMBIGUOUS_CONTROL',
  'LOCATOR_CONFLICT',
]);
export type ResolutionFailureCode = z.infer<typeof ResolutionFailureCodeSchema>;

export const ResolutionSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    control: PerceivedControlSchema,
    trace: ResolutionTraceSchema,
  }),
  z.object({
    ok: z.literal(false),
    error: ResolutionFailureCodeSchema,
    detail: z.string(),
    trace: ResolutionTraceSchema,
  }),
]);
export type Resolution = z.infer<typeof ResolutionSchema>;
