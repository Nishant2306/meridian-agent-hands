/**
 * ==============================================================================================
 * markIds ARE EPHEMERAL.
 * ==============================================================================================
 *
 * A markId is an index into ONE Observation of ONE screen. It is meaningless against any other
 * observation, and it must never be written into an artifact. Mark 7 on Tuesday is a different
 * control from mark 7 on Wednesday.
 *
 * The model selects marks. The system converts the selected mark into a TargetDescriptor before
 * anything is recorded. `ArtifactAction` has nowhere to put a markId (see src/types/proposal.ts),
 * so the mistake is not merely detected, it is inexpressible.
 * ==============================================================================================
 */
import { z } from 'zod';
import { ControlRoleSchema } from './control.js';

/** Captured for screenshot masking (PHASE 7), never for locating. */
export const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Box = z.infer<typeof BoxSchema>;

/**
 * Which extraction path produced an observation. Logged on every observation.
 *
 * `cdp_ax` is the primary path: Chrome's own accessibility tree, enriched from the DOM for the
 * things an AX tree does not carry (nearby text, the legacy `name` attribute, the box).
 * `aria_snapshot` is the documented fallback for when the AX tree is unavailable. It is DEGRADED:
 * role and name only, no nearby text, no boxes. Perception is accessibility-FIRST, not
 * accessibility-ONLY, and this field is how a reader can tell which one they are looking at.
 */
export const PerceptionPathSchema = z.enum(['cdp_ax', 'aria_snapshot']);
export type PerceptionPath = z.infer<typeof PerceptionPathSchema>;

const ContainerRefSchema = z.object({
  role: ControlRoleSchema,
  name: z.string().optional(),
});
export type ContainerRef = z.infer<typeof ContainerRefSchema>;

export const PerceivedControlSchema = z.object({
  /** EPHEMERAL. Valid only inside the Observation that produced it. See the banner above. */
  markId: z.number().int().positive(),
  role: ControlRoleSchema,
  name: z.string(),
  value: z.string().optional(),
  enabled: z.boolean(),
  /** Frame path, e.g. [] for the top document, ['contentFrame'] inside the content iframe. */
  contextPath: z.array(z.string()),
  /**
   * Text immediately LEFT of and ABOVE the control.
   *
   * The single most important field for legacy table-labelled forms. In this fixture the account
   * type select has NO accessible name at all; the only thing that identifies it is the <td> to
   * its left reading "Account Type". Without this field, T3_EXTERNAL_LABEL_OR_NEARBY cannot fire
   * and half the screens in the application are unaddressable.
   */
  nearbyText: z.array(z.string()),
  /**
   * The `name` attribute ONLY. Never class, never a generated id.
   *
   * Class names and ids are regenerated on every boot of this application, so recording them would
   * produce a locator that breaks on restart. The `name` attribute is legacy-stable because the
   * server's form handling depends on it, which is exactly what makes it worth recording, and it
   * stays advisory (T4) because it is web-specific and has no desktop equivalent.
   */
  stableAttributes: z.record(z.string(), z.string()),
  box: BoxSchema,
  /** 'page' when the box was offset into top-level page space; 'frame' when it could not be. */
  boxSpace: z.enum(['page', 'frame']).optional(),
  /**
   * Ancestor chain, outermost last. Required by T2_NORMALIZED_IN_CONTAINER: `containerHints` on a
   * descriptor cannot be evaluated without knowing what a control is inside of. See DECISIONS.md D9.
   */
  containers: z.array(ContainerRefSchema),
  /**
   * Text of every cell in the containing table row, if any. Required by T5_STRUCTURAL_ROW: picking
   * the right "Open" link out of four identical ones means matching the row's KEY cell, which may
   * be several cells away and is therefore not reachable through nearbyText. See DECISIONS.md D9.
   */
  rowCellTexts: z.array(z.string()).optional(),
});
export type PerceivedControl = z.infer<typeof PerceivedControlSchema>;

/**
 * What screen are we on?
 *
 * Used for assertions, for evidence, and (through isCompatibleScreenContext) to reject a model
 * proposal that was formed against a screen we have since navigated away from.
 */
export const ScreenIdentitySchema = z.object({
  title: z.string(),
  /**
   * The screen's human name, derived from the most specific heading available: the content frame's
   * H1 if there is one, otherwise the top document's H1, otherwise the title. On a legacy app the
   * H1 is the most reliable screen label there is, because it is what the operator reads.
   */
  canonicalScreenName: z.string(),
  /** Every frame path present, including []. Part of screen identity: frames ARE the layout. */
  contextPaths: z.array(z.array(z.string())),
  headings: z.array(z.string()),
  versionMarker: z.string().optional(),
  /**
   * Present for evidence and for the origin allowlist. DELIBERATELY EXCLUDED from screen-context
   * compatibility: /search?q=10001 and /search?q=10002 are the same screen, and a compatibility
   * check that says otherwise would reject every legitimate proposal on a parameterized page.
   */
  url: z.string().optional(),
});
export type ScreenIdentity = z.infer<typeof ScreenIdentitySchema>;

/** How the inventory was cut down, if it was. Never silent. */
export const InventoryTruncationSchema = z.object({
  perceived: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
  droppedByPriority: z.array(ControlRoleSchema),
});
export type InventoryTruncation = z.infer<typeof InventoryTruncationSchema>;

export const ObservationSchema = z.object({
  observationId: z.string().min(1),
  surfaceId: z.string().min(1),
  capturedAt: z.string().min(1),
  perceptionPath: PerceptionPathSchema,
  screenIdentity: ScreenIdentitySchema,
  controls: z.array(PerceivedControlSchema),
  truncation: InventoryTruncationSchema,
});
export type Observation = z.infer<typeof ObservationSchema>;

export function findControl(
  observation: Observation,
  markId: number,
): PerceivedControl | undefined {
  return observation.controls.find((control) => control.markId === markId);
}
