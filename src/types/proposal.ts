import { z } from 'zod';
import { SurfaceActionSchema, type SurfaceAction } from './action.js';
import { ResolutionTraceSchema } from './resolution.js';
import { ValueBindingSchema } from './values.js';

/**
 * ============================================================================================
 * [MUST] THREE SEPARATE TYPES: WHAT THE MODEL SAID, WHAT WE DID, WHAT THE ARTIFACT KEEPS
 * ============================================================================================
 *
 * The mark number (the index in the numbered inventory the model was shown) is an artefact of ONE
 * observation of ONE screen. It is meaningless on the next observation and catastrophic in a stored
 * capability: mark 7 on Tuesday is a different control from mark 7 on Wednesday.
 *
 * We do not defend that with a test. We defend it with the type system: ArtifactAction is
 * SurfaceAction, and SurfaceAction has nowhere to put a markId. Making the mistake impossible to
 * express beats detecting it after the fact.
 */

/**
 * The kinds a model may propose.
 *
 * Every proposal addresses a MARK from the numbered inventory, so `navigate` - which addresses a
 * URL, not a perceived control - is not model-proposable in v1. The executor navigates to the
 * spec's declared entryPoint; from there the model operates the UI the way a person would, by
 * clicking links. Parameterized `navigate` actions exist in artifacts because the DISTILLER may
 * produce them, not because the model may ask for them.
 */
export const ProposedActionKindSchema = z.enum(['click', 'type', 'select', 'read']);
export type ProposedActionKind = z.infer<typeof ProposedActionKindSchema>;

/** What the MODEL said. Mark numbers live here and nowhere downstream. */
export const ProposedActionSchema = z.object({
  /** Which observation the mark numbers belong to. Feeds the staleness check. */
  observationId: z.string().min(1),
  /** Index into that observation's numbered control inventory. Never reaches an artifact. */
  markId: z.number().int().nonnegative(),
  kind: ProposedActionKindSchema,
  value: ValueBindingSchema.optional(),
  /** The model's stated reason. Evidence and debugging; never executed. */
  intent: z.string().min(1),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

/**
 * ONE ResolutionTrace, defined in src/types/resolution.ts and re-exported here for convenience.
 *
 * PHASE 1 sketched a trace shape before a resolver existed; PHASE 2 replaced it with the shape the
 * real cascade produces (per-tier attempts with candidate counts and timings, recorded conflicts,
 * and the drift flag). Two trace types would have been a parallel abstraction, so there is one.
 * See DECISIONS.md D10.
 */

/** What we ACTUALLY DID, plus how we got there. The discovery transcript is made of these. */
export const RecordedActionSchema = z.object({
  action: SurfaceActionSchema,
  resolutionTrace: ResolutionTraceSchema,
});
export type RecordedAction = z.infer<typeof RecordedActionSchema>;

/** What the ARTIFACT keeps. No observationId, no markId, no way to add one. */
export type ArtifactAction = SurfaceAction;
export const ArtifactActionSchema = SurfaceActionSchema;

/** Compile-time proof that no ArtifactAction variant can carry a mark. */
type HasMarkId<T> = T extends { markId: unknown } ? true : never;
export type _ArtifactActionCannotHoldAMarkId =
  HasMarkId<ArtifactAction> extends never ? true : never;
