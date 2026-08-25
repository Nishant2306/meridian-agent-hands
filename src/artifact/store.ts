import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './hash.js';
import { CapabilityArtifactSchema, type CapabilityArtifact } from './schema.js';
import { parseVersion } from './version.js';

export interface CapabilityRef {
  capabilityId: string;
  capabilityVersion: string;
  status: 'draft' | 'approved';
  contentHash: string;
}

export interface CapabilityStore {
  list(capabilityId?: string): Promise<CapabilityRef[]>;
  get(capabilityId: string, version: string): Promise<CapabilityArtifact | undefined>;
  getLatestApproved(capabilityId: string): Promise<CapabilityArtifact | undefined>;
  put(artifact: CapabilityArtifact): Promise<void>;
  setStatus(
    capabilityId: string,
    version: string,
    status: 'draft' | 'approved',
    approvedBy?: string,
  ): Promise<CapabilityArtifact>;
}

export class CapabilityExistsError extends Error {
  constructor(capabilityId: string, version: string) {
    super(
      capabilityId +
        '@' +
        version +
        ' already exists. A published version is immutable: bump the ' +
        'version instead of overwriting it.',
    );
    this.name = 'CapabilityExistsError';
  }
}

export class CapabilityNotFoundError extends Error {
  constructor(capabilityId: string, version: string) {
    super(capabilityId + '@' + version + ' is not in the store');
    this.name = 'CapabilityNotFoundError';
  }
}

function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = parseVersion(a);
  const [bMajor, bMinor, bPatch] = parseVersion(b);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

/**
 * Artifacts on disk, at /artifacts/<capabilityId>/<version>.json.
 *
 * A PUBLISHED VERSION IS IMMUTABLE. `put` refuses to overwrite one, because a stored artifact is
 * something a run has already been executed against and something an approval may already have
 * signed. Changing it in place would make every piece of evidence that references it unverifiable,
 * while looking like a small edit. Bumping the version costs nothing; the alternative costs the
 * audit trail.
 *
 * `setStatus` is the ONLY method that mutates an existing file, it changes only the three fields
 * excluded from the content hash, and it verifies that the hash is unchanged before writing.
 */
export class FileCapabilityStore implements CapabilityStore {
  readonly #root: string;

  constructor(root = 'artifacts') {
    this.#root = root;
  }

  #dir(capabilityId: string): string {
    return join(this.#root, capabilityId);
  }

  #path(capabilityId: string, version: string): string {
    return join(this.#dir(capabilityId), version + '.json');
  }

  #read(capabilityId: string, version: string): CapabilityArtifact | undefined {
    const path = this.#path(capabilityId, version);
    if (!existsSync(path)) return undefined;
    return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }

  async list(capabilityId?: string): Promise<CapabilityRef[]> {
    if (!existsSync(this.#root)) return [];

    const ids =
      capabilityId === undefined
        ? readdirSync(this.#root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [capabilityId];

    const refs: CapabilityRef[] = [];
    for (const id of ids) {
      const dir = this.#dir(id);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const version = file.slice(0, -'.json'.length);
        const artifact = this.#read(id, version);
        if (artifact === undefined) continue;
        refs.push({
          capabilityId: id,
          capabilityVersion: artifact.capabilityVersion,
          status: artifact.status,
          contentHash: contentHash(artifact),
        });
      }
    }

    return refs.sort(
      (a, b) =>
        a.capabilityId.localeCompare(b.capabilityId) ||
        compareVersions(a.capabilityVersion, b.capabilityVersion),
    );
  }

  async get(capabilityId: string, version: string): Promise<CapabilityArtifact | undefined> {
    return this.#read(capabilityId, version);
  }

  async getLatestApproved(capabilityId: string): Promise<CapabilityArtifact | undefined> {
    const approved = (await this.list(capabilityId)).filter((ref) => ref.status === 'approved');
    const latest = approved.at(-1);
    if (latest === undefined) return undefined;
    return this.#read(capabilityId, latest.capabilityVersion);
  }

  async put(artifact: CapabilityArtifact): Promise<void> {
    const path = this.#path(artifact.capabilityId, artifact.capabilityVersion);
    if (existsSync(path)) {
      throw new CapabilityExistsError(artifact.capabilityId, artifact.capabilityVersion);
    }
    mkdirSync(this.#dir(artifact.capabilityId), { recursive: true });
    writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf8');
  }

  async setStatus(
    capabilityId: string,
    version: string,
    status: 'draft' | 'approved',
    approvedBy?: string,
  ): Promise<CapabilityArtifact> {
    const existing = this.#read(capabilityId, version);
    if (existing === undefined) throw new CapabilityNotFoundError(capabilityId, version);

    const updated: CapabilityArtifact =
      status === 'approved'
        ? {
            ...existing,
            status,
            approvedAt: new Date().toISOString(),
            ...(approvedBy === undefined ? {} : { approvedBy }),
          }
        : { ...existing, status };

    // Belt and braces. If this ever fires, something added semantic content during a status flip,
    // and the provenance chain in PHASE 10 would have silently broken instead.
    if (contentHash(updated) !== contentHash(existing)) {
      throw new Error(
        'setStatus changed the content hash of ' +
          capabilityId +
          '@' +
          version +
          '. Approval must never modify semantic content.',
      );
    }

    writeFileSync(this.#path(capabilityId, version), JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }
}
