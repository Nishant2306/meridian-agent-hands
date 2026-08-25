import { z } from 'zod';
import { SurfaceActionSchema } from '../types/action.js';
import { AssertionSchema } from '../types/assertion.js';
import { TargetDescriptorSchema } from '../types/control.js';
import { DeclaredOutputSchema, InputDefinitionSchema } from '../types/spec.js';
import { RiskClassSchema } from '../types/risk.js';
import { PolicyLimitsSchema } from './profiles.js';

/**
 * ==============================================================================================
 * THREE VERSIONS, THREE DIFFERENT QUESTIONS. Do not collapse them.
 * ==============================================================================================
 *
 *   schemaVersion              "What shape is this FILE?" Owned by us. Bumping it means every
 *                              reader has to be taught the new shape. Nothing about the banking
 *                              application changed.
 *
 *   capabilityVersion (semver) "Which revision of THIS CAPABILITY is this?" Owned by whoever
 *                              distils it. MINOR when the path or the locators changed; MAJOR when
 *                              the input or output contract changed, because a caller written
 *                              against the old one will now break.
 *
 *   target.compatibility       "Which versions of THE APPLICATION is this known to work against?"
 *     .versionRange            Owned by the vendor, not by us. It moves when MERIDIAN ships a
 *                              release, entirely independently of the two above.
 *
 * Collapsing any pair of these produces a version number that cannot answer either question. The
 * common mistake is folding compatibility into capabilityVersion, which then forces a capability
 * bump every time the vendor patches something that did not affect us.
 */
export const SCHEMA_VERSION = 1;

/**
 * ==============================================================================================
 * [MUST] STATES, AND WHAT MUTUAL EXCLUSIVITY ACTUALLY REQUIRES
 * ==============================================================================================
 *
 * A state is "a place the run can be", described by assertions rather than by a step index. That
 * matters because a run may arrive at a state by a path nobody recorded: automation did it, or a
 * person did it during a handoff, or a recovery re-entered it from the side.
 *
 * Three kinds of assertion, and the difference is the whole design:
 *
 *   screenAssertions  WHICH SCREEN this is. Identity.
 *   qualifiers        WHAT IS TRUE ON IT beyond identity. "the form is filled in correctly".
 *   invariants        Must hold whenever we are in this state, and hold BOTH BEFORE AND AFTER
 *                     every step taken from it. An invariant is not a transition.
 *
 * RULE: only RESUME-ELIGIBLE states must be mutually exclusive. A non-resumable state is allowed to
 * be a strict prefix of a resumable one - `subaccount-form` matches every observation that
 * `subaccount-form-complete` matches - and that is harmless, because nothing ever has to CHOOSE
 * between them. Resumption is the only moment where an ambiguous answer would be acted on.
 *
 * Consequence, and it is the correct one: a HALF-FILLED form matches no resumable state. The run
 * goes back to a human instead of guessing which half of the work was already done.
 *
 * Mutual exclusivity cannot be proven statically - two assertion sets are not comparable as text.
 * It is checked by the distiller against the OBSERVATIONS THE DISCOVERY RUN ACTUALLY PRODUCED.
 * See checkResumeEligibleExclusivity in src/artifact/validate.ts.
 */
export const StateSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  screenAssertions: z.array(AssertionSchema),
  qualifiers: z.array(AssertionSchema),
  invariants: z.array(AssertionSchema),
  resumeEligible: z.boolean(),
});
export type State = z.infer<typeof StateSchema>;

/**
 * ==============================================================================================
 * [MUST] OUTPUTS: THE HUMAN DECLARES *WHAT*, DISCOVERY RECORDS *WHERE*.
 * ==============================================================================================
 *
 * `DeclaredOutput` came from the spec: the name, the type, the sensitivity, whether it is required.
 * `source` is the half discovery contributes: which STATE the value is visible in, which control
 * holds it, and how to parse it.
 *
 * The output belongs to a STATE, not to a step position. That is what keeps extraction valid when
 * automation reached the state, when a HUMAN reached it during a handoff, or when a recovery made
 * the step sequence different from the recorded one. An output pinned to "whatever step 8 touched"
 * is wrong in all three cases.
 *
 * recordIdentity is bound the same way, for the same reason.
 */
