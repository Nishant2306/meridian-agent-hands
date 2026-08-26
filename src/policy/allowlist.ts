import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { SURFACE_ACTION_TYPES } from '../types/action.js';
import { RiskClassSchema } from '../types/risk.js';
import type { SurfaceActionType } from '../types/action.js';

/**
 * ================================================================================================
 * THE RUNTIME ALLOWLIST. CONFIGURATION, NOT A PINNED PROFILE.
 * ================================================================================================
 *
 * The condition and safety profiles are pinned by SHA-256 into every artifact, because they are
 * part of the capability's CONTRACT. This file is not: it describes the DEPLOYMENT - which origin
 * this installation talks to, which routes are in scope, how long a run may take. Two deployments
 * of the same capability legitimately differ here, and neither should invalidate the other's
 * artifacts. Hashing it into the artifact would make a capability un-portable for no safety gain.
 *
 * WHAT IT IS NOT ALLOWED TO DO. It cannot weaken the bootstrap minimum, because the minimum is
 * enforced separately and the effective decision is the strictest of the two. It cannot weaken the
 * pinned safety profile either: an irreversible control is irreversible whatever this file says.
 */

const DenyPatternSchema = z.object({
  /** Required. A phrase matched on whole words against the resolved control's accessible name. */
  controlPhrase: z.string().min(1),
  /**
   * Optional. Narrows the rule to one kind of screen, which is the entire point of the contextual
   * form: "Continue" on a form advances and on a confirmation screen commits, and the control name
   * is identical either way.
   */
  screenPhrase: z.string().min(1).optional(),
  why: z.string().min(1),
});
export type DenyPattern = z.infer<typeof DenyPatternSchema>;

export const AllowlistSchema = z
  .object({
    version: z.literal(1),
    allowedOrigins: z.array(z.string().url()).min(1),
    allowedRoutePatterns: z.array(z.string().min(1)),
    deniedRoutePatterns: z.array(z.string().min(1)),
    allowedActionTypes: z
      .array(z.enum(SURFACE_ACTION_TYPES as [SurfaceActionType, ...SurfaceActionType[]]))
      .min(1),
    /**
     * A click at (x, y) is not a click on a CONTROL, so nothing downstream can classify its risk.
     * It is unaddressable by policy and therefore not allowed at all. Kept as its own flag rather
     * than an absent action type so that turning it on is a visible, deliberate act.
     */
    coordinateActionsAllowed: z.literal(false),
    deniedControlPatterns: z.array(DenyPatternSchema),
    riskRules: z.object({ maxRiskAllowed: RiskClassSchema }),
    maxSteps: z.number().int().positive(),
    maxRunDurationMs: z.number().int().positive(),
  })
  .strict();

export type Allowlist = z.infer<typeof AllowlistSchema>;

export function allowlistPath(configRoot: string): string {
  return join(configRoot, 'allowlist.yaml');
}

export function loadAllowlist(path: string): Allowlist {
  // Parsed through the schema, so a malformed allowlist fails at load with a readable error rather
  // than silently allowing everything three layers down.
  return AllowlistSchema.parse(parse(readFileSync(path, 'utf8')));
}
