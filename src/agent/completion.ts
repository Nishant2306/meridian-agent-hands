import { valueMatchesParam } from '../types/normalize.js';
import type { Observation } from '../types/perception.js';
import type { DiscoverySpec } from '../types/spec.js';
import type { TargetResolver } from '../types/surface.js';
import type { OutputBinding, RecordIdentityBinding } from '../types/discovery.js';
import { bindDescriptor } from '../perception/bind.js';
import { comparableText, validateDeclaredValue } from '../artifact/outputs.js';

/**
 * ==============================================================================================
 * [MUST] THE MODEL MAY PROPOSE COMPLETION. ONLY THE SYSTEM MAY DECLARE IT.
 * ==============================================================================================
 *
 * `propose_goal_reached` does not end the run. On receipt the system:
 *
 *   1  captures a FRESH observation - not the cached one the model reasoned over
 *   2  extracts every DECLARED output from its bound source and validates it against its declared
 *      type
 *   3  re-checks the record-identity invariant against the invocation
 *
 * Step 1 is the whole point and it is why this function takes the fresh observation as an argument
 * rather than reaching for whatever is lying around. A model that has convinced itself it is
 * finished has, by construction, been reasoning over a screen that supports that conclusion. The
 * check has to look again.
 *
 * Step 2 is where the DECLARED CONTRACT does the work. `reviewStatus` is declared as an enum whose
 * only member is "PENDING REVIEW", so "the application itself reports this request as pending
 * review" is not a rule anybody wrote into the completion check - it falls out of validating the
 * output against the type a human declared for it.
 *
 * Step 3 is the one that catches the failure mode nothing else would: a run that did everything
 * correctly, on the wrong member.
 */
/**
 * Why a completion was refused, as a CODE rather than only a sentence.
 *
 * The sentence is what the model reads. The code is what the loop matches against: when a later
 * action addresses one of these, the model is told so and told to propose again. Matching on prose
 * would work until somebody improved the prose.
 */
export type CompletionReasonCode =
  | 'OUTPUT_NOT_BOUND'
  | 'OUTPUT_NOT_READABLE'
  | 'OUTPUT_INVALID'
  | 'IDENTITY_NOT_BOUND'
  | 'IDENTITY_STALE'
  | 'IDENTITY_MISMATCH'
  | 'IDENTITY_PARAM_MISSING';

export interface CompletionReason {
  code: CompletionReasonCode;
  /** The declared output this is about, when it is about one. */
  outputName?: string;
  message: string;
}

export interface CompletionResult {
  verified: boolean;
  reasons: CompletionReason[];
  outputs: Record<string, string>;
  /**
   * The identity candidate that actually resolved and matched on the fresh screen.
   *
   * Returned so the RUN RECORD keeps the binding that was proven to work on the success screen,
   * rather than whichever one the model happened to propose last. The distiller copies this
   * straight into the artifact, and replay re-checks it on the same screen - so a binding that only
   * worked on a screen the run passed through would fail every replay.
   */
  recordIdentity: RecordIdentityBinding | null;
}

export interface VerifyCompletionInput {
  fresh: Observation;
  spec: DiscoverySpec;
  outputs: readonly OutputBinding[];
  /**
   * EVERY identity the model proposed, in the order it proposed them - not just the last one.
   *
   * [MUST] LAST-WRITE-WINS WAS A DEFECT, and an expensive one. A real run bound the identity to the
   * Member Record cell (which resolves on the review screen), then rebound it to a summary line on
   * the New Sub-Account form (which does not), and the completion check refused a run that had
   * everything right. See DECISIONS.md D80.
   *
   * The obvious alternative - refuse a replacement that does not resolve where the first one did -
   * does not fix it. In that run the FIRST binding did not resolve on the form screen either, so
   * the replacement would have been accepted on its merits. The screen a binding is checked on is
   * not the screen it is made on, and nothing at bind time knows which screen that will be. So the
   * choice is deferred to here, where the fresh observation is in hand.
   */
  recordIdentityCandidates: readonly RecordIdentityBinding[];
  runtimeInputs: Readonly<Record<string, string>>;
  resolver: TargetResolver;
}

