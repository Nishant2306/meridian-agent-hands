import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveCapability,
  ApprovalRefusedError,
  ProfileIntegrityError,
  effectivePolicyFor,
  verifyProfilePins,
} from '../src/artifact/approve.js';
import { contentHash, hashableContent, HASH_EXCLUDED_FIELDS } from '../src/artifact/hash.js';
import { effectivePolicy, globalPolicyHash, policyIsWeakerThan } from '../src/artifact/policy.js';
import { CapabilityArtifactSchema, type CapabilityArtifact } from '../src/artifact/schema.js';
import { CapabilityExistsError, FileCapabilityStore } from '../src/artifact/store.js';
import { classifyChange, nextVersion } from '../src/artifact/version.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const EXAMPLE_PATH = join(REPO, 'examples/artifacts/prepare_subaccount_review@1.0.0.example.json');

function loadExample(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')));
}

function scratchConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'config-'));
  cpSync(join(REPO, 'config'), root, { recursive: true });
  return root;
}

describe('the content hash', () => {
  const artifact = loadExample();

  it('[MUST] excludes exactly status, approvedAt and approvedBy', () => {
    expect([...HASH_EXCLUDED_FIELDS]).toEqual(['status', 'approvedAt', 'approvedBy']);
    const content = hashableContent(artifact);
    for (const field of HASH_EXCLUDED_FIELDS) expect(content).not.toHaveProperty(field);
    expect(content).toHaveProperty('profiles');
  });

  it('[MUST] is IDENTICAL before and after a status flip', () => {
    // The property PHASE 10 provenance is built on. Approval signs an artifact; it does not
    // transform one.
    const approved: CapabilityArtifact = {
      ...artifact,
      status: 'approved',
      approvedAt: '2026-02-02T00:00:00.000Z',
      approvedBy: 'a.reviewer',
    };
    expect(contentHash(approved)).toBe(contentHash(artifact));
  });

  it('[MUST] INCLUDES the profile pins', () => {
    // Re-pointing a capability at a different safety profile must move its identity. Otherwise the
    // pin is decoration.
    const repinned: CapabilityArtifact = {
      ...artifact,
      profiles: {
        ...artifact.profiles,
        safety: { ...artifact.profiles.safety, sha256: 'f'.repeat(64) },
      },
    };
    expect(contentHash(repinned)).not.toBe(contentHash(artifact));
  });

  it('moves when any semantic field moves', () => {
    const renamed: CapabilityArtifact = {
      ...artifact,
      description: artifact.description + ' (v2)',
    };
    expect(contentHash(renamed)).not.toBe(contentHash(artifact));
  });
});

describe('the capability store', () => {
  let root: string;
  const artifact = loadExample();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifacts-'));
  });

  it('round-trips an artifact unchanged', async () => {
    const store = new FileCapabilityStore(root);
    await store.put(artifact);

    const loaded = await store.get(artifact.capabilityId, artifact.capabilityVersion);
    expect(loaded).toEqual(artifact);
    expect(contentHash(loaded as CapabilityArtifact)).toBe(contentHash(artifact));
  });

  it('[MUST] refuses to overwrite a published version', async () => {
    // A stored artifact is something a run may already have executed and an approval may already
    // have signed. Editing it in place would make every piece of evidence referencing it
    // unverifiable, while looking like a small change.
    const store = new FileCapabilityStore(root);
    await store.put(artifact);
    await expect(store.put(artifact)).rejects.toBeInstanceOf(CapabilityExistsError);
  });

  it('lists versions and finds the latest approved one', async () => {
    const store = new FileCapabilityStore(root);
    await store.put(artifact);
    await store.put({ ...artifact, capabilityVersion: '1.1.0' });
    await store.put({ ...artifact, capabilityVersion: '1.2.0' });

    expect(await store.getLatestApproved(artifact.capabilityId)).toBeUndefined();

    await store.setStatus(artifact.capabilityId, '1.1.0', 'approved', 'a.reviewer');
    const latest = await store.getLatestApproved(artifact.capabilityId);
    expect(latest?.capabilityVersion).toBe('1.1.0');

    const refs = await store.list(artifact.capabilityId);
    expect(refs.map((ref) => ref.capabilityVersion)).toEqual(['1.0.0', '1.1.0', '1.2.0']);
  });

  it('preserves the content hash across setStatus', async () => {
    const store = new FileCapabilityStore(root);
    await store.put(artifact);
    const approved = await store.setStatus(
      artifact.capabilityId,
      artifact.capabilityVersion,
      'approved',
      'a.reviewer',
    );

    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('a.reviewer');
    expect(contentHash(approved)).toBe(contentHash(artifact));
  });
});

