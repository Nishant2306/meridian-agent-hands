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
export interface CompletionResult {
  verified: boolean;
  reasons: string[];
  outputs: Record<string, string>;
}

export interface VerifyCompletionInput {
  fresh: Observation;
  spec: DiscoverySpec;
  outputs: readonly OutputBinding[];
  recordIdentity: RecordIdentityBinding | null;
  runtimeInputs: Readonly<Record<string, string>>;
  resolver: TargetResolver;
}

export function verifyCompletion(input: VerifyCompletionInput): CompletionResult {
  const reasons: string[] = [];
  const extracted: Record<string, string> = {};

  // 2. Every declared output, extracted from the FRESH screen and validated against its type.
  for (const declared of input.spec.outputs) {
    const binding = input.outputs.find((candidate) => candidate.name === declared.name);
    if (binding === undefined) {
      if (declared.required) {
        reasons.push(
          'output "' +
            declared.name +
            '" is required but was never bound. Call read_value on the ' +
            'control that displays it.',
        );
      }
      continue;
    }

    const resolution = input.resolver.resolve(
      input.fresh,
      bindDescriptor(binding.target, input.runtimeInputs),
    );
    if (!resolution.ok) {
      reasons.push(
        'output "' +
          declared.name +
          '" could not be read from the current screen: ' +
          resolution.detail,
      );
      continue;
    }

    const validated = validateDeclaredValue(declared, comparableText(resolution.control));
    if (!validated.ok) {
      reasons.push(validated.reason);
      continue;
    }
    extracted[declared.name] = validated.value;
  }

  // 3. The record identity. The SYSTEM checks this; the model is never asked to confirm it.
  const identity = input.recordIdentity;
  const declaredParam = input.spec.recordIdentity.param;
  if (identity === null) {
    reasons.push(
      'the record identity was never bound. Call propose_record_identity on the control that ' +
        'displays the identity of the record you were asked to operate on.',
    );
  } else {
    const expected = input.runtimeInputs[declaredParam];
    const resolution = input.resolver.resolve(
      input.fresh,
      bindDescriptor(identity.target, input.runtimeInputs),
    );

    if (expected === undefined) {
      reasons.push(
        'no value was supplied for the record identity parameter "' + declaredParam + '"',
      );
    } else if (!resolution.ok) {
      reasons.push(
        'the record identity is not visible on the current screen: ' + resolution.detail,
      );
    } else {
      const shown = comparableText(resolution.control);
      const shape = input.spec.inputs.find((declared) => declared.name === declaredParam) ?? {
        type: 'string' as const,
      };
      if (!valueMatchesParam(shown, expected, shape)) {
        reasons.push(
          'THE RECORD ON SCREEN IS NOT THE RECORD THAT WAS REQUESTED. The screen shows "' +
            shown +
            '" where ' +
            declaredParam +
            ' is "' +
            expected +
            '".',
        );
      }
    }
  }

  return { verified: reasons.length === 0, reasons, outputs: extracted };
}