export function verifyCompletion(input: VerifyCompletionInput): CompletionResult {
  const reasons: CompletionReason[] = [];
  const extracted: Record<string, string> = {};

  // 2. Every declared output, extracted from the FRESH screen and validated against its type.
  for (const declared of input.spec.outputs) {
    const binding = input.outputs.find((candidate) => candidate.name === declared.name);
    if (binding === undefined) {
      if (declared.required) {
        reasons.push({
          code: 'OUTPUT_NOT_BOUND',
          outputName: declared.name,
          message:
            'output "' +
            declared.name +
            '" is required but was never bound. Call read_value on the ' +
            'control that displays it.',
        });
      }
      continue;
    }

    const resolution = input.resolver.resolve(
      input.fresh,
      bindDescriptor(binding.target, input.runtimeInputs),
    );
    if (!resolution.ok) {
      reasons.push({
        code: 'OUTPUT_NOT_READABLE',
        outputName: declared.name,
        message:
          'output "' +
          declared.name +
          '" could not be read from the current screen: ' +
          resolution.detail,
      });
      continue;
    }

    const validated = validateDeclaredValue(declared, comparableText(resolution.control));
    if (!validated.ok) {
      reasons.push({
        code: 'OUTPUT_INVALID',
        outputName: declared.name,
        message: validated.reason,
      });
      continue;
    }
    extracted[declared.name] = validated.value;
  }

  // 3. The record identity. The SYSTEM checks this; the model is never asked to confirm it.
  const declaredParam = input.spec.recordIdentity.param;
  const expected = input.runtimeInputs[declaredParam];
  let chosenIdentity: RecordIdentityBinding | null = null;

  if (input.recordIdentityCandidates.length === 0) {
    reasons.push({
      code: 'IDENTITY_NOT_BOUND',
      message:
        'the record identity was never bound. Call propose_record_identity on the control that ' +
        'displays the identity of the record you were asked to operate on.',
    });
  } else if (expected === undefined) {
    reasons.push({
      code: 'IDENTITY_PARAM_MISSING',
      message: 'no value was supplied for the record identity parameter "' + declaredParam + '"',
    });
  } else {
    const shape = input.spec.inputs.find((declared) => declared.name === declaredParam) ?? {
      type: 'string' as const,
    };

    // Every candidate, against THIS screen. One that does not resolve here is not evidence of
    // anything - it describes a control on a screen the run has left.
    const resolvedHere: { binding: RecordIdentityBinding; shown: string }[] = [];
    for (const candidate of input.recordIdentityCandidates) {
      const resolution = input.resolver.resolve(
        input.fresh,
        bindDescriptor(candidate.target, input.runtimeInputs),
      );
      if (resolution.ok) {
        resolvedHere.push({ binding: candidate, shown: comparableText(resolution.control) });
      }
    }

    const matching = resolvedHere.filter((entry) =>
      valueMatchesParam(entry.shown, expected, shape),
    );

    if (matching.length > 0) {
      // ============================================================================================
      // ONE MATCH IS ENOUGH, AND THAT IS NOT THE SAME AS GUESSING.
      // ============================================================================================
      //
      // A control the model designated as the identity, which resolves on THIS screen and shows the
      // requested value under the declared type's own comparison, is positive proof that this screen
      // is about the requested record. Formatting is already absorbed there: a declared digits-only
      // pattern makes "Member Name: Avery Lin (10001)" normalize to "10001" and match, while
      // "100011" fails the pattern after stripping and is compared as text, so it does not.
      //
      // A candidate that resolves and does NOT match is therefore a genuinely different value. This
      // does not fail the check when another candidate matches, and that is a deliberate limit: the
      // question is "is this screen about the requested record", and a control elsewhere on the page
      // showing a different id - a related account, a previous member - is not evidence that it is
      // not. The mismatch branch below fires when NOTHING matches, and it lists every control that
      // resolved, so the disagreement is visible either way.
      //
      // The first match is kept rather than the last: the model's earlier bindings are the ones it
      // made while it was looking at the record, before it moved on.
      chosenIdentity = matching[0]?.binding ?? null;
    } else if (resolvedHere.length === 0) {
      // [MUST] STALE, NOT ABSENT. The identity may be right there on the screen in a control the
      // model has not designated. Saying "not visible" sends it looking for something missing.
      const screens = [
        ...new Set(input.recordIdentityCandidates.map((candidate) => candidate.screenName)),
      ];
      reasons.push({
        code: 'IDENTITY_STALE',
        message:
          'the record identity binding is STALE, not missing. It was bound on ' +
          (screens.length === 1
            ? 'screen "' + screens[0] + '"'
            : 'screens ' + screens.map((name) => '"' + name + '"').join(', ')) +
          ' and that control is not on "' +
          input.fresh.screenIdentity.canonicalScreenName +
          '". The identity may well be displayed here in a different control: call ' +
          'propose_record_identity again on the control that shows ' +
          declaredParam +
          ' ON THIS SCREEN.',
      });
    } else {
      reasons.push({
        code: 'IDENTITY_MISMATCH',
        message:
          'THE RECORD ON SCREEN IS NOT THE RECORD THAT WAS REQUESTED. ' +
          declaredParam +
          ' is "' +
          expected +
          '" and the bound identity control' +
          (resolvedHere.length === 1 ? ' shows ' : 's show ') +
          resolvedHere.map((entry) => '"' + entry.shown + '"').join(', ') +
          '.',
      });
    }
  }

  return {
    verified: reasons.length === 0,
    reasons,
    outputs: extracted,
    recordIdentity: chosenIdentity,
  };
}
