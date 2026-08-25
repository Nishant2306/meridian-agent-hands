import { z } from 'zod';

/**
 * ==============================================================================================
 * [MUST] HOLDING A TOKEN *IS* THE CAPABILITY TO ACT. THERE IS NO AMBIENT PERMISSION.
 * ==============================================================================================
 *
 * Every software-issued action carries a lease token. No token, no action; wrong token, no action.
 * This is what makes "only one actor may act at a time" enforceable rather than aspirational.
 *
 * HONESTY (state it plainly in REPORT.md): the lease enforces mutual exclusion for SOFTWARE-issued
 * actions and coordinates the pause/cede/resume protocol. In the headed-browser transport, a human
 * moving the real mouse is OUT OF BAND and no lease can stop them. That is a property of driving a
 * visible browser, not a gap we can close with a stronger token.
 */
export const LeaseOwnerSchema = z.enum(['AUTOMATION', 'HUMAN']);
export type LeaseOwner = z.infer<typeof LeaseOwnerSchema>;

export const LeaseTokenSchema = z.object({
  leaseId: z.string().min(1),
  owner: LeaseOwnerSchema,
  /** Epoch milliseconds. */
  expiresAt: z.number().int().positive(),
});
export type LeaseToken = z.infer<typeof LeaseTokenSchema>;

/**
 * The session state machine.
 *
 *   AUTOMATION_RUNNING -> PAUSING -> HUMAN_CONTROL -> RESUME_VALIDATION
 *
 * [MUST] COMPLETED is reachable from RESUME_VALIDATION. While the human held control they may
 * already have reached the success state themselves. The system does not take their word for it:
 * on resume it RE-OBSERVES and decides. That is the same rule that binds the model, applied to a
 * person.
 *
 * There is deliberately NO COMPLETED_BY_HUMAN transition and no `completionMode: 'human'`. Only
 * the system declares success, and it declares it from what it can see, not from what it is told.
 */
export const SessionStateSchema = z.enum([
  'AUTOMATION_RUNNING',
  'PAUSING',
  'HUMAN_CONTROL',
  'RESUME_VALIDATION',
  'COMPLETED',
  'FAILED',
  'ABORTED',
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * Every legal edge, exhaustively. Anything absent from this table throws.
 *
 * PAUSING has exactly one exit on purpose: a pause either completes into HUMAN_CONTROL or the
 * session is stuck, and "stuck" should be visible as a stuck PAUSING state rather than laundered
 * into FAILED by a transition nobody asked for. PHASE 8 owns the pause timeout and will add the
 * edge it actually needs, deliberately.
 */
export const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  AUTOMATION_RUNNING: ['PAUSING', 'COMPLETED', 'FAILED'],
  PAUSING: ['HUMAN_CONTROL'],
  HUMAN_CONTROL: ['RESUME_VALIDATION', 'ABORTED'],
  RESUME_VALIDATION: ['COMPLETED', 'AUTOMATION_RUNNING', 'HUMAN_CONTROL', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  ABORTED: [],
};

export const TERMINAL_SESSION_STATES: readonly SessionState[] = ['COMPLETED', 'FAILED', 'ABORTED'];

export function isTerminalSessionState(state: SessionState): boolean {
  return TERMINAL_SESSION_STATES.includes(state);
}

/** Which owner may issue SOFTWARE actions in a given state. Nobody may act in a terminal state. */
export const STATE_ALLOWS_ACTOR: Readonly<Record<SessionState, LeaseOwner | null>> = {
  AUTOMATION_RUNNING: 'AUTOMATION',
  PAUSING: null,
  HUMAN_CONTROL: 'HUMAN',
  RESUME_VALIDATION: 'AUTOMATION',
  COMPLETED: null,
  FAILED: null,
  ABORTED: null,
};
