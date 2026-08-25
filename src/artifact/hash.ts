import { contentHashOf } from '../config/canonical.js';
import type { CapabilityArtifact } from './schema.js';

/**
 * ==============================================================================================
 * [MUST] contentHash EXCLUDES status/approvedAt/approvedBy, AND NOTHING ELSE.
 * ==============================================================================================
 *
 * It INCLUDES the profile pins, because "which safety rules govern this capability" is part of
 * what the capability means. A hash that skipped them would let an artifact be re-pointed at a
 * different safety profile without moving its identity, which is the exact substitution the pin
 * exists to prevent.
 *
 * The consequence is the property PHASE 10 provenance chain is built on: the content hash of the
 * distilled draft and the content hash of the approved artifact are IDENTICAL. Approval is not a
 * transformation. It is a signature on something that did not change.
 */
export const HASH_EXCLUDED_FIELDS = ['status', 'approvedAt', 'approvedBy'] as const;

export function hashableContent(artifact: CapabilityArtifact): Record<string, unknown> {
  const excluded = new Set<string>(HASH_EXCLUDED_FIELDS);
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(artifact)) {
    if (excluded.has(key)) continue;
    content[key] = value;
  }
  return content;
}

export function contentHash(artifact: CapabilityArtifact): string {
  return contentHashOf(hashableContent(artifact));
}
