import { z } from 'zod';
import { SensitivitySchema, ValueTypeSchema } from './values.js';

/**
 * ============================================================================================
 * [MUST] THE DECLARED CONTRACT vs THE DISCOVERED PATH
 * ============================================================================================
 *
 * Two facts are both true and they pull in opposite directions:
 *
 *   - A single happy-path run cannot infer conditions it never encountered, and the model must not
 *     be the thing that invents the business contract. Types, sensitivity, outputs, record identity
 *     and known conditions are DECLARED BY A HUMAN.
 *   - A human cannot author descriptors for controls that have not been discovered yet. Nobody can
 *     hand-write a TargetDescriptor for a legacy screen they have not seen.
 *
 * The resolution: THE HUMAN DECLARES SEMANTICS; DISCOVERY BINDS THEM TO CONTROLS. The spec says
 * "this capability produces an output called memberName, it is a string, it is PII, it is required
 * on success". It does NOT say where on the screen that value lives. Discovery finds that.
 */

/** Placeholder syntax in goalTemplate: {{memberId}}. Names only - never values. */
export const GOAL_PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function goalTemplatePlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(GOAL_PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found];
}

export const InputDefinitionSchema = z
  .object({
    name: z.string().min(1),
    type: ValueTypeSchema,
    /** Required for `enum`, forbidden otherwise. */
    values: z.array(z.string().min(1)).min(1).optional(),
    /** Allowed only for `string`. A declared pattern also drives typed comparison (normalize.ts). */
    pattern: z.string().min(1).optional(),
    required: z.boolean(),
    sensitivity: SensitivitySchema,
    description: z.string().min(1),
    /**
     * [MUST] Example values must be OBVIOUSLY SYNTHETIC and must never equal a value used in an
     * evidence run. An example that collides with real run data turns a documentation field into
     * an accidental disclosure channel.
     */
    example: z.string().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.type === 'enum' && (!input.values || input.values.length === 0)) {
      ctx.addIssue({ code: 'custom', message: `enum input "${input.name}" must declare values` });
    }
    if (input.type !== 'enum' && input.values) {
      ctx.addIssue({
        code: 'custom',
        message: `input "${input.name}" is ${input.type} and must not declare values`,
      });
    }
    if (input.type !== 'string' && input.pattern) {
      ctx.addIssue({
        code: 'custom',
        message: `input "${input.name}" is ${input.type} and must not declare a pattern`,
      });
    }
    if (input.example !== undefined && input.type === 'enum' && input.values) {
      if (!input.values.includes(input.example)) {
        ctx.addIssue({
          code: 'custom',
          message: `example for enum input "${input.name}" is not one of its declared values`,
        });
      }
    }
    if (input.example !== undefined && input.pattern) {
      if (!new RegExp(input.pattern).test(input.example)) {
        ctx.addIssue({
          code: 'custom',
          message: `example for input "${input.name}" does not match its declared pattern`,
        });
      }
    }
  });
export type InputDefinition = z.infer<typeof InputDefinitionSchema>;

/**
 * WHAT the capability must produce - never WHERE it lives on the screen.
 *
 * `when: 'success'` is a closed literal in v1: every declared output is produced on the success
 * path only. Business outcomes carry their own optional outputs on RunResult.
 */
export const DeclaredOutputSchema = z.object({
  name: z.string().min(1),
  type: ValueTypeSchema,
  values: z.array(z.string().min(1)).min(1).optional(),
  sensitivity: SensitivitySchema,
  required: z.boolean(),
  when: z.literal('success'),
  description: z.string().min(1).optional(),
});
export type DeclaredOutput = z.infer<typeof DeclaredOutputSchema>;

/**
 * Which invocation parameter identifies the record being operated on.
 *
 * This is what lets replay assert "we are on the right member's page" rather than "we are on a
 * member page". It is declared, because only a human knows which of several IDs on a legacy screen
 * is the one that means identity.
 */
export const RecordIdentityRequirementSchema = z.object({
  param: z.string().min(1),
  description: z.string().min(1),
});
export type RecordIdentityRequirement = z.infer<typeof RecordIdentityRequirementSchema>;

/** A profile is referenced by id + version here. Its sha256 is pinned during DISTILLATION. */
export const ProfileRefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
});
export type ProfileRef = z.infer<typeof ProfileRefSchema>;

export const DiscoverySpecSchema = z
  .object({
    capabilityId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    /** [MUST] Parameter NAMES only, never values. Validated below against `inputs`. */
    goalTemplate: z.string().min(1),
    target: z.object({
      product: z.string().min(1),
      entryPoint: z.string().min(1),
      compatibility: z.object({ versionRange: z.string().min(1) }),
    }),
    inputs: z.array(InputDefinitionSchema).min(1),
    outputs: z.array(DeclaredOutputSchema).min(1),
    recordIdentity: RecordIdentityRequirementSchema,
    /** Optional labels the model MAY propose for screens it reaches. Suggestions, not a state machine. */
    logicalStates: z.array(z.string().min(1)).optional(),
    /**
     * Hashes are pinned during DISTILLATION, not here - see CLAUDE.md clarification 1. The spec
     * names the profile; the artifact pins its content.
     */
    conditionProfile: ProfileRefSchema,
    safetyProfile: ProfileRefSchema,
  })
  .superRefine((spec, ctx) => {
    const inputNames = new Set<string>();
    for (const input of spec.inputs) {
      if (inputNames.has(input.name)) {
        ctx.addIssue({ code: 'custom', message: `duplicate input name "${input.name}"` });
      }
      inputNames.add(input.name);
    }

    const outputNames = new Set<string>();
    for (const output of spec.outputs) {
      if (outputNames.has(output.name)) {
        ctx.addIssue({ code: 'custom', message: `duplicate output name "${output.name}"` });
      }
      outputNames.add(output.name);
    }

    for (const placeholder of goalTemplatePlaceholders(spec.goalTemplate)) {
      if (!inputNames.has(placeholder)) {
        ctx.addIssue({
          code: 'custom',
          message: `goalTemplate references "{{${placeholder}}}" which is not a declared input`,
        });
      }
    }

    if (!inputNames.has(spec.recordIdentity.param)) {
      ctx.addIssue({
        code: 'custom',
        message: `recordIdentity.param "${spec.recordIdentity.param}" is not a declared input`,
      });
    }
  });
export type DiscoverySpec = z.infer<typeof DiscoverySpecSchema>;

/**
 * One concrete run of a spec.
 *
 * `goal` is EXPLICIT and separate from the spec's goalTemplate: the rendered natural-language goal
 * the model is actually given. Keeping it a field rather than deriving it silently means the goal
 * that drove a run is always recoverable from the run, and never reconstructed by guesswork.
 */
export const DiscoveryInvocationSchema = z.object({
  spec: DiscoverySpecSchema,
  goal: z.string().min(1),
  /** Tenant / entry point this run is aimed at. */
  target: z.string().min(1),
  runtimeInputs: z.record(z.string(), z.unknown()),
});
export type DiscoveryInvocation = z.infer<typeof DiscoveryInvocationSchema>;

/**
 * THE ARTIFACT IS ASSEMBLED FROM THREE SOURCES - say this plainly in REPORT.md:
 *
 *     declared contract  +  observed successful path  +  pinned condition profile
 *
 * Remove any one and the result is not a capability: without the contract it is a macro, without
 * the observed path it is a wish, without the pinned profile it is unverifiable.
 */
