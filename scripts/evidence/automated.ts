import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { contentHash } from '../../src/artifact/hash.js';
import { CapabilityArtifactSchema } from '../../src/artifact/schema.js';
import { loadEnvFile } from '../../src/config/env.js';
import { loadDiscoverySpec } from '../../src/config/spec.js';
import { tenantA } from '../../fixtures/legacy-app/tenants/tenant-a.js';
import type { Manifest } from './lib/manifest.js';
import { writeManifest, writeRuntimeRef } from './lib/manifest.js';
import { renderReadme } from './lib/readme.js';
import { DISCOVERY_INPUTS, DISCOVERY_MEMBER, runReplaySweep } from './lib/replays.js';
import {
  bootFixture,
  clearScenarios,
  copyIntoBundle,
  createRuntime,
  CONFIG_ROOT,
  ensureEvidenceRoot,
  EVIDENCE_ROOT,
  newestRunDir,
  preserveRawRecord,
  requireApiKey,
  runCli,
  say,
  sha256File,
  SPEC,
} from './lib/runtime.js';

/**
 * ================================================================================================
 * `npm run evidence:automated` - ONE REAL DISCOVERY, THEN FIVE DETERMINISTIC REPLAYS.
 * ================================================================================================
 *
 * WHY THIS IS A NODE PROGRAM AND NOT A SHELL SCRIPT. Every step has state that a re-run has to
 * reason about rather than re-execute: the capability store REFUSES to overwrite a published
 * version, approval MUTATES an artifact in place and must happen exactly once, the fixture has to
 * be restarted between discovery and replay so the two see different obfuscation seeds, and one
 * scenario needs a fault armed on a dedicated boot. `set -e` and a list of npm commands cannot
 * express any of that, and the failure mode of trying is a half-written bundle that looks complete.
 *
 * WHAT IT REFUSES TO DO. Without ANTHROPIC_API_KEY it stops and says so. It does not fall back to
 * the scripted client and it does not write a manifest describing a run that did not happen.
 * Evidence that MIGHT be fabricated is worth less than no evidence, because a reviewer cannot tell
 * which kind they are holding.
 *
 * THE CHAIN IT PRODUCES:
 *
 *   fixture boot A (seed A)  ->  ONE real discovery, member 10001, a model in the decision loop
 *                            ->  distilled DRAFT capability
 *                            ->  approval: status flips, content hash does NOT move
 *   fixture RESTART (seed B) ->  every CSS class name and element id in the application changes
 *                            ->  five replays, a DIFFERENT member, zero model calls
 *
 * The restart is the point, and on its own it proves less than it looks: the fixture deliberately
 * keeps its legacy-stable ASP `name=` attributes, so a replay that resolved every control through
 * those would survive it. `evidence:verify` therefore asserts the TIER each key control resolved
 * at, individually.
 *
 * --reuse <dir> SKIPS THE DISCOVERY. It exists because discovery costs money and everything after
 * it does not: if approval or the replay sweep fails, re-running the whole command would pay a
 * second time for a model call that already succeeded. The runtime directory is printed on every
 * run and recorded in evidence/.runtime.json, which is gitignored because it is an absolute path
 * with a username in it.
 */
loadEnvFile();

interface Options {
  reuse?: string;
}

function fail(message: string, runtimeDir?: string): never {
  say();
  say('EVIDENCE RUN ABANDONED');
  say('  ' + message);
  say();
  if (runtimeDir !== undefined) {
    say('The discovery run, if it completed, is still here:');
    say('  ' + runtimeDir);
    say();
    say('Resume without paying for another model call:');
    say('  npm run evidence:automated -- --reuse ' + runtimeDir);
    say();
  }
  process.exit(1);
}

