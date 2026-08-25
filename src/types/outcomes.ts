import { z } from 'zod';

/**
 * ============================================================================================
 * [MUST] THE TWO TAXONOMIES. DO NOT MERGE THEM.
 * ============================================================================================
 *
 * A BusinessOutcome is a legitimate domain answer. The automation worked correctly and the answer
 * is "there is no such member". That is not an error, it is the result. Merging the two hierarchies
 * is how an on-call engineer ends up paged at 03:00 because a teller typed a member ID that does
 * not exist.
 *
 * NOTE, EXPLICITLY: there is no RECORD_NOT_FOUND *error*. A missing record is a business outcome
 * (MEMBER_NOT_FOUND). If you find yourself reaching for an error code because a record was absent,
 * you are in the wrong hierarchy.
 */
export const BusinessOutcomeCodeSchema = z.enum(['MEMBER_NOT_FOUND', 'NO_ELIGIBLE_ACCOUNTS']);
export type BusinessOutcomeCode = z.infer<typeof BusinessOutcomeCodeSchema>;

/**
 * An Error is a failure of the automation, the surface, the contract, or the guardrails.
 * Each code exists because it implies a DIFFERENT REMEDIATION. If two codes would be handled
 * identically by both a caller and an operator, they should not be two codes.
 */
export const ErrorCodeSchema = z.enum([
  // -- contract ------------------------------------------------------------------------------
  /** Our own contract rejected the caller's params, before a browser was ever touched. */
  'INPUT_VALIDATION_FAILED',
  /**
   * The APPLICATION rejected a UI transition because the submitted form data was invalid
   * (Continue -> review). Distinct from INPUT_VALIDATION_FAILED: our contract accepted the value,
   * the app did not. Note we never submit the request itself.
   */
  'APPLICATION_VALIDATION_REJECTED',

  // -- availability --------------------------------------------------------------------------
  /** The application answered badly: 5xx, error page, failed load. Retry may help. */
  'APPLICATION_UNAVAILABLE',
  /** The browser or driven process died. Different remediation from a 5xx: restart the surface. */
  'SURFACE_UNAVAILABLE',

  // -- session and preconditions ---------------------------------------------------------------
  'PERMISSION_DENIED',
  'SESSION_EXPIRED',
  'PRECONDITION_FAILED',

  // -- perception and resolution ---------------------------------------------------------------
  'CONTROL_NOT_FOUND',
  'AMBIGUOUS_CONTROL',
  'LOCATOR_CONFLICT',

  // -- effect and invariants -------------------------------------------------------------------
  'EFFECT_NOT_OBSERVED',
  'INVARIANT_VIOLATED',
  'OUTPUT_PARSE_ERROR',

  // -- guardrails ------------------------------------------------------------------------------
  'POLICY_BLOCKED',
  'ALLOWLIST_VIOLATION',
  'LEASE_VIOLATION',

  // -- budgets and integrity ---------------------------------------------------------------------
  'TIMEOUT',
  'MAX_STEPS_EXCEEDED',
  'FINGERPRINT_MISMATCH',
  'PROFILE_INTEGRITY_FAILURE',

  'UNKNOWN',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * ============================================================================================
 * [MUST] A THIRD, SEPARATE TYPE - internal to discovery. NOT an ErrorCode.
 * ============================================================================================
 *
 * A proposal rejection is a CONVERSATIONAL event: the model proposed something we will not do, we
 * send it feedback, and THE DISCOVERY LOOP CONTINUES. It is not a terminal run failure.
 *
 * Keeping it out of ErrorCode is deliberate. If STALE_OBSERVATION_CONTEXT were an ErrorCode, then
 * every dashboard, every log filter and every alert rule would count a recovered, expected,
 * self-healing event as a run-ending error - and the error rate for a healthy system would be
 * dominated by things that never failed.
 *
 * Add more codes here only when the implementation actually needs them.
 */
export const ProposalRejectionCodeSchema = z.enum(['STALE_OBSERVATION_CONTEXT']);
export type ProposalRejectionCode = z.infer<typeof ProposalRejectionCodeSchema>;

/** Compile-time proof that the taxonomies stay disjoint. */
export type _NoOverlapBusinessAndError =
  Extract<BusinessOutcomeCode, ErrorCode> extends never ? true : never;
export type _NoOverlapRejectionAndError =
  Extract<ProposalRejectionCode, ErrorCode> extends never ? true : never;
