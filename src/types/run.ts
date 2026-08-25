import { z } from 'zod';
import { BusinessOutcomeCodeSchema, ErrorCodeSchema } from './outcomes.js';
import { MoneySchema } from './money.js';

/** A value produced by a declared output. Currency outputs are Money, never a float or a string. */
export const OutputValueSchema = z.union([z.string(), MoneySchema]);
export type OutputValue = z.infer<typeof OutputValueSchema>;

export const OutputsSchema = z.record(z.string(), OutputValueSchema);
export type Outputs = z.infer<typeof OutputsSchema>;

/** Pointer to the evidence bundle for this run. Written in PHASE 10; carried from PHASE 1. */
export const EvidenceRefSchema = z.string().min(1);
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const RunMetricsSchema = z.object({
  steps: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  /** [MUST] Replay proves itself here: a replay run reports llmCalls: 0, always. */
  llmCalls: z.number().int().nonnegative(),
  recoveriesUsed: z.number().int().nonnegative(),
  locatorTierDowngrades: z.number().int().nonnegative(),
  humanInterventions: z.number().int().nonnegative(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

/**
 * [MUST] There is no completionMode:'human'.
 *
 * No path produces it. In PHASE 8 the human operator CANNOT declare success - completion is
 * declared by the system after independent re-observation, and that rule binds the human exactly as
 * it binds the model. `human_assisted` is the real case and the only one: automation acts, the
 * human clears a modal or answers a prompt, automation resumes, the system re-observes and declares
 * completion.
 */
export const CompletionModeSchema = z.enum(['automation', 'human_assisted']);
export type CompletionMode = z.infer<typeof CompletionModeSchema>;

export const RunResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    completionMode: CompletionModeSchema,
    outputs: OutputsSchema,
    evidenceRef: EvidenceRefSchema,
    metrics: RunMetricsSchema,
  }),
  z.object({
    status: z.literal('business_outcome'),
    outcome: BusinessOutcomeCodeSchema,
    detail: z.string(),
    outputs: OutputsSchema.optional(),
    evidenceRef: EvidenceRefSchema,
    metrics: RunMetricsSchema,
  }),
  z.object({
    status: z.literal('needs_human'),
    interventionId: z.string().min(1),
    reason: z.string().min(1),
    stepId: z.string().min(1),
    evidenceRef: EvidenceRefSchema,
    metrics: RunMetricsSchema,
  }),
  z.object({
    status: z.literal('cancelled'),
    reason: z.literal('OPERATOR_ABORTED'),
    stepId: z.string().min(1).optional(),
    evidenceRef: EvidenceRefSchema,
    metrics: RunMetricsSchema,
  }),
  z.object({
    status: z.literal('failed'),
    error: ErrorCodeSchema,
    stepId: z.string().min(1).optional(),
    /**
     * Nullable rather than optional, deliberately. Some failures genuinely have no expected /
     * observed pair (TIMEOUT, SURFACE_UNAVAILABLE). Writing `null` forces the producer to say
     * "there is nothing to compare here" instead of silently omitting the most diagnostic field
     * on the type.
     */
    expected: z.string().nullable(),
    observed: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    evidenceRef: EvidenceRefSchema,
    metrics: RunMetricsSchema,
  }),
]);
export type RunResult = z.infer<typeof RunResultSchema>;

export type RunStatus = RunResult['status'];

/**
 * NOTE FOR REPORT.md - deliberately not built:
 *
 * In this CLI, `needs_human` is surfaced as an EVENT and the process blocks until a final result
 * arrives. In production, a caller would receive `needs_human` together with a runId and poll an
 * async status API for the eventual terminal result. That API is a deployment concern, not a
 * capability concern, and it is NOT built here.
 */
