import { existsSync, readFileSync } from 'node:fs';
import { contentHash } from './hash.js';
import { effectivePolicy, policyIsWeakerThan } from './policy.js';
import {
  conditionProfilePath,
  loadSafetyProfile,
  profileHash,
  safetyProfilePath,
} from './profiles.js';
import type { CapabilityArtifact, ProfilePin } from './schema.js';
import { validateArtifactStructure } from './validate.js';
import type { CapabilityStore } from './store.js';
import { CapabilityNotFoundError } from './store.js';

/**
 * ==============================================================================================
 * [MUST] APPROVAL VERIFIES PINS. IT DOES NOT INTRODUCE THEM.
 * ==============================================================================================
 *
 * By the time an artifact reaches approval it ALREADY carries the profile hashes, because
 * distillation wrote them in before it computed the content hash. Approval recomputes them from
 * disk, compares, verifies the artifact, and then changes exactly three fields:
 * status, approvedAt, approvedBy.
 *
 * The property that falls out of this, and that PHASE 10 provenance depends on: the content hash
 * before approval and after approval are IDENTICAL. Approval is a signature on something that did
 * not change, not a transformation of it.
 *
 * If approval were the thing that introduced the pins, then the draft and the approved artifact
 * would have different hashes, and "this is the artifact that was reviewed" would stop being a
 * checkable statement.
 */
export class ProfileIntegrityError extends Error {
  readonly code = 'PROFILE_INTEGRITY_FAILURE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ProfileIntegrityError';
  }
}

export class ApprovalRefusedError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super(
      message +
        String.fromCharCode(10) +
        issues.map((issue) => '  - ' + issue).join(String.fromCharCode(10)),
    );
    this.name = 'ApprovalRefusedError';
    this.issues = issues;
  }
}

export interface VerifyOptions {
  /** Where the profile YAML lives. Defaults to the repository config directory. */
  configRoot?: string;
}

function verifyPin(kind: string, pin: ProfilePin, path: string): void {
  if (!existsSync(path)) {
    throw new ProfileIntegrityError(
      'the pinned ' +
        kind +
        ' profile ' +
        pin.id +
        '@' +
        pin.version +
        ' is not on disk at ' +
        path,
    );
  }

  const actual = profileHash(readFileSync(path, 'utf8'));
  if (actual !== pin.sha256) {
    throw new ProfileIntegrityError(
      'the pinned ' +
        kind +
        ' profile ' +
        pin.id +
        '@' +
        pin.version +
        ' does not match its pin. ' +
        'Pinned ' +
        pin.sha256 +
        ', found ' +
        actual +
        '. The profile has been edited since this ' +
        'artifact was distilled, which invalidates every hash that referenced it.',
    );
  }
}

/**
 * Recompute both pins from disk and compare. Throws PROFILE_INTEGRITY_FAILURE on any mismatch.
 * Called by approval, and again by replay before a single action is issued.
 */
export function verifyProfilePins(artifact: CapabilityArtifact, options: VerifyOptions = {}): void {
  const root = options.configRoot ?? 'config';
  const condition = artifact.profiles.condition;
  const safety = artifact.profiles.safety;

  verifyPin('condition', condition, conditionProfilePath(root, condition.id, condition.version));
  verifyPin('safety', safety, safetyProfilePath(root, safety.id, safety.version));
}

export interface ApprovalResult {
  artifact: CapabilityArtifact;
  /** Identical before and after. Printed by the CLI so the property is visible, not just claimed. */
  contentHash: string;
}

export async function approveCapability(
  store: CapabilityStore,
  capabilityId: string,
  version: string,
  approvedBy: string,
  options: VerifyOptions = {},
): Promise<ApprovalResult> {
  const artifact = await store.get(capabilityId, version);
  if (artifact === undefined) throw new CapabilityNotFoundError(capabilityId, version);

  if (artifact.status === 'approved') {
    throw new ApprovalRefusedError('already approved', [
      capabilityId +
        '@' +
        version +
        ' is already approved. Approval is not idempotent by design: ' +
        'a second approval would overwrite who signed it and when.',
    ]);
  }

  // 1. The pins. This throws PROFILE_INTEGRITY_FAILURE, which is deliberately NOT bundled with the
  //    structural issues below: a pin mismatch means the artifact may no longer mean what it said,
  //    and that is a different kind of problem from an artifact that is merely malformed.
  verifyProfilePins(artifact, options);

  // 2. The artifact itself.
  const issues = validateArtifactStructure(artifact).map(
    (issue) => issue.code + ': ' + issue.message,
  );

  // 3. The policy may be stricter than global. Never weaker.
  const root = options.configRoot ?? 'config';
  const safety = loadSafetyProfile(
    safetyProfilePath(root, artifact.profiles.safety.id, artifact.profiles.safety.version),
  );
  for (const weakening of policyIsWeakerThan(artifact.policy, safety.profile.policy)) {
    issues.push(
      'POLICY_WEAKER_THAN_GLOBAL: ' +
        weakening.field +
        ' is ' +
        weakening.candidate +
        ', which is looser than the global ceiling of ' +
        weakening.ceiling,
    );
  }

  if (issues.length > 0) {
    throw new ApprovalRefusedError('refusing to approve ' + capabilityId + '@' + version, issues);
  }

  const before = contentHash(artifact);
  const approved = await store.setStatus(capabilityId, version, 'approved', approvedBy);
  const after = contentHash(approved);

  if (before !== after) {
    throw new Error('approval changed the content hash; this must never happen');
  }

  return { artifact: approved, contentHash: after };
}

/** The policy actually in force for a run: global ceiling intersected with the capability layer. */
export function effectivePolicyFor(
  artifact: CapabilityArtifact,
  options: VerifyOptions = {},
): ReturnType<typeof effectivePolicy> {
  const root = options.configRoot ?? 'config';
  const safety = loadSafetyProfile(
    safetyProfilePath(root, artifact.profiles.safety.id, artifact.profiles.safety.version),
  );
  return effectivePolicy([safety.profile.policy, artifact.policy]);
}
