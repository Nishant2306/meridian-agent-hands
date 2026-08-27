import { z } from 'zod';
import { TargetDescriptorSchema } from './control.js';
import { ErrorCodeSchema } from './outcomes.js';

/**
 * ================================================================================================
 * AN INTERVENTION IS A HANDOFF, NOT A NOTIFICATION.
 * ================================================================================================
 *
 * It carries everything a person needs to decide what to do WITHOUT reading the run's logs or the
 * artifact: which capability, which step and why it exists, what stopped us, what is on screen, what
 * we did immediately before, and what the policy would allow next.
 *
 * `allowedChoices` is deliberately `resume | abort` and nothing else. There is no `complete`, and
 * the absence is the design: a human clicking a button must not be able to produce a successful
 * capability result. `resume` subsumes it - the system re-observes, evaluates the success condition,
 * validates the declared outputs and declares success ITSELF, with `completionMode:
 * 'human_assisted'`. "Only the system may declare success" binds the operator exactly as it binds
 * the model.
 */
export const InterventionKindSchema = z.enum([
  /** A blocking state no condition in the profile describes. The PHASE 6 rung-5 case. */
  'unknown_state',
  'ambiguous_control',
  'locator_conflict',
  /** Recoveries were tried and the way is still not clear. */
  'recovery_exhausted',
  /** The model asked for a person, which it may do at any point. */
  'agent_requested',
]);
export type InterventionKind = z.infer<typeof InterventionKindSchema>;

/**
 * What a person DID while they held the lease.
 *
 * An observation diff records the NET result - the form has a value now that it did not have
 * before - which is genuinely useful and genuinely not the same thing. It cannot tell "the operator
 * typed it" from "the application autofilled it", and it cannot see an action that left no trace.
 * So the listeners record the ACTS, and the diff is kept alongside as supplemental evidence.
 *
 * [MUST] NEVER a raw typed value. `valueChanged` says a value changed; `redactedValueToken` is a
 * pseudonym for correlating the same value across events. Recording what an operator typed into a
 * banking application, in a file, is precisely the thing this project exists not to do.
 */
export const HumanActionEvidenceSchema = z.object({
  at: z.string().min(1),
  kind: z.enum(['click', 'input', 'change', 'navigation', 'submit']),
  /** Identified the same way automation identifies a control: role, name, nearby text. */
  target: TargetDescriptorSchema,
  valueChanged: z.boolean().optional(),
  redactedValueToken: z.string().min(1).optional(),
});
export type HumanActionEvidence = z.infer<typeof HumanActionEvidenceSchema>;

export const InterventionStatusSchema = z.enum(['open', 'resumed', 'aborted', 'superseded']);
export type InterventionStatus = z.infer<typeof InterventionStatusSchema>;

export const InterventionSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  kind: InterventionKindSchema,
  runId: z.string().min(1),
  /** 'replay' or 'discovery'. The two modes stop for different reasons and resume the same way. */
  mode: z.enum(['replay', 'discovery']),
  capabilityId: z.string().min(1).optional(),
  capabilityVersion: z.string().min(1).optional(),

  currentStep: z.object({
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    /** The step's recorded INTENT. An id alone sends the reader to the artifact. */
    intent: z.string().min(1),
  }),

  stopReason: z.string().min(1),
  error: ErrorCodeSchema.optional(),

  state: z.object({
    screenIdentity: z.string().min(1),
    visibleHeading: z.string(),
    /** MASKED. The unmasked bytes never get a filename - see src/redaction/masking.ts. */
    maskedScreenshotRef: z.string().min(1),
    inventoryRef: z.string().min(1),
  }),

  /** What the automation did immediately before stopping, so the person is not guessing. */
  previousAction: z.string(),

  policyContext: z.object({
    allowedOrigins: z.array(z.string()),
    maxRiskAllowed: z.string(),
    /** Named so the operator knows what the automation was NOT permitted to do on their behalf. */
    deniedControlPhrases: z.array(z.string()),
  }),

  /** [MUST] No 'complete'. See the banner above. */
  allowedChoices: z.array(z.enum(['resume', 'abort'])).min(1),
  status: InterventionStatusSchema,

  resolution: z
    .object({
      at: z.string().min(1),
      choice: z.enum(['resume', 'abort']),
      humanEvents: z.array(HumanActionEvidenceSchema),
      notes: z.string(),
    })
    .optional(),
});
export type Intervention = z.infer<typeof InterventionSchema>;

/**
 * Hard evidence that the human operated the SAME live session.
 *
 * Recorded before control is ceded and again after it comes back. PHASE 10 asserts they match, and
 * it is the ONLY thing that distinguishes "we handed over the running session" from "we opened a
 * second browser and hoped". Everything else in the handoff story is assertion; this is a fact
 * about two identifiers.
 */
export interface SessionIdentity {
  readonly browserContextId: string;
  readonly targetId: string;
  readonly url: string;
}
