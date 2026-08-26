import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from '../config/canonical.js';
import { ControlRoleSchema, SemanticDescriptorSchema } from '../types/control.js';
import { BusinessOutcomeCodeSchema, ErrorCodeSchema } from '../types/outcomes.js';
import { RiskClassSchema } from '../types/risk.js';

/**
 * ==============================================================================================
 * PROFILES ARE IMMUTABLE ONCE WRITTEN, AND THEIR HASHES ARE SEMANTIC CONTENT.
 * ==============================================================================================
 *
 * A profile is pinned into an artifact as { id, version, sha256 }. That sha256 is NOT approval
 * metadata: it is part of what the capability MEANS, so it is included in the artifact content
 * hash. The lifecycle is fixed:
 *
 *   PHASE 3       write the final versioned YAML. It does not change afterwards.
 *   DISTILLATION  load the profiles, compute their SHA-256, write the pins into the DRAFT
 *                 artifact, and only THEN compute the artifact content hash.
 *   APPROVAL      recompute and VERIFY the pins. Change only status/approvedAt/approvedBy.
 *   REPLAY        verify the pins again. Mismatch is PROFILE_INTEGRITY_FAILURE.
 */

/** How a condition is recognised on a screen. */
export const DetectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), phrase: z.string().min(1) }),
  z.object({
    kind: z.literal('control'),
    role: ControlRoleSchema,
    phrase: z.string().min(1).optional(),
  }),
]);
export type Detect = z.infer<typeof DetectSchema>;

export const KnownOutcomeSchema = z.object({
  id: z.string().min(1),
  outcome: BusinessOutcomeCodeSchema,
  description: z.string().min(1),
  detect: DetectSchema,
  detail: z.string().min(1),
});
export type KnownOutcome = z.infer<typeof KnownOutcomeSchema>;

/**
 * ==============================================================================================
 * WHAT HAPPENS AFTER A RECOVERY CLEARS THE WAY.
 * ==============================================================================================
 *
 *   recheck_expected_effect  Re-observe and check the interrupted step's expected effect. If it
 *                            holds, the step is COMPLETE and the action is NOT repeated. The
 *                            conservative default, and the one the pinned profile uses.
 *   retry_action             The action was genuinely swallowed. Perform it again.
 *   continue_next_step       The interruption was purely cosmetic; this step is done.
 *   { gotoStep }             The remediation moved us somewhere else in the flow.
 *
 * WHY THE DEFAULT IS NOT `retry_action`. The maintenance notice in this application appears AFTER
 * the "New Sub-Account" click, on the screen that click navigated TO. The click worked. Repeating
 * it would navigate a second time from a page whose link is no longer on it, or restart a form
 * that had already been filled. "The overlay swallowed my click" and "the overlay appeared because
 * my click worked" look identical from the screen, and only one of them is safe to retry.
 *
 * WIDENING THIS ENUM DOES NOT TOUCH THE PINNED PROFILE. The YAML file is unchanged, so its SHA-256
 * is unchanged, so every artifact pinned to it still verifies. A profile that USED a new
 * continuation would be a new version file.
 */
export const ContinuationSchema = z.union([
  z.enum(['recheck_expected_effect', 'retry_action', 'continue_next_step']),
  z.object({ gotoStep: z.string().min(1) }),
]);
export type RecoveryContinuation = z.infer<typeof ContinuationSchema>;

export const RecoverySchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  detect: DetectSchema,
  action: z.object({
    kind: z.literal('click'),
    /**
     * A SEMANTIC descriptor only: no adapterHints and no recordedTier. A profile is AUTHORED, not
     * discovered, so there is no tier to record and nothing surface-specific to say. Reusing the
     * same semantic type is what keeps this from becoming a second descriptor vocabulary.
     */
    target: SemanticDescriptorSchema,
  }),
  maxAttempts: z.number().int().positive(),
  continuation: ContinuationSchema,
});
export type Recovery = z.infer<typeof RecoverySchema>;

export const HardFailureSchema = z.object({
  id: z.string().min(1),
  code: ErrorCodeSchema,
  description: z.string().min(1),
  detect: DetectSchema,
});
export type HardFailure = z.infer<typeof HardFailureSchema>;