async function main(options: Options): Promise<void> {
  ensureEvidenceRoot();
  const spec = loadDiscoverySpec(SPEC);
  const capabilityId = spec.spec.capabilityId;

  const reusing = options.reuse !== undefined;
  if (reusing && !existsSync(join(options.reuse ?? '', 'runs'))) {
    fail('--reuse was given ' + String(options.reuse) + ', which has no runs/ directory');
  }

  const runtime = reusing
    ? {
        dir: options.reuse as string,
        artifacts: join(options.reuse as string, 'artifacts'),
        runs: join(options.reuse as string, 'runs'),
      }
    : createRuntime();

  say();
  say('EVIDENCE RUN');
  say('  runtime:  ' + runtime.dir);
  say('  bundle:   ' + EVIDENCE_ROOT);
  say('  model:    ' + (process.env['LLM_MODEL'] ?? '(LLM_MODEL is not set)'));
  say();

  // ==============================================================================================
  // 1. DISCOVERY. One real model, one live UI.
  // ==============================================================================================
  //
  // The fixture goes on tenant A's CONFIGURED port rather than an ephemeral one, because `discover`
  // has no --origin: it navigates to the entry point the SPEC declares, and the spec is what pins
  // the run to a single allowed origin in the first place. A command-line override there would turn
  // the bootstrap safety minimum into an argument.
  let discoverySeed: number;
  const discoveryFixture = reusing ? undefined : await bootFixture({ port: tenantA.port });

  if (discoveryFixture !== undefined) {
    requireApiKey();
    discoverySeed = discoveryFixture.seed;
    say('fixture boot A   seed ' + discoverySeed + '   ' + spec.spec.target.entryPoint);
    say();
    say('Running ONE real discovery. This calls a model and it costs money.');
    say();

    const discovery = await runCli({
      script: 'src/cli/discover.ts',
      args: [
        '--spec',
        SPEC,
        '--target',
        'tenant-a',
        '--inputs',
        JSON.stringify(DISCOVERY_INPUTS),
        '--config',
        CONFIG_ROOT,
        '--artifacts',
        runtime.artifacts,
      ],
      cwd: runtime.dir,
      env: { HEADLESS: process.env['HEADLESS'] ?? 'true' },
    });

    process.stdout.write(discovery.stdout);
    await discoveryFixture.close();
    if (discovery.code !== 0) {
      process.stderr.write(discovery.stderr);
      fail('discovery exited ' + String(discovery.code) + '. Its output is above.', runtime.dir);
    }
  } else {
    say('--reuse: skipping discovery and using the run already in ' + runtime.dir);
    say();
    // A reused runtime has no live fixture to read a seed from, and the original boot's seed is not
    // recoverable from a process that has exited. It is recorded as -1 so the verifier reports the
    // seed check honestly rather than being handed an invented number.
    discoverySeed = -1;
  }

  const discoveryRun = newestRunDir(runtime.runs, 'discover-');
  const completion = JSON.parse(readFileSync(join(discoveryRun, 'completion.json'), 'utf8')) as {
    completionVerifiedBySystem: boolean;
    metrics: { llmCalls: number; steps: number };
  };

  if (completion.completionVerifiedBySystem !== true) {
    fail('the model proposed completion and the system did not verify it.', runtime.dir);
  }

  // ==============================================================================================
  // 2. APPROVAL. The status flips; the content hash does not move.
  // ==============================================================================================
  const versionDir = join(runtime.artifacts, capabilityId);
  const versionFile = readdirSync(versionDir).find((name) => name.endsWith('.json'));
  if (versionFile === undefined) fail('discovery wrote no artifact into ' + versionDir, runtime.dir);
  const artifactPath = join(versionDir, versionFile);
  const capabilityVersion = versionFile.replace(/\.json$/, '');

  const draft = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf8')));
  const draftContentHash = contentHash(draft);
  const draftFileHash = sha256File(artifactPath);

  // ============================================================================================
  // EVERY SCENARIO DIRECTORY IS CLEARED BEFORE THE FIRST ONE IS WRITTEN.
  // ============================================================================================
  //
  // Done here rather than at the top of the run, so a discovery that fails leaves the previous
  // bundle intact. Once discovery has succeeded and been approved, this bundle is the one being
  // published and the old one is superseded. The handoff goes too; see clearScenarios.
  const cleared = clearScenarios();
  if (cleared.length > 0) {
    say('cleared previous bundle: ' + cleared.join(', '));
    say();
  }

  // The draft's BYTES, copied before approval rewrites the file in place. Re-serializing the parsed
  // object instead would produce a file whose digest is not the one the manifest records, which is
  // the first thing a reviewer would check by hand.
  const bundleArtifacts = join(EVIDENCE_ROOT, 'artifact');
  mkdirSync(bundleArtifacts, { recursive: true });
  const stem = capabilityId + '@' + capabilityVersion;
  copyFileSync(artifactPath, join(bundleArtifacts, stem + '.draft.json'));

  const approvedBy = 'evidence-run';
  if (draft.status === 'draft') {
    const approval = await runCli({
      script: 'src/cli/capability-approve.ts',
      args: [stem, '--by', approvedBy, '--artifacts', runtime.artifacts, '--config', CONFIG_ROOT],
      cwd: runtime.dir,
    });
    process.stdout.write(approval.stdout);
    if (approval.code !== 0) {
      process.stderr.write(approval.stderr);
      fail('approval exited ' + String(approval.code), runtime.dir);
    }
  } else {
    say('already approved (--reuse): ' + stem);
  }

  const approved = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, 'utf8')));
  const approvedContentHash = contentHash(approved);
  const approvedFileHash = sha256File(artifactPath);
  copyFileSync(artifactPath, join(bundleArtifacts, stem + '.json'));

  // Checked here as well as in the verifier. The verifier is the gate; this is so that a run which
  // has already violated the property stops before spending five browser launches on it.
  if (approvedContentHash !== draftContentHash) {
    fail('approval moved the content hash: ' + draftContentHash + ' -> ' + approvedContentHash);
  }

  copyIntoBundle(discoveryRun, 'discovery');
  // Out of the temp runtime, into a gitignored directory that survives a cleanup. NOT into the
  // bundle: it is raw screen text and it must stay raw. See preserveRawRecord.
  const rawRecord = preserveRawRecord(discoveryRun);

  // ==============================================================================================
  // 3. THE FIXTURE IS RESTARTED. Different seed, different class names, same capability.
  // ==============================================================================================
  let replayFixture = await bootFixture();
  if (replayFixture.seed === discoverySeed) {
    // Random 31-bit seeds, so this is a one-in-two-billion event rather than a bug. It is checked
    // because the whole point of the restart is that the two boots differ, and a bundle asserting a
    // difference that did not happen is worse than one that retried.
    await replayFixture.close();
    replayFixture = await bootFixture();
  }

  say();
  say('fixture RESTARTED');
  say('  discovery seed: ' + (discoverySeed === -1 ? '(reused run; not recorded)' : discoverySeed));
  say('  replay seed:    ' + replayFixture.seed);
  say('  Every CSS class name and element id is regenerated. Every role, accessible name and');
  say('  legacy name= attribute is exactly where it was.');
  say();

  const sweep = await runReplaySweep({
    capabilityId,
    capabilityVersion,
    artifacts: runtime.artifacts,
    cwd: runtime.dir,
    fixture: replayFixture,
    headless: (process.env['HEADLESS'] ?? 'true') !== 'false',
  }).finally(() => replayFixture.close());

  if (sweep.mismatches.length > 0) {
    for (const line of sweep.mismatches) say('  ' + line);
    fail('a scenario did not produce the outcome the bundle would have claimed.', runtime.dir);
  }

  // ==============================================================================================
  // 4. THE MANIFEST.
  // ==============================================================================================
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    specHash: spec.specHash,
    artifactContentHash: approvedContentHash,
    artifactFileHash: approvedFileHash,
    artifactDraftFileHash: draftFileHash,
    conditionProfileSha: approved.profiles.condition.sha256,
    safetyProfileSha: approved.profiles.safety.sha256,
    capability: { id: capabilityId, version: capabilityVersion, approvedBy },
    discoveryRunId: approved.provenance.discoveryRunId,
    discovery: {
      model: approved.provenance.model,
      promptVersion: approved.provenance.promptVersion,
      llmCalls: completion.metrics.llmCalls,
      steps: completion.metrics.steps,
      memberId: DISCOVERY_MEMBER,
    },
    fixtureSeeds: { discovery: discoverySeed, replay: replayFixture.seed },
    replayRunIds: {
      success: sweep.runIds['success'] ?? '',
      notFound: sweep.runIds['notFound'] ?? '',
      recovery: sweep.runIds['recovery'] ?? '',
      permissionDenied: sweep.runIds['permissionDenied'] ?? '',
      unavailable: sweep.runIds['unavailable'] ?? '',
      // Filled in by `npm run evidence:handoff`, which needs a person.
      handoff: '',
    },
    scenarios: sweep.scenarios,
  };

  writeManifest(join(EVIDENCE_ROOT, 'manifest.json'), manifest);

  // The bundle's README, rendered from the run files this sweep just wrote. Never from what this
  // program remembers doing: the orchestrator knows what it ASKED for, the run files record what
  // HAPPENED, and only the second is something a reviewer can check. See lib/readme.ts.
  const readme = renderReadme({ manifest });
  if (readme.unfilled.length > 0) {
    say('  README placeholders still unfilled: ' + readme.unfilled.join(', '));
  }
  // Not in the manifest and not in git: it is an absolute path under the system temp directory and
  // therefore contains a username. `evidence:handoff` reads it to find the same artifact store.
  writeRuntimeRef(join(EVIDENCE_ROOT, '.runtime.json'), {
    runtimeDir: runtime.dir,
    artifactStore: runtime.artifacts,
    rawDiscoveryRecord: rawRecord,
  });

  say();
  say('WROTE ' + join(EVIDENCE_ROOT, 'manifest.json'));
  say();
  say('  capability:    ' + stem);
  say('  content hash:  ' + approvedContentHash);
  say('                 identical for the draft and the approved artifact');
  say('  file hash:     ' + draftFileHash.slice(0, 16) + '...  (draft)');
  say('                 ' + approvedFileHash.slice(0, 16) + '...  (approved)');
  say('                 different, and that is correct: status and approvedBy changed');
  say();
  if (rawRecord !== null) {
    say('  raw record:    ' + rawRecord);
    say('                 the only file that answers "what did the model SEE". Not published.');
    say();
  }
  say('NEXT');
  say('  npm run evidence:handoff    REQUIRED. The previous handoff was cleared with the rest of');
  say('                              the old bundle, because it replayed a different artifact.');
  say('  npm run evidence:verify     the gate');
  say();
}

const program = new Command();
program
  .name('evidence:automated')
  .description('One real discovery, approval, a fixture restart, and five deterministic replays.')
  .option(
    '--reuse <dir>',
    'skip discovery and reuse the run in this runtime directory (it already cost money)',
  )
  .action(main);

await program.parseAsync(process.argv);
