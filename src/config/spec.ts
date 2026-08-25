import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { DiscoverySpecSchema, type DiscoverySpec } from '../types/spec.js';
import { contentHashOf } from './canonical.js';

/**
 * specHash - SHA-256 of the canonical serialization of the DiscoverySpec.
 *
 * It exists to answer one question that nothing else answers: WHICH DECLARED CONTRACT was this
 * artifact built against? The three identifiers are distinct and none substitutes for another:
 *
 *     specHash        which declared contract the artifact was built against
 *     discoveryRunId  which run produced it
 *     contentHash     what the artifact itself says
 *
 * The hash is taken over the PARSED, VALIDATED, CANONICALIZED spec rather than the raw file bytes.
 * Reformatting the YAML or editing a comment therefore does not change the contract's identity,
 * while any semantic change does. Raw-byte hashing would make whitespace a breaking change.
 */
export function specHash(spec: DiscoverySpec): string {
  return contentHashOf(spec);
}

export interface LoadedSpec {
  spec: DiscoverySpec;
  specHash: string;
  sourcePath: string;
}

export function parseDiscoverySpec(yamlText: string, sourcePath: string): LoadedSpec {
  const raw: unknown = parseYaml(yamlText);
  const parsed = DiscoverySpecSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid DiscoverySpec at ${sourcePath}:\n${detail}`);
  }
  return { spec: parsed.data, specHash: specHash(parsed.data), sourcePath };
}

export function loadDiscoverySpec(filePath: string): LoadedSpec {
  return parseDiscoverySpec(readFileSync(filePath, 'utf8'), filePath);
}