export const ConditionProfileSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  knownOutcomes: z.array(KnownOutcomeSchema),
  recoveries: z.array(RecoverySchema),
  hardFailures: z.array(HardFailureSchema),
});
export type ConditionProfile = z.infer<typeof ConditionProfileSchema>;

export const IrreversibleControlSchema = z.object({
  phrase: z.string().min(1),
  why: z.string().min(1),
});

export const ContextualDenySchema = z.object({
  id: z.string().min(1),
  screenPhrase: z.string().min(1),
  controlPhrase: z.string().min(1),
  why: z.string().min(1),
});
export type ContextualDeny = z.infer<typeof ContextualDenySchema>;

export const RiskRuleSchema = z.object({
  id: z.string().min(1),
  risk: RiskClassSchema,
  phrases: z.array(z.string().min(1)).min(1),
  why: z.string().min(1),
});
export type RiskRule = z.infer<typeof RiskRuleSchema>;

export const PolicyLimitsSchema = z.object({
  maxRiskAllowed: RiskClassSchema,
  maxSteps: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
});
export type PolicyLimits = z.infer<typeof PolicyLimitsSchema>;

export const SafetyProfileSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  irreversibleControls: z.array(IrreversibleControlSchema).min(1),
  contextualDeny: z.array(ContextualDenySchema),
  defaultRisk: RiskClassSchema,
  riskRules: z.array(RiskRuleSchema),
  policy: PolicyLimitsSchema,
});
export type SafetyProfile = z.infer<typeof SafetyProfileSchema>;

/**
 * ------------------------------------------------------------------------------------------------
 * LOADING AND HASHING
 * ------------------------------------------------------------------------------------------------
 *
 * The pin hashes the profile FILE TEXT, with line endings normalized to LF. Two decisions there,
 * and they pull against each other:
 *
 *   Why the text and not the parsed content: a profile is a SECURITY artifact. Hashing the parsed
 *   content would mean a comment could be rewritten without moving the pin, and the comments in
 *   these files carry the reasoning a reviewer relies on. Every byte of meaning is covered.
 *
 *   Why LF-normalized: git checks out CRLF on Windows and LF elsewhere. A pin computed on one
 *   platform has to verify on the other, or the integrity check becomes a platform check.
 *
 * This deliberately differs from specHash (DECISIONS.md D2), which hashes the CANONICALIZED parsed
 * spec so that reformatting a spec is free. A spec is edited; a profile is frozen. See D14.
 */
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

export function normalizeProfileText(text: string): string {
  return text
    .split(CR + LF)
    .join(LF)
    .split(CR)
    .join(LF);
}

export function profileHash(text: string): string {
  return sha256Hex(normalizeProfileText(text));
}

export interface LoadedProfile<T> {
  profile: T;
  sha256: string;
  sourcePath: string;
}

function parseProfile<T>(schema: z.ZodType<T>, text: string, sourcePath: string): LoadedProfile<T> {
  const parsed = schema.safeParse(parseYaml(text) as unknown);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => '  - ' + (issue.path.join('.') || '(root)') + ': ' + issue.message)
      .join(LF);
    throw new Error('Invalid profile at ' + sourcePath + ':' + LF + detail);
  }
  return { profile: parsed.data, sha256: profileHash(text), sourcePath };
}

export function loadConditionProfile(filePath: string): LoadedProfile<ConditionProfile> {
  return parseProfile(ConditionProfileSchema, readFileSync(filePath, 'utf8'), filePath);
}

export function loadSafetyProfile(filePath: string): LoadedProfile<SafetyProfile> {
  return parseProfile(SafetyProfileSchema, readFileSync(filePath, 'utf8'), filePath);
}

/** Where a profile lives, given the config root. Version is a directory-free file name. */
export function conditionProfilePath(root: string, id: string, version: string): string {
  return root + '/condition-profiles/' + id + '/' + version + '.yaml';
}

export function safetyProfilePath(root: string, id: string, version: string): string {
  return root + '/safety-profiles/' + id + '/' + version + '.yaml';
}
