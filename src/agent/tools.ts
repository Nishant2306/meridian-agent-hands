import { z } from 'zod';
import { ValueBindingSchema } from '../types/values.js';

/**
 * ==============================================================================================
 * THE ACTION SPACE.
 * ==============================================================================================
 *
 * NO TOOL ACCEPTS A CSS SELECTOR, AN XPATH, OR COORDINATES. There is nowhere to put one.
 *
 * The model may reference exactly one kind of thing: a `markId` from the numbered inventory it was
 * just shown. Mark ids are ephemeral - valid only inside the observation that produced them - and
 * they NEVER reach the artifact: the system converts a mark into a full TargetDescriptor before
 * anything is recorded, and `ArtifactAction` has nowhere to store one.
 *
 * That is the whole reason the model cannot author locators. It is not a rule in the prompt that a
 * clever completion might talk its way around; it is the shape of the tools.
 *
 * [MUST] There is NO press_key in v1. A targetless Enter on the review screen activates the focused
 * button, which is "Submit Request", and no amount of logging makes that read as an intentional
 * click. A TARGETED pressKey may be added in PHASE 7, where it can be risk-classified against the
 * control it addresses.
 */

/**
 * [MUST] `value` is ALWAYS the ValueBinding union, never a bare string.
 *
 * `{ kind: 'literal', value: 'memberId' }` and `{ kind: 'param', name: 'memberId' }` are different
 * things, and a bare string cannot tell them apart. The distinction matters most in exactly the
 * case where it is easiest to get wrong: a parameter whose NAME also reads like a value.
 *
 * A secret is proposable only as `{ kind: 'secretRef', name }`. The model never sees the value
 * behind that name; the executor resolves it one step before the keystrokes.
 */
const ValueArgument = ValueBindingSchema;

export const ObserveMoreArgs = z.object({
  reason: z.string().min(1),
});

export const ClickArgs = z.object({
  markId: z.number().int().positive(),
  intent: z.string().min(1),
});

export const TypeTextArgs = z.object({
  markId: z.number().int().positive(),
  value: ValueArgument,
  intent: z.string().min(1),
});

export const SelectOptionArgs = z.object({
  markId: z.number().int().positive(),
  value: ValueArgument,
  intent: z.string().min(1),
});

export const ReadValueArgs = z.object({
  markId: z.number().int().positive(),
  outputName: z.string().min(1),
  parseAs: z.enum(['text', 'currency', 'integer']),
  intent: z.string().min(1),
});

export const ProposeEffectArgs = z.object({
  markId: z.number().int().positive().optional(),
  kind: z.enum([
    'screen_identity',
    'control_visible',
    'text_present',
    'value_equals',
    'value_matches_param',
    'screen_identity_changed',
  ]),
  expected: z.union([z.string(), z.object({ param: z.string().min(1) })]).optional(),
  description: z.string().min(1),
});

/**
 * A LABEL, not a stateId.
 *
 * Concrete state ids, their assertions and their resume-eligibility are produced by the DISTILLER
 * from what was observed. The model contributes a human-readable name for a place it thinks it has
 * reached; it does not get to define the state machine replay will execute.
 */
export const ProposeStateReachedArgs = z.object({
  label: z.string().min(1),
  evidence: z.string().min(1),
});

export const ProposeRecordIdentityArgs = z.object({
  markId: z.number().int().positive(),
  intent: z.string().min(1),
});

export const ProposeGoalReachedArgs = z.object({
  summary: z.string().min(1),
  outputs: z.record(z.string(), z.string()),
});

export const RequestHumanArgs = z.object({
  reason: z.string().min(1),
  whatYouTried: z.string().min(1),
});

export const GiveUpArgs = z.object({
  reason: z.string().min(1),
});

export const TOOL_ARGS = {
  observe_more: ObserveMoreArgs,
  click: ClickArgs,
  type_text: TypeTextArgs,
  select_option: SelectOptionArgs,
  read_value: ReadValueArgs,
  propose_effect: ProposeEffectArgs,
  propose_state_reached: ProposeStateReachedArgs,
  propose_record_identity: ProposeRecordIdentityArgs,
  propose_goal_reached: ProposeGoalReachedArgs,
  request_human: RequestHumanArgs,
  give_up: GiveUpArgs,
} as const;

export type ToolName = keyof typeof TOOL_ARGS;
export const TOOL_NAMES = Object.keys(TOOL_ARGS) as ToolName[];

export type ToolCall = {
  [K in ToolName]: { name: K; input: z.infer<(typeof TOOL_ARGS)[K]> };
}[ToolName];

/** Parse an unvalidated tool call. Returns a reason rather than throwing: it is model output. */
export function parseToolCall(
  name: string,
  input: unknown,
): { ok: true; call: ToolCall } | { ok: false; reason: string } {
  if (!(name in TOOL_ARGS)) {
    return { ok: false, reason: 'there is no tool called "' + name + '"' };
  }
  const schema = TOOL_ARGS[name as ToolName];
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => (issue.path.join('.') || '(root)') + ': ' + issue.message)
      .join('; ');
    return { ok: false, reason: 'arguments for "' + name + '" are not valid: ' + detail };
  }
  return { ok: true, call: { name, input: parsed.data } as ToolCall };
}
