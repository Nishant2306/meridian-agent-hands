import { bindDescriptor } from '../perception/bind.js';
import { parseMoney } from '../types/money.js';
import { normalizeText } from '../types/normalize.js';
import type { Observation, PerceivedControl } from '../types/perception.js';
import type { DeclaredOutput } from '../types/spec.js';
import type { TargetDescriptor } from '../types/control.js';
import type { TargetResolver } from '../types/surface.js';

/**
 * Extracting a declared output from a screen, and validating it against the type a HUMAN declared.
 *
 * ONE implementation, used by discovery's completion check and by replay. That matters more than
 * it looks: if the two disagreed, a run could be declared complete at discovery time on evidence
 * replay would later reject, and the capability would be born broken.
 *
 * It lives in /artifact rather than /agent because REPLAY MUST NOT IMPORT /agent. Putting shared
 * logic in the package both sides already depend on is what keeps that boundary from becoming a
 * duplicated function.
 */
export function comparableText(control: PerceivedControl): string {
  return control.value !== undefined && control.value !== '' ? control.value : control.name;
}

export type OutputExtraction = { ok: true; value: string } | { ok: false; reason: string };

export function validateDeclaredValue(declared: DeclaredOutput, raw: string): OutputExtraction {
  const value = normalizeText(raw);
  if (value === '') return { ok: false, reason: 'output "' + declared.name + '" read back empty' };

  if (declared.type === 'enum') {
    const allowed = declared.values ?? [];
    if (!allowed.includes(value)) {
      return {
        ok: false,
        reason:
          'output "' +
          declared.name +
          '" read back "' +
          value +
          '", which is not one of its ' +
          'declared values (' +
          allowed.join(', ') +
          ')',
      };
    }
  }

  if (declared.type === 'currency' && parseMoney(value) === null) {
    return {
      ok: false,
      reason: 'output "' + declared.name + '" read back "' + value + '", which is not an amount',
    };
  }

  return { ok: true, value };
}

export function extractDeclaredOutput(options: {
  declared: DeclaredOutput;
  target: TargetDescriptor;
  observation: Observation;
  params: Readonly<Record<string, string>>;
  resolver: TargetResolver;
}): OutputExtraction {
  const resolution = options.resolver.resolve(
    options.observation,
    bindDescriptor(options.target, options.params),
  );
  if (!resolution.ok) {
    return {
      ok: false,
      reason:
        'output "' +
        options.declared.name +
        '" could not be read from the current screen: ' +
        resolution.detail,
    };
  }
  return validateDeclaredValue(options.declared, comparableText(resolution.control));
}
