import { z } from 'zod';
import { TargetDescriptorSchema } from './control.js';
import { TextMatcherSchema } from './values.js';

/**
 * screen_identity          the surface is on the expected screen.
 * control_visible          a specific control is present and visible.
 * text_present             expected text appears somewhere in the observed screen.
 * value_equals             a control's value equals a fixed expected value.
 * value_matches_param      a control's value equals the invocation's value for a named param.
 * screen_identity_changed  the screen is no longer the one we acted on - the effect was observed.
 */
export const AssertionKindSchema = z.enum([
  'screen_identity',
  'control_visible',
  'text_present',
  'value_equals',
  'value_matches_param',
  'screen_identity_changed',
]);
export type AssertionKind = z.infer<typeof AssertionKindSchema>;

export const AssertionSchema = z.object({
  id: z.string().min(1),
  kind: AssertionKindSchema,
  target: TargetDescriptorSchema.optional(),
  expected: TextMatcherSchema.optional(),
  description: z.string().min(1),
  /**
   * [MUST] Conditional assertions.
   *
   * `nickname` is an OPTIONAL input. An assertion that the nickname field contains the nickname
   * must not fire on an invocation that supplied no nickname - otherwise every legitimate
   * no-nickname run fails an assertion and reports INVARIANT_VIOLATED. The guard is declarative so
   * that replay can evaluate it without interpreting anything.
   */
  when: z.object({ paramPresent: z.string().min(1) }).optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

/** True when this assertion should be evaluated for the given invocation inputs. */
export function assertionApplies(
  assertion: Assertion,
  suppliedParams: ReadonlySet<string>,
): boolean {
  if (!assertion.when) return true;
  return suppliedParams.has(assertion.when.paramPresent);
}