export const ArtifactOutputSchema = DeclaredOutputSchema.extend({
  source: z.object({
    stateId: z.string().min(1),
    target: TargetDescriptorSchema,
    parse: z.enum(['text', 'currency', 'integer']),
    pattern: z.string().min(1).optional(),
  }),
});
export type ArtifactOutput = z.infer<typeof ArtifactOutputSchema>;

/**
 * ==============================================================================================
 * [MUST] A STEP DISTINGUISHES EFFECTS FROM INVARIANTS.
 * ==============================================================================================
 *
 *   expectedEffects  proof that THIS ACTION changed the relevant state. For a mutating step at
 *                    least one of these must be DISCRIMINATING: false before the action, true
 *                    after. The distiller enforces that against the real observations.
 *
 *   invariants       must hold BEFORE AND AFTER. An invariant is not a transition, and a check
 *                    that is required to flip from false to true is an effect wearing the wrong
 *                    label. The distiller rejects that too.
 *
 * WHY A DISCRIMINATING EFFECT, AND WHAT IT DOES NOT PROVE. A false-to-true flip is EVIDENCE, not
 * proof of causality: something else on the page could have caused it. We require it anyway,
 * because its ABSENCE is conclusive in the direction that matters. If nothing changed, the action
 * did nothing - and "the click was swallowed by a modal" is the single most common way legacy UI
 * automation silently does nothing and reports success.
 *
 * A read or extract step needs no transition at all. What it needs is that the source exists and
 * that the value parses.
 */
