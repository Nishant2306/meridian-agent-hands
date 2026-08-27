import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentHash } from '../../src/artifact/hash.js';
import { CapabilityArtifactSchema } from '../../src/artifact/schema.js';
import { writeManifest } from '../../scripts/evidence/lib/manifest.js';
import { runReplaySweep, type SweepResult } from '../../scripts/evidence/lib/replays.js';
import { bootFixture, type BootedFixture } from '../../scripts/evidence/lib/runtime.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLE = join(REPO, 'examples/artifacts/prepare_subaccount_review@1.0.0.example.json');

/**
 * ================================================================================================
 * THE EVIDENCE MACHINERY, EXERCISED FOR FREE.
 * ================================================================================================
 *
 * `npm run evidence:automated` pays for a real model call and then does everything else. A bug in
 * "everything else" - the replay sweep, the fault-pinned boot, the bundle copying, the verifier -
 * would surface only AFTER the paid step, and the natural response would be to run it again.
 *
 * So this test drives the same code against the TRACKED EXAMPLE capability, which needs no model,
 * and then runs the REAL verifier over the bundle it produced.
 *
 * IT IS ALSO THE VERIFIER'S NEGATIVE CONTROL, and that is the better half. The example artifact's
 * provenance says HAND-AUTHORED-EXAMPLE-NO-MODEL-WAS-CALLED, and there is no discovery run behind
 * it. A verifier worth running must REFUSE that bundle - loudly, by name - while still passing
 * every check about the replays, which really did happen. A gate that passes on a bundle with no
 * discovery in it would pass on anything.
 */
