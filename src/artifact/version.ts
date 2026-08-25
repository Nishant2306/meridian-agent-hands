import { contentHashOf } from '../config/canonical.js';
import type { CapabilityArtifact } from './schema.js';

/**
 * ==============================================================================================
 * WHAT KIND OF CHANGE IS THIS?
 * ==============================================================================================
 *
 *   MAJOR  the INPUT or OUTPUT contract moved. A caller written against the previous version will
 *          break, whether or not anyone told them.
 *   MINOR  the path, the locators, the assertions or the policy moved. The contract is unchanged,
 *          so an existing caller keeps working.
 *   NONE   nothing that the content hash covers changed.
 *
 * The distinction is not cosmetic. It is the difference between "redeploy at your convenience" and
 * "every caller of this capability needs to be looked at".
 */
export type ChangeKind = 'major' | 'minor' | 'none';

export interface ChangeClassification {
  kind: ChangeKind;
  reasons: string[];
}

function contractOf(artifact: CapabilityArtifact): unknown {
  return {
    inputs: artifact.inputs,
    // Only the DECLARED half of an output is contract. `source` is where discovery found the value,
    // and moving it is a locator change, not a contract change.
    outputs: artifact.outputs.map((output) => ({
      name: output.name,
      type: output.type,
      values: output.values,
      sensitivity: output.sensitivity,
      required: output.required,
      when: output.when,
    })),
    recordIdentityParam: artifact.recordIdentity.param,
  };
}

function pathOf(artifact: CapabilityArtifact): unknown {
  return {
    steps: artifact.steps,
    states: artifact.states,
    preconditions: artifact.preconditions,
    successState: artifact.successState,
    outputSources: artifact.outputs.map((output) => output.source),
    recordIdentityTarget: artifact.recordIdentity.target,
    policy: artifact.policy,
    profiles: artifact.profiles,
    target: artifact.target,
  };
}

export function classifyChange(
  previous: CapabilityArtifact,
  next: CapabilityArtifact,
): ChangeClassification {
  const reasons: string[] = [];

  const contractChanged = contentHashOf(contractOf(previous)) !== contentHashOf(contractOf(next));
  const pathChanged = contentHashOf(pathOf(previous)) !== contentHashOf(pathOf(next));

  if (contractChanged) reasons.push('the input or output contract changed');
  if (pathChanged) reasons.push('the observed path, locators, policy or profile pins changed');

  if (contractChanged) return { kind: 'major', reasons };
  if (pathChanged) return { kind: 'minor', reasons };
  return { kind: 'none', reasons: ['nothing covered by the content hash changed'] };
}

export function parseVersion(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => Number(part));
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error('not a semver version: ' + version);
  }
  return [major, minor, patch];
}

export function nextVersion(previous: string, kind: ChangeKind): string {
  const [major, minor, patch] = parseVersion(previous);
  if (kind === 'major') return major + 1 + '.0.0';
  if (kind === 'minor') return major + '.' + (minor + 1) + '.0';
  return major + '.' + minor + '.' + patch;
}
