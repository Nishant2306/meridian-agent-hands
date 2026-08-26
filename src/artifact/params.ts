import { parseMoney } from '../types/money.js';
import { normalizeText } from '../types/normalize.js';
import type { InputDefinition } from '../types/spec.js';

/**
 * ==============================================================================================
 * [MUST] STEP 1 OF THE EXECUTION ORDER: VALIDATE EVERY CALLER PARAMETER BEFORE THE BROWSER OPENS.
 * ==============================================================================================
 *
 * A caller who passes "abc" as a five-digit member id gets INPUT_VALIDATION_FAILED and nothing
 * else happens: no browser, no session, no partially-filled form on somebody's screen. That is a
 * failure of OUR contract, caught by us, and it is a different thing from the application
 * rejecting a value we handed it (APPLICATION_VALIDATION_REJECTED).
 *
 * Getting the ORDER right is what makes the distinction real rather than decorative. Validating
 * after the browser opens still reports the right code, but it has already spent a browser launch
 * and a sign-on to say something it knew from the arguments.
 *
 * ----------------------------------------------------------------------------------------------
 * ONE VALIDATOR, TWO CALLERS. It takes DECLARED INPUTS, not an artifact.
 * ----------------------------------------------------------------------------------------------
 *
 * DiscoverySpec.inputs and CapabilityArtifact.inputs are the SAME `InputDefinitionSchema`, so this
 * function needs the input list and nothing else. That matters: discovery previously had no
 * argument check at all, and a run with `--inputs '{}'` launched a browser, signed on and spent
 * three model calls before anything noticed a required parameter was missing.
 *
 * The fix is this function called earlier, NOT a second validator that happens to agree with this
 * one today. A discovery-side copy would drift, and it would drift in the direction where the
 * recording accepts arguments that the replay of that same recording rejects.
 */
export interface ParamValidation {
  ok: boolean;
  issues: string[];
  /** Normalized, string-valued parameters. Only meaningful when ok. */
  params: Record<string, string>;
  /** Which optional parameters the caller actually supplied. Drives the step-level `when` guard. */
  supplied: Set<string>;
}

export function validateInvocationParams(
  inputs: readonly InputDefinition[],
  raw: Readonly<Record<string, unknown>>,
): ParamValidation {
  const issues: string[] = [];
  const params: Record<string, string> = {};
  const supplied = new Set<string>();

  const declaredNames = new Set(inputs.map((input) => input.name));
  for (const name of Object.keys(raw)) {
    if (!declaredNames.has(name)) {
      issues.push('"' + name + '" is not a declared input');
    }
  }

  for (const input of inputs) {
    const value = raw[input.name];

    if (value === undefined || value === null || value === '') {
      if (input.required) issues.push('"' + input.name + '" is required');
      continue;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      issues.push('"' + input.name + '" must be a string, got ' + typeof value);
      continue;
    }

    const text = normalizeText(String(value));

    if (input.type === 'enum') {
      const allowed = input.values ?? [];
      if (!allowed.includes(text)) {
        issues.push(
          '"' + input.name + '" must be one of ' + allowed.join(', ') + ', got "' + text + '"',
        );
        continue;
      }
    }

    if (input.type === 'currency' && parseMoney(text) === null) {
      issues.push('"' + input.name + '" must be an amount, got "' + text + '"');
      continue;
    }

    if (input.pattern !== undefined && !new RegExp(input.pattern).test(text)) {
      issues.push('"' + input.name + '" must match ' + input.pattern + ', got "' + text + '"');
      continue;
    }

    params[input.name] = text;
    supplied.add(input.name);
  }

  return { ok: issues.length === 0, issues, params, supplied };
}
