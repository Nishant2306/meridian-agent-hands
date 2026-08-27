import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * ================================================================================================
 * /evidence/manifest.json - THE INDEX A REVIEWER STARTS FROM AND THE VERIFIER RUNS AGAINST.
 * ================================================================================================
 *
 * Two rules shaped this file.
 *
 * IT CONTAINS NO SCREEN TEXT AND NO DISCOVERED VALUE. Ids, hashes, seeds, counts and status
 * strings only. Everything here is either invented fixture data (member ids, which the seed set
 * stamps DUMMY DATA - NOT REAL on screen) or a digest. Nothing the model read off a page reaches
 * it.
 *
 * IT IS THE ONLY PLACE SOME FACTS CAN LIVE, AND THE VERIFIER SAYS SO. Two claims cannot be
 * re-derived from the bundle afterwards:
 *
 *   - which member each run used, because the persisted files are pseudonymized and the label map
 *     is random PER RUN, so `[memberId:subject-01]` in one run and in another are not comparable.
 *     That is the pseudonymizer working correctly, and it costs exactly this.
 *   - the fixture obfuscation seed, which is a property of a process that has since exited.
 *
 * So the orchestrator records them and the verifier labels those checks `[manifest]` rather than
 * pretending they were independently confirmed. Every other check reads the bundle.
 */

const HASH = z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha-256 hex digest');

export const ScenarioSchema = z.strictObject({
  /** Directory under /evidence. Also the key in `replayRunIds`. */
  scenario: z.string(),
  runId: z.string(),
  /** What the run was asked to do. Fixture member ids are invented; see the note above. */
  params: z.record(z.string(), z.string()),
  /** The status the RunResult reported, and the process exit code the CLI used for it. */
  status: z.string(),
  exitCode: z.number(),
  /** One line of intent, rendered into evidence/README.md. */
  proves: z.string(),
});
export type ScenarioRecord = z.infer<typeof ScenarioSchema>;

export const ManifestSchema = z.strictObject({
  generatedAt: z.string(),
  specHash: HASH,
  /**
   * [MUST] ONE value, not two.
   *
   * The distilled DRAFT and the approved artifact hash IDENTICALLY, because contentHash excludes
   * exactly status, approvedAt and approvedBy. The orchestrator computes both and refuses to write
   * a manifest if they differ, so a single field here is a claim that has already been checked once
   * and is checked again by the verifier against the artifact in the bundle.
   */
  artifactContentHash: HASH,
  /** sha-256 of the approved FILE. Legitimately different from the draft file's; both recorded. */
  artifactFileHash: HASH,
  artifactDraftFileHash: HASH,

  conditionProfileSha: HASH,
  safetyProfileSha: HASH,

  capability: z.strictObject({ id: z.string(), version: z.string(), approvedBy: z.string() }),

  discoveryRunId: z.string(),
  discovery: z.strictObject({
    model: z.string(),
    promptVersion: z.string(),
    llmCalls: z.number(),
    steps: z.number(),
    /** The member the model actually drove. The replay success case must not reuse it. */
    memberId: z.string(),
  }),

  fixtureSeeds: z.strictObject({ discovery: z.number(), replay: z.number() }),

  /** Scenario key -> runId. The required index; the detail is in `scenarios`. */
  replayRunIds: z.strictObject({
    success: z.string(),
    notFound: z.string(),
    recovery: z.string(),
    permissionDenied: z.string(),
    unavailable: z.string(),
    /** Empty until `npm run evidence:handoff` has been driven by a person. */
    handoff: z.string(),
  }),

  scenarios: z.array(ScenarioSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export function readManifest(path: string): Manifest {
  return ManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeManifest(path: string, manifest: Manifest): void {
  writeFileSync(path, JSON.stringify(ManifestSchema.parse(manifest), null, 2) + '\n', 'utf8');
}

/**
 * Where the run happened on THIS machine, kept out of the manifest and out of git.
 *
 * `evidence:handoff` needs the artifact store the automated run wrote to, and that lives under the
 * system temp directory - so the path contains a home directory and a username. The manifest is
 * published; this is not. Splitting them costs one file and keeps somebody's account name out of a
 * submitted repository.
 */
export const RuntimeRefSchema = z.strictObject({
  runtimeDir: z.string(),
  artifactStore: z.string(),
  /**
   * Where the RAW discovery record was preserved, outside the temp runtime.
   *
   * The only file that answers "what did the model actually see", and the only one that is not
   * pseudonymized. Never published; see preserveRawRecord in lib/runtime.ts.
   */
  /**
   * Optional so a side-car written before this field existed still parses. `evidence:handoff` reads
   * this file to find the artifact store, and a schema change that made an existing bundle
   * un-runnable would be a worse bug than the one it was fixing.
   */
  rawDiscoveryRecord: z.string().nullable().optional(),
});
export type RuntimeRef = z.infer<typeof RuntimeRefSchema>;

export function readRuntimeRef(path: string): RuntimeRef {
  return RuntimeRefSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeRuntimeRef(path: string, ref: RuntimeRef): void {
  writeFileSync(path, JSON.stringify(RuntimeRefSchema.parse(ref), null, 2), 'utf8');
}
