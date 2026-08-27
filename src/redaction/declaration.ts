import type { SensitivityDeclaration } from './masking.js';

/**
 * ================================================================================================
 * WHAT A RUN TREATS AS SENSITIVE, INCLUDING THE PART IT DOES NOT KNOW UNTIL THE END.
 * ================================================================================================
 *
 * Sensitivity is DECLARED BY A HUMAN, on inputs and on outputs alike. The shape detectors in the
 * pseudonymizer are a net under that, not a substitute: a member's NAME has no recognisable shape,
 * and the only reason we know "Avery Lin" is sensitive is that somebody wrote `sensitivity: pii`
 * beside the field it comes from.
 *
 * The awkward half is that a declared-sensitive OUTPUT has no VALUE until the run has read it. So a
 * declaration made before the run can name it but cannot protect it, and the declaration has to be
 * completed once the outputs are bound - before anything is written down or printed.
 *
 * This lives in one place because it was written twice and the second copy was wrong. The replay CLI
 * completed its declaration from D73 onward; the discovery CLI did not, and the first successful
 * evidence bundle had a member's name sitting in `discovery/.../result.json`. `evidence:verify`
 * caught it. Two near-identical blocks in two CLIs is how that happens.
 */

/** The shape both a DiscoverySpec and a CapabilityArtifact expose for inputs and outputs. */
export interface DeclaredField {
  readonly name: string;
  readonly sensitivity: string;
}

export function isSensitive(field: DeclaredField): boolean {
  return field.sensitivity === 'pii' || field.sensitivity === 'secret';
}

export function declarationFor(options: {
  readonly inputs: readonly DeclaredField[];
  readonly outputs: readonly DeclaredField[];
  readonly recordIdentityParam: string;
  /** The values the run was invoked with. Known before anything happens. */
  readonly params: Readonly<Record<string, string>>;
  /**
   * The values the run READ, if it got that far. Only declared-sensitive names are taken, and only
   * strings: a currency output is stored as minor units and there is no text to search for.
   */
  readonly read?: Readonly<Record<string, unknown>> | undefined;
}): SensitivityDeclaration {
  const sensitiveNames = new Set<string>();
  for (const input of options.inputs) if (isSensitive(input)) sensitiveNames.add(input.name);
  for (const output of options.outputs) if (isSensitive(output)) sensitiveNames.add(output.name);

  const values = new Map(Object.entries(options.params));
  for (const [name, value] of Object.entries(options.read ?? {})) {
    if (sensitiveNames.has(name) && typeof value === 'string' && value !== '') {
      values.set(name, value);
    }
  }

  return { sensitiveNames, values, recordIdentityParam: options.recordIdentityParam };
}