describe('version diff classification', () => {
  const artifact = loadExample();

  it('calls a locator or step change MINOR', () => {
    const relocated: CapabilityArtifact = {
      ...artifact,
      steps: artifact.steps.map((step, index) =>
        index === 0 ? { ...step, intent: step.intent + ' (reworded)' } : step,
      ),
    };
    const change = classifyChange(artifact, relocated);
    expect(change.kind).toBe('minor');
    expect(nextVersion('1.0.0', change.kind)).toBe('1.1.0');
  });

  it('calls an input or output contract change MAJOR', () => {
    const contractChanged: CapabilityArtifact = {
      ...artifact,
      inputs: artifact.inputs.map((input) =>
        input.name === 'nickname' ? { ...input, required: true } : input,
      ),
    };
    const change = classifyChange(artifact, contractChanged);
    expect(change.kind).toBe('major');
    expect(nextVersion('1.4.2', change.kind)).toBe('2.0.0');
  });

  it('treats moving where an output was FOUND as minor, not major', () => {
    // The declared half of an output is contract. `source` is where discovery found it, and moving
    // that is a locator change: no caller can tell.
    const resourced: CapabilityArtifact = {
      ...artifact,
      outputs: artifact.outputs.map((output, index) =>
        index === 0
          ? { ...output, source: { ...output.source, parse: 'text' as const, pattern: '^.+$' } }
          : output,
      ),
    };
    expect(classifyChange(artifact, resourced).kind).toBe('minor');
  });

  it('reports NONE when nothing covered by the hash changed', () => {
    expect(classifyChange(artifact, { ...artifact, status: 'approved' }).kind).toBe('none');
  });
});

describe('approval', () => {
  const artifact = loadExample();
  let artifactRoot: string;
  let configRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifacts-'));
    configRoot = scratchConfig();
  });

  it('verifies the pins against the real profiles on disk', () => {
    expect(() => verifyProfilePins(artifact, { configRoot })).not.toThrow();
  });

  it('[MUST] flips status without moving the content hash', async () => {
    const store = new FileCapabilityStore(artifactRoot);
    await store.put(artifact);
    const before = contentHash(artifact);

    const result = await approveCapability(
      store,
      artifact.capabilityId,
      artifact.capabilityVersion,
      'a.reviewer',
      { configRoot },
    );

    expect(result.artifact.status).toBe('approved');
    expect(result.artifact.approvedBy).toBe('a.reviewer');
    expect(result.contentHash).toBe(before);
  });

  it('[MUST] refuses with PROFILE_INTEGRITY_FAILURE when a pinned profile has been edited', async () => {
    const store = new FileCapabilityStore(artifactRoot);
    await store.put(artifact);

    // A single added comment. Nothing semantic. The pin still has to fail: the profile is the one
    // the artifact was reviewed against, and this is no longer that file.
    const profilePath = join(configRoot, 'condition-profiles/meridian-subaccount/1.0.0.yaml');
    writeFileSync(
      profilePath,
      readFileSync(profilePath, 'utf8') + '# an edit' + String.fromCharCode(10),
    );

    await expect(
      approveCapability(store, artifact.capabilityId, artifact.capabilityVersion, 'a.reviewer', {
        configRoot,
      }),
    ).rejects.toBeInstanceOf(ProfileIntegrityError);
  });

  it('[MUST] refuses an artifact whose pin does not verify at all', async () => {
    const store = new FileCapabilityStore(artifactRoot);
    await store.put({
      ...artifact,
      profiles: {
        ...artifact.profiles,
        safety: { ...artifact.profiles.safety, sha256: '0'.repeat(64) },
      },
    });

    const error = await approveCapability(
      store,
      artifact.capabilityId,
      artifact.capabilityVersion,
      'a.reviewer',
      { configRoot },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProfileIntegrityError);
    expect((error as ProfileIntegrityError).code).toBe('PROFILE_INTEGRITY_FAILURE');
  });

  it('[MUST] refuses a capability whose policy is weaker than the global ceiling', async () => {
    const store = new FileCapabilityStore(artifactRoot);
    await store.put({
      ...artifact,
      policy: { maxRiskAllowed: 'IRREVERSIBLE', maxSteps: 5000, maxDurationMs: 999999999 },
    });

    const error = await approveCapability(
      store,
      artifact.capabilityId,
      artifact.capabilityVersion,
      'a.reviewer',
      { configRoot },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApprovalRefusedError);
    const issues = (error as ApprovalRefusedError).issues.join(' ');
    expect(issues).toContain('POLICY_WEAKER_THAN_GLOBAL');
    expect(issues).toContain('maxRiskAllowed');
  });

  it('refuses to approve the same version twice', async () => {
    const store = new FileCapabilityStore(artifactRoot);
    await store.put(artifact);
    await approveCapability(store, artifact.capabilityId, artifact.capabilityVersion, 'first', {
      configRoot,
    });

    await expect(
      approveCapability(store, artifact.capabilityId, artifact.capabilityVersion, 'second', {
        configRoot,
      }),
    ).rejects.toBeInstanceOf(ApprovalRefusedError);
  });
});

