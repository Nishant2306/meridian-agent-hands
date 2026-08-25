import { z } from 'zod';

/**
 * The declared type of a capability input or output.
 *
 * This is the DECLARED business contract (a human writes it in the DiscoverySpec), not something
 * the model infers. It is what makes `value_matches_param` comparable by type rather than by
 * string - see src/types/normalize.ts.
 */
export const ValueTypeSchema = z.enum(['string', 'enum', 'currency']);
export type ValueType = z.infer<typeof ValueTypeSchema>;

/**
 * How a value must be handled by redaction, logging and evidence.
 *
 * `secret` values are never seen by the model at all: they travel as a `secretRef` ValueBinding
 * and are resolved by the executor at action time.
 */
export const SensitivitySchema = z.enum(['public', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

/**
 * A string that may either be fixed at distillation time or supplied per invocation.
 *
 * [MUST] There is deliberately NO regex variant in v1. An over-permissive matcher is precisely the
 * failure mode this whole design guards against: a pattern that matches "Submit Request" as well as
 * "Search" turns a safe capability into an irreversible one. Literal or named parameter only.
 */
export const TextMatcherSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('param'), name: z.string().min(1) }),
]);
export type TextMatcher = z.infer<typeof TextMatcherSchema>;

/**
 * Anything that can supply a value to an action.
 *
 * The EXECUTOR resolves params and secrets. The model never handles a secret: it may propose that
 * a field be filled from `secretRef:'appPassword'`, but it never sees, and never can see, the
 * value behind that name.
 */
export const ValueBindingSchema = z.union([
  TextMatcherSchema,
  z.object({ kind: z.literal('secretRef'), name: z.string().min(1) }),
]);
export type ValueBinding = z.infer<typeof ValueBindingSchema>;

export function literal(value: string): TextMatcher {
  return { kind: 'literal', value };
}

export function param(name: string): TextMatcher {
  return { kind: 'param', name };
}

export function secretRef(name: string): ValueBinding {
  return { kind: 'secretRef', name };
}

/** True when a binding carries a value the model must never observe. */
export function isSecretBinding(
  binding: ValueBinding,
): binding is { kind: 'secretRef'; name: string } {
  return binding.kind === 'secretRef';
}
