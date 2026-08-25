import { z } from 'zod';
import { TextMatcherSchema } from './values.js';

/**
 * Closed role vocabulary, ARIA/UIA-shaped so the same words describe a web page and a desktop
 * window. Perception maps whatever the surface reports into exactly these; anything unmappable
 * becomes `unknown` rather than leaking a surface-specific role name into the contract.
 */
export const ControlRoleSchema = z.enum([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'heading',
  'cell',
  'row',
  'table',
  'dialog',
  'alert',
  'region',
  'list',
  'listitem',
  'text',
  'unknown',
]);
export type ControlRole = z.infer<typeof ControlRoleSchema>;

/**
 * [MUST] Locator tiers, de-overlapped.
 *
 * The obvious T1/T2 split ("exact name" vs "label text") never fires on the web, because a proper
 * `<label for>` already feeds the accessible name - so a naive tier 2 would be dead code. These
 * tiers are defined by WHAT EVIDENCE THEY RELY ON, and the evidence does not overlap:
 *
 *   T1_EXACT_ROLE_NAME           exact role + exact accessible name.
 *   T2_NORMALIZED_IN_CONTAINER   normalized name, scoped inside containerHints. Fires when the name
 *                                is right but whitespace/case/punctuation differ, or when the same
 *                                name appears in several regions and the container disambiguates.
 *   T3_EXTERNAL_LABEL_OR_NEARBY  external label or nearby visible text. Fires when the accessible
 *                                name is ABSENT or unreliable - the legacy table-cell case, where
 *                                the label is the <td> to the left and is not wired to the input.
 *   T4_STABLE_ATTRIBUTE          a legacy-stable attribute (ASP-style `name=`). Advisory only:
 *                                it is surface-specific and lives in adapterHints, never in the
 *                                portable semantic contract.
 *   T5_STRUCTURAL_ROW            find the row whose key cell matches rowKey, then the control of
 *                                the requested role inside it. This is how you click the right
 *                                "Open" link when every row has one.
 *
 * Deferred and documented, not implemented in v1:
 *   T6_VISUAL_ANCHOR             locate relative to a rendered visual landmark.
 *   T7_COORDINATES               raw coordinates. Last resort; not portable, not auditable.
 */
export const LocatorTierSchema = z.enum([
  'T1_EXACT_ROLE_NAME',
  'T2_NORMALIZED_IN_CONTAINER',
  'T3_EXTERNAL_LABEL_OR_NEARBY',
  'T4_STABLE_ATTRIBUTE',
  'T5_STRUCTURAL_ROW',
]);
export type LocatorTier = z.infer<typeof LocatorTierSchema>;

/** Tiers in preference order; a resolver walks this list and records where it succeeded. */
export const LOCATOR_TIER_ORDER: readonly LocatorTier[] = [
  'T1_EXACT_ROLE_NAME',
  'T2_NORMALIZED_IN_CONTAINER',
  'T3_EXTERNAL_LABEL_OR_NEARBY',
  'T4_STABLE_ATTRIBUTE',
  'T5_STRUCTURAL_ROW',
];

/** How strictly an accessible name must match. */
export const NameMatchSchema = z.enum(['exact', 'normalized', 'contains']);
export type NameMatch = z.infer<typeof NameMatchSchema>;

const ContainerHintSchema = z.object({
  role: ControlRoleSchema,
  name: z.string().optional(),
});

/**
 * The surface-INDEPENDENT half of a descriptor: role, accessible name, and the text around it.
 * Every field here is expressible on a web page and on a desktop window. This is the portable
 * contract, and it is the only half the capability's meaning depends on.
 */
export const SemanticDescriptorSchema = z.object({
  role: ControlRoleSchema,
  name: z.string().optional(),
  nameMatch: NameMatchSchema,
  /** Labels and adjacent cells. Works on web AND desktop; carries the legacy left-<td> label. */
  nearbyText: z.array(z.string()).optional(),
  containerHints: z.array(ContainerHintSchema).optional(),
  /** Identifies one row of a repeating table by the text of its key cell. Feeds T5_STRUCTURAL_ROW. */
  rowKey: z.object({ cellText: TextMatcherSchema }).optional(),
  /** Disambiguates among otherwise-identical matches. Last resort within the semantic half. */
  ordinal: z.number().int().nonnegative().optional(),
});
export type SemanticDescriptor = z.infer<typeof SemanticDescriptorSchema>;

/**
 * The surface-SPECIFIC half. Advisory only - a resolver may use these to go faster or to
 * disambiguate, but a descriptor whose semantic half no longer resolves is a broken descriptor
 * even if its hints still match. This is the honesty commitment in type form: the CONTRACT is
 * surface-independent, the HINTS are adapter-specific.
 */
export const AdapterHintsSchema = z.object({
  web: z
    .object({
      /** Frame path, e.g. ['contentFrame']. Not a CSS selector. */
      contextPath: z.array(z.string()).optional(),
      /** Legacy-stable attributes such as ASP-style `name=`. Never a CSS class or generated id. */
      stableAttribute: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});
export type AdapterHints = z.infer<typeof AdapterHintsSchema>;

/**
 * [MUST] The three-part split: an optional portable key, the semantic contract, and adapter hints.
 *
 * There is no CSS selector anywhere in this type, and there is no place to put one.
 */
export const TargetDescriptorSchema = z.object({
  /**
   * Stable cross-tenant identity for "the same control" across differently-branded deployments,
   * e.g. 'member.search.input'. OPTIONAL and UNUSED until PHASE 11 - present now only so that
   * adding cross-tenant support later is not a schema retrofit against artifacts that already
   * exist and are already content-hashed.
   */
  semanticKey: z.string().optional(),
  semantic: SemanticDescriptorSchema,
  adapterHints: AdapterHintsSchema.optional(),
  /** The tier that actually resolved this control during discovery. Provenance, not instruction. */
  recordedTier: LocatorTierSchema,
});
export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;
