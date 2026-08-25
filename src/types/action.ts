import { z } from 'zod';
import { TargetDescriptorSchema } from './control.js';
import { TextMatcherSchema, ValueBindingSchema } from './values.js';

/**
 * The complete set of things that may be done to a surface.
 *
 * `navigate` is an ACTION, not a method on the surface. Two reasons, both load-bearing:
 *  - it parameterizes: /member/:memberId becomes pathSegments [literal 'member', param 'memberId'];
 *  - it goes through the same input path as everything else, so the origin allowlist and the
 *    lease apply to it without a second code path.
 *
 * [MUST] There is NO untargeted key press. A targetless Enter on the review screen activates the
 * focused button - which is "Submit Request" - and no amount of logging will make that read as
 * "the agent clicked Submit Request". A TARGETED pressKey may be added in PHASE 7, where it can be
 * risk-classified against the control it addresses.
 */
export const SurfaceActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('navigate'),
    pathSegments: z.array(TextMatcherSchema),
  }),
  z.object({
    type: z.literal('click'),
    target: TargetDescriptorSchema,
  }),
  z.object({
    type: z.literal('type'),
    target: TargetDescriptorSchema,
    value: ValueBindingSchema,
  }),
  z.object({
    type: z.literal('select'),
    target: TargetDescriptorSchema,
    value: ValueBindingSchema,
  }),
  z.object({
    type: z.literal('read'),
    target: TargetDescriptorSchema,
  }),
]);
export type SurfaceAction = z.infer<typeof SurfaceActionSchema>;

export type SurfaceActionType = SurfaceAction['type'];

export const SURFACE_ACTION_TYPES: readonly SurfaceActionType[] = [
  'navigate',
  'click',
  'type',
  'select',
  'read',
];

/**
 * `read` is an ACTION, not perception.
 *
 * The dividing line: passive observation (whole-screen perception, descriptor resolution) needs no
 * lease and changes nothing. A `read` is targeted extraction of a value that is BOUND TO A DECLARED
 * OUTPUT - its result enters the capability's output contract - so it goes through the input path
 * with everything else.
 */
export function isMutatingAction(action: SurfaceAction): boolean {
  return action.type !== 'read';
}