describe('policy layering', () => {
  const artifact = loadExample();

  it('takes the strictest value of every layer', () => {
    const effective = effectivePolicy([
      { maxRiskAllowed: 'RISKY_REVERSIBLE', maxSteps: 60, maxDurationMs: 300000 },
      { maxRiskAllowed: 'SAFE_REVERSIBLE', maxSteps: 40, maxDurationMs: 120000 },
    ]);
    expect(effective).toEqual({
      maxRiskAllowed: 'SAFE_REVERSIBLE',
      maxSteps: 40,
      maxDurationMs: 120000,
    });
  });

  it('[MUST] lets a LATER global tightening bind a capability approved under a looser one', () => {
    const approvedUnder = {
      maxRiskAllowed: 'RISKY_REVERSIBLE' as const,
      maxSteps: 40,
      maxDurationMs: 120000,
    };
    const tightenedGlobal = {
      maxRiskAllowed: 'SAFE_REVERSIBLE' as const,
      maxSteps: 60,
      maxDurationMs: 300000,
    };

    expect(effectivePolicy([tightenedGlobal, approvedUnder]).maxRiskAllowed).toBe(
      'SAFE_REVERSIBLE',
    );
  });

  it('names every way a candidate policy is looser than the ceiling', () => {
    const ceiling = {
      maxRiskAllowed: 'RISKY_REVERSIBLE' as const,
      maxSteps: 60,
      maxDurationMs: 300000,
    };
    const looser = {
      maxRiskAllowed: 'IRREVERSIBLE' as const,
      maxSteps: 100,
      maxDurationMs: 400000,
    };

    expect(policyIsWeakerThan(looser, ceiling).map((weak) => weak.field)).toEqual([
      'maxRiskAllowed',
      'maxSteps',
      'maxDurationMs',
    ]);
    expect(policyIsWeakerThan(ceiling, ceiling)).toEqual([]);
  });

  it('materializes the effective policy and a stable global policy hash', () => {
    const configRoot = scratchConfig();
    const effective = effectivePolicyFor(artifact, { configRoot });

    // The capability is stricter on steps and duration; the risk ceiling is the same.
    expect(effective).toEqual({
      maxRiskAllowed: 'RISKY_REVERSIBLE',
      maxSteps: 40,
      maxDurationMs: 120000,
    });

    const hash = globalPolicyHash(effective);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(globalPolicyHash({ ...effective })).toBe(hash);
  });
});