export const StepSchema = z.object({
  id: z.string().min(1),
  /** Why this step exists, in a sentence a reviewer can check against the action. */
  intent: z.string().min(1),
  action: SurfaceActionSchema,
  fromState: z.string().min(1).optional(),
  toState: z.string().min(1).optional(),
  expectedEffects: z.array(AssertionSchema),
  invariants: z.array(AssertionSchema),
  wait: z.object({
    timeoutMs: z.number().int().positive(),
    pollMs: z.number().int().positive(),
  }),
  risk: RiskClassSchema,
  /**
   * fail                      stop the run and report.
   * escalate                  hand to a human on the same live session.
   * try_recoveries_then_fail  attempt the profile recoveries first, then fail.
   */
  onFailure: z.enum(['fail', 'escalate', 'try_recoveries_then_fail']),
  retries: z.object({
    max: z.number().int().nonnegative(),
    /** Explicit per-attempt delays. A recorded, bounded backoff, never an open-ended sleep. */
    backoffMs: z.array(z.number().int().nonnegative()),
  }),
  notes: z.string().min(1).optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const ProfilePinSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  /**
   * SEMANTIC CONTENT, not approval metadata. It is INCLUDED in the artifact content hash, because
   * "which safety rules govern this capability" is part of what the capability means.
   */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ProfilePin = z.infer<typeof ProfilePinSchema>;

export const PreconditionSchema = z.object({
  description: z.string().min(1),
  check: AssertionSchema,
});
export type Precondition = z.infer<typeof PreconditionSchema>;

export const FingerprintSchema = z.object({
  kind: z.literal('text'),
  expected: z.string().min(1),
});

/**
 * PROVENANCE.
 *
 * [MUST] `goalTemplate` only. There is NO rendered goal and NO goalDigest.
 *
 * A SHA-256 of a rendered goal is brute-forceable: a hundred thousand five-digit member ids against
 * a known template is seconds of work, so a "digest" of "...member 10001..." is a member id written
 * down in a costume. Traceability is already complete without it: discoveryRunId says which run,
 * specHash says which declared contract, the content hash says what the artifact says, and model
 * plus promptVersion say what produced it.
 */
export const ProvenanceSchema = z.object({
  discoveryRunId: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  goalTemplate: z.string().min(1),
  specHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().min(1),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * ==============================================================================================
 * THE CAPABILITY ARTIFACT.
 * ==============================================================================================
 *
 * It is assembled from THREE sources, and removing any one leaves something that is not a
 * capability:
 *
 *     declared contract  +  observed successful path  +  pinned condition profile
 *
 * Without the contract it is a macro. Without the observed path it is a wish. Without the pinned
 * profile it is unverifiable.
 *
 * DELIBERATELY NOT IN v1, and not to be added without a schemaVersion bump: tenant overrides,
 * locator stability scores, automatic demotion, an evidence policy, and any approval workflow
 * beyond a single status flip.
 */
export const CapabilityArtifactSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    capabilityId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    capabilityVersion: z.string().regex(/^\d+\.\d+\.\d+$/),

    /**
     * THE ONLY THREE FIELDS EXCLUDED FROM THE CONTENT HASH.
     *
     * Approval changes these and nothing else, which is what makes the content hash of the
     * distilled draft and the approved artifact BYTE-IDENTICAL. The provenance chain in PHASE 10
     * depends on exactly that.
     */
    status: z.enum(['draft', 'approved']),
    approvedAt: z.string().min(1).optional(),
    approvedBy: z.string().min(1).optional(),

    target: z.object({
      product: z.string().min(1),
      surfaceKind: z.literal('legacy_web'),
      entryPoint: z.string().min(1),
      compatibility: z.object({ versionRange: z.string().min(1) }),
      /**
       * Checked against the live screen before the first step. Note it is deliberately the
       * TRUNCATED version string: a patch release of the vendor product should not fail a
       * capability that never touched anything the patch changed.
       */
      fingerprint: z.array(FingerprintSchema).min(1),
    }),

    inputs: z.array(InputDefinitionSchema).min(1),
    outputs: z.array(ArtifactOutputSchema).min(1),

    /** Declared in the spec (which param means identity); BOUND here (where it is displayed). */
    recordIdentity: z.object({
      param: z.string().min(1),
      target: TargetDescriptorSchema,
    }),

    preconditions: z.array(PreconditionSchema),
    states: z.array(StateSchema).min(1),
    steps: z.array(StepSchema).min(1),
    successState: z.string().min(1),

    profiles: z.object({
      condition: ProfilePinSchema,
      safety: ProfilePinSchema,
    }),

    /** The capability layer of the policy. May be STRICTER than global. Never weaker. */
    policy: PolicyLimitsSchema,

    /**
     * CAPABILITY-SPECIFIC ADDITIONS ONLY.
     *
     * The effective set is: GLOBAL ENGINE + PINNED CONDITION PROFILE + these. Anything the profile
     * already covers must NOT be repeated here; a duplicated detector is a second place to keep in
     * step with the first. Empty arrays are the normal case and mean "the profile covers it".
     */
    knownOutcomes: z.array(z.string().min(1)),
    recoveries: z.array(z.string().min(1)),
    hardFailures: z.array(z.string().min(1)),

    provenance: ProvenanceSchema,
  })
  .superRefine((artifact, ctx) => {
    const stateIds = new Set(artifact.states.map((state) => state.id));

    if (!stateIds.has(artifact.successState)) {
      ctx.addIssue({
        code: 'custom',
        message: 'successState "' + artifact.successState + '" is not a declared state',
      });
    }

    for (const step of artifact.steps) {
      for (const [field, value] of [
        ['fromState', step.fromState],
        ['toState', step.toState],
      ] as const) {
        if (value !== undefined && !stateIds.has(value)) {
          ctx.addIssue({
            code: 'custom',
            message: 'step "' + step.id + '" ' + field + ' "' + value + '" is not a declared state',
          });
        }
      }
    }

    for (const output of artifact.outputs) {
      if (!stateIds.has(output.source.stateId)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'output "' +
            output.name +
            '" is sourced from state "' +
            output.source.stateId +
            '", which is not declared',
        });
      }
    }

    const inputNames = new Set(artifact.inputs.map((input) => input.name));
    if (!inputNames.has(artifact.recordIdentity.param)) {
      ctx.addIssue({
        code: 'custom',
        message: 'recordIdentity.param "' + artifact.recordIdentity.param + '" is not an input',
      });
    }
  });
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