describe('the evidence sweep and the verifier', () => {
  let evidenceDir: string;
  let runtimeDir: string;
  let fixture: BootedFixture;
  let sweep: SweepResult;
  let stem: string;

  beforeAll(async () => {
    evidenceDir = mkdtempSync(join(tmpdir(), 'evidence-bundle-'));
    runtimeDir = mkdtempSync(join(tmpdir(), 'evidence-runtime-'));

    const artifacts = join(runtimeDir, 'artifacts');
    mkdirSync(join(artifacts, 'prepare_subaccount_review'), { recursive: true });
    mkdirSync(join(runtimeDir, 'runs'), { recursive: true });
    const artifactPath = join(artifacts, 'prepare_subaccount_review', '1.0.0.json');
    copyFileSync(EXAMPLE, artifactPath);

    stem = 'prepare_subaccount_review@1.0.0';
    mkdirSync(join(evidenceDir, 'artifact'), { recursive: true });
    // The DRAFT bytes, before approval rewrites the file. Same ordering the orchestrator uses, and
    // for the same reason: a re-serialized copy would not have the digest anybody would check.
    copyFileSync(artifactPath, join(evidenceDir, 'artifact', stem + '.draft.json'));

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          join(REPO, 'src', 'cli', 'capability-approve.ts'),
          stem,
          '--by',
          'evidence-sweep-test',
          '--artifacts',
          artifacts,
          '--config',
          join(REPO, 'config'),
        ],
        { cwd: REPO },
      );
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('approve exited ' + String(code))),
      );
    });
    copyFileSync(artifactPath, join(evidenceDir, 'artifact', stem + '.json'));

    fixture = await bootFixture();
    sweep = await runReplaySweep({
      capabilityId: 'prepare_subaccount_review',
      capabilityVersion: '1.0.0',
      artifacts,
      cwd: runtimeDir,
      fixture,
      headless: true,
      evidenceRoot: evidenceDir,
    });

    const approved = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf8')));

    writeManifest(join(evidenceDir, 'manifest.json'), {
      generatedAt: new Date().toISOString(),
      specHash: approved.provenance.specHash,
      artifactContentHash: contentHash(approved),
      // Deliberately different values: this bundle was assembled by a test and the file digests
      // are not what the orchestrator would record. The verifier check that reads them is asserted
      // below as a FAILURE, which is the correct answer for a hand-assembled bundle.
      artifactFileHash: 'a'.repeat(64),
      artifactDraftFileHash: 'b'.repeat(64),
      conditionProfileSha: approved.profiles.condition.sha256,
      safetyProfileSha: approved.profiles.safety.sha256,
      capability: { id: 'prepare_subaccount_review', version: '1.0.0', approvedBy: 'test' },
      discoveryRunId: approved.provenance.discoveryRunId,
      discovery: {
        model: approved.provenance.model,
        promptVersion: approved.provenance.promptVersion,
        llmCalls: 0,
        steps: 0,
        memberId: '10001',
      },
      fixtureSeeds: { discovery: 1, replay: 2 },
      replayRunIds: {
        success: sweep.runIds['success'] ?? '',
        notFound: sweep.runIds['notFound'] ?? '',
        recovery: sweep.runIds['recovery'] ?? '',
        permissionDenied: sweep.runIds['permissionDenied'] ?? '',
        unavailable: sweep.runIds['unavailable'] ?? '',
        handoff: '',
      },
      scenarios: sweep.scenarios,
    });
  }, 600_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it('[MUST] every scenario produced the outcome and the exit code it claims', () => {
    // The orchestrator abandons the run if this list is non-empty, rather than writing a manifest
    // that says otherwise. Here it is the whole assertion.
    expect(sweep.mismatches).toEqual([]);
    expect(sweep.scenarios.map((entry) => entry.scenario)).toEqual([
      'success',
      'notFound',
      'recovery',
      'permissionDenied',
      'unavailable',
    ]);
  });

  it('the fault-pinned boot reaches only the scenario that armed it', () => {
    // `unavailable` runs against its OWN fixture instance with a fault stamped on every request.
    // `success` uses the same parameters and runs against the shared boot, so if the fault had
    // leaked between them the two would be indistinguishable.
    const unavailable = sweep.scenarios.find((entry) => entry.scenario === 'unavailable');
    const success = sweep.scenarios.find((entry) => entry.scenario === 'success');
    expect(unavailable?.params).toEqual(success?.params);
    expect(unavailable?.status).toBe('failed');
    expect(success?.status).toBe('success');
  });

  it('[MUST] the verifier passes the replay checks and REFUSES the missing discovery', async () => {
    const output = await runVerifier(evidenceDir);

    // ------------------------------------------------------------------------------------------
    // The negative control. There is no discovery run behind this bundle and the artifact says so
    // in its own provenance. A gate that passed here would pass on anything.
    // ------------------------------------------------------------------------------------------
    expect(output.code).toBe(1);
    expect(output.text).toContain('FAIL  discovery called a real model');
    expect(output.text).toContain('FAIL  completion was VERIFIED by the system');
    expect(output.text).toContain('FAIL  the handoff scenario has been driven by a person');

    // ------------------------------------------------------------------------------------------
    // And everything about the replays, which really did happen, passes.
    // ------------------------------------------------------------------------------------------
    expect(output.text).toContain('PASS  every replay reported llmCalls === 0');
    expect(output.text).toContain('PASS  a member that does not exist is a BUSINESS OUTCOME');
    expect(output.text).toContain('PASS  the recovery ran once');
    expect(output.text).toContain('PASS  a hard failure carries EXPECTED beside OBSERVED');
    expect(output.text).toContain('PASS  an application that goes down mid-run');
    expect(output.text).toContain('PASS  every replay recorded loading the artifact');
    expect(output.text).toContain('PASS  the profile hashes pinned in the artifact match');
  }, 120_000);

  it('[MUST] the tier check holds each key control to the evidence it was recorded with', async () => {
    // ==========================================================================================
    // THE CHECK THAT MAKES THE SEED RESTART MEAN SOMETHING.
    // ==========================================================================================
    //
    // The fixture regenerates every class name and element id per boot and deliberately keeps its
    // legacy-stable ASP `name=` attributes. A replay that resolved EVERY control through those
    // would survive a restart and prove nothing about accessibility-first perception.
    //
    // So the search box must resolve by role and accessible name, the table-laid-out fields by the
    // label in the cell beside them, and the row control structurally by its key cell.
    const output = await runVerifier(evidenceDir);
    expect(output.text).toContain('PASS  each key control resolved at the tier its evidence');
    expect(output.text).toContain('search_input');
    expect(output.text).toContain('table_labelled_field');
    expect(output.text).toContain('result_row_control');
    expect(output.text).not.toContain('WRONG');
  }, 120_000);

  it('the leak scan finds no invocation value in any published text file', async () => {
    const output = await runVerifier(evidenceDir);
    expect(output.text).toContain('PASS  no value a run was invoked with appears verbatim');
    expect(output.text).toContain(
      'PASS  a declared-sensitive value the run READ is labelled in every file',
    );
  }, 120_000);
});

async function runVerifier(evidenceDir: string): Promise<{ code: number | null; text: string }> {
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(REPO, 'scripts', 'evidence', 'verify.ts')],
      { cwd: REPO, env: { ...process.env, EVIDENCE_DIR: evidenceDir } },
    );
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.on('exit', (code) => setTimeout(() => resolve({ code, text }), 100));
  });
}
