import { createHash } from 'node:crypto';

/**
 * Canonical serialization - the single definition of "what these bytes mean" used by every hash in
 * this project: specHash now, and profile hashes and the artifact content hash from PHASE 3 on.
 *
 * Rules:
 *   - object keys are sorted (byte order, not locale order)
 *   - `undefined` properties are dropped, so an absent optional and an explicitly-undefined one
 *     hash identically
 *   - array ORDER IS PRESERVED - order is meaning for a sequence of actions
 *   - non-finite numbers, functions and symbols are rejected loudly rather than coerced
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function canonicalize(value: unknown): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`cannot canonicalize non-finite number: ${String(value)}`);
      }
      return value;
    case 'undefined':
      throw new TypeError('cannot canonicalize undefined at the top level');
    case 'object':
      break;
    default:
      throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  const source = value as Record<string, unknown>;
  const result: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    result[key] = canonicalize(entry);
  }
  return result;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 of the canonical serialization of a value. */
export function contentHashOf(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
