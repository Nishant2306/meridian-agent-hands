import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyProfilePins } from '../src/artifact/approve.js';
import { CapabilityArtifactSchema } from '../src/artifact/schema.js';
import { validateArtifactStructure } from '../src/artifact/validate.js';
import { jsoncToJson } from './helpers/jsonc.js';

const REPO = new URL('..', import.meta.url);
const SCHEMA_DOC = fileURLToPath(new URL('docs/SCHEMA.md', REPO));
const EXAMPLE = fileURLToPath(
  new URL('examples/artifacts/prepare_subaccount_review@1.0.0.example.json', REPO),
);

const LF = String.fromCharCode(10);

/**
 * Pull the one COMPLETE artifact out of docs/SCHEMA.md.
 *
 * Comments live on their own lines, never trailing a value, so stripping them is a line filter
 * rather than a parser. That rule exists for a specific reason: `entryPoint` contains "http://",
 * and a naive comment stripper would cut the URL in half and then report a confusing parse error
 * three fields later.
 */
function completeArtifactFromDoc(): unknown {
  const doc = readFileSync(SCHEMA_DOC, 'utf8');
  const marker = doc.indexOf('<!-- COMPLETE-ARTIFACT -->');
  expect(marker).toBeGreaterThan(-1);

  const open = doc.indexOf('```jsonc', marker);
  const start = doc.indexOf(LF, open) + 1;
  const end = doc.indexOf('```', start);
  expect(end).toBeGreaterThan(start);

  return JSON.parse(jsoncToJson(doc.slice(start, end)));
}

describe('docs/SCHEMA.md', () => {
  it('[MUST] contains a complete artifact that actually validates', () => {
    const parsed = CapabilityArtifactSchema.parse(completeArtifactFromDoc());
    expect(parsed.capabilityId).toBe('example_minimal');
    expect(validateArtifactStructure(parsed)).toEqual([]);
  });

  it('pins profiles that really exist, with hashes that really verify', () => {
    // If the documented example drifts from the profiles on disk, this fails rather than quietly
    // documenting something that could never be approved.
    const parsed = CapabilityArtifactSchema.parse(completeArtifactFromDoc());
    expect(() =>
      verifyProfilePins(parsed, { configRoot: fileURLToPath(new URL('config', REPO)) }),
    ).not.toThrow();
  });

  it('documents the same profile pins the real example artifact carries', () => {
    const documented = CapabilityArtifactSchema.parse(completeArtifactFromDoc());
    const real = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(EXAMPLE, 'utf8')));

    expect(documented.profiles.condition.sha256).toBe(real.profiles.condition.sha256);
    expect(documented.profiles.safety.sha256).toBe(real.profiles.safety.sha256);
    expect(documented.provenance.specHash).toBe(real.provenance.specHash);
  });
});

describe('the tracked example artifact', () => {
  it('validates, and its pins verify against the real profiles', () => {
    const artifact = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
    expect(validateArtifactStructure(artifact)).toEqual([]);
    expect(() =>
      verifyProfilePins(artifact, { configRoot: fileURLToPath(new URL('config', REPO)) }),
    ).not.toThrow();
  });
});
