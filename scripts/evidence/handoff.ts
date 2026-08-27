import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../../src/config/env.js';
import { readManifest, readRuntimeRef, writeManifest } from './lib/manifest.js';
import { renderReadme } from './lib/readme.js';
import {
  bootFixture,
  copyIntoBundle,
  EVIDENCE_ROOT,
  CONFIG_ROOT,
  newestRunDir,
  runCli,
  say,
} from './lib/runtime.js';

/**
 * ================================================================================================
 * `npm run evidence:handoff` - THE ONE SCENARIO THAT NEEDS A PERSON, AND SAYS SO.
 * ================================================================================================
 *
 * Everything else in the evidence sweep is unattended. This is not, and pretending otherwise would
 * be the mistake this project has made three times already and written up as D66: the mechanism
 * gets a passing test, the path a human actually walks does not work at all, and nothing notices
 * because no test ever did what a person does.
 *
 * So this command blocks. It boots the fixture, starts a real replay against member 20001 in a
 * HEADED browser, and waits. Member 20001 raises a compliance modal that the pinned condition
 * profile deliberately does NOT describe - an unrecognised blocking dialog, detected structurally
 * by role rather than by wording, which is the fifth rung of the detector ladder and the only one
 * whose answer is "ask a human".
 *
 * WHAT YOU DO, and the run prints this again when it stops:
 *
 *   1. the replay stops and prints an operator console URL and, on a SEPARATE line, a token.
 *      Separate because a token in a URL leaks through history, Referer headers, proxy logs and
 *      screenshots.
 *   2. open the URL, paste the token. The browser window already in front of you IS the run: the
 *      same browser context, the same page, still signed on. You are not being given a copy.
 *   3. clear the modal in that window. The attestation code is printed on screen.
 *   4. choose Resume in the console.
 *
 * There is no "mark complete", and there is no /complete endpoint to add one to. The system
 * re-observes, validates every declared output against its declared type, checks the record
 * identity and declares success itself, recording `completionMode: 'human_assisted'`. The rule that
 * only the system may declare success binds the operator exactly as it binds the model.
 *
 * Choosing Resume while the modal is still on screen is a legitimate thing to try. The run tells
 * you that it is still in the way and hands control back rather than resuming into it.
 */
loadEnvFile();

const MANIFEST = join(EVIDENCE_ROOT, 'manifest.json');

function requireManifest(): ReturnType<typeof readManifest> {
  if (!existsSync(MANIFEST)) {
    say();
    say('There is no /evidence/manifest.json.');
    say();
    say('Run `npm run evidence:automated` first. This command replays the capability that run');
    say('discovered and approved, so there is nothing for it to drive until that exists.');
    say();
    process.exit(2);
  }
  return readManifest(MANIFEST);
}

async function main(): Promise<void> {
  const manifest = requireManifest();
  const runtimeRefPath = join(EVIDENCE_ROOT, '.runtime.json');

  if (!existsSync(runtimeRefPath)) {
    say();
    say('There is no ' + runtimeRefPath + '.');
    say();
    say('It records where the automated evidence run put its artifact store, is deliberately kept');
    say('out of the manifest because it is an absolute path with a username in it, and is not in');
    say('git. Re-run `npm run evidence:automated` on this machine and then this command.');
    say();
    process.exit(2);
  }
  const runtime = readRuntimeRef(runtimeRefPath);

  if (!existsSync(runtime.artifactStore)) {
    say();
    say('The runtime directory from the automated evidence run is gone:');
    say('  ' + runtime.runtimeDir);
    say();
    say('It lives under the system temp directory, so this happens if the machine has been');
    say('cleaned up since. Re-run `npm run evidence:automated` and then this command.');
    say();
    process.exit(2);
  }

  const fixture = await bootFixture();
  const capability = manifest.capability.id + '@' + manifest.capability.version;

  say();
  say('HUMAN HANDOFF - this run will STOP and wait for you.');
  say();
  say('  capability:  ' + capability);
  say('  member:      20001   (raises a modal the condition profile does not describe)');
  say('  fixture:     ' + fixture.origin + '   seed ' + fixture.seed);
  say('  browser:     HEADED. The window that opens is the run.');
  say();
  say('When it stops it prints a console URL and a token on separate lines. Open the URL, paste');
  say('the token, clear the modal IN THE BROWSER WINDOW, then choose Resume. The attestation code');
  say('is printed on screen. There is no "mark complete": the system re-checks and decides.');
  say();

  try {
    await runCli({
      script: 'src/cli/replay.ts',
      args: [
        '--artifact',
        capability,
        '--params',
        JSON.stringify({
          memberId: '20001',
          accountType: 'Savings',
          nickname: 'Attested',
          initialDeposit: '125.00',
        }),
        '--artifacts',
        runtime.artifactStore,
        '--config',
        CONFIG_ROOT,
        '--origin',
        fixture.origin,
      ],
      cwd: runtime.runtimeDir,
      // HEADED, and the terminal is inherited so the banner, the URL and the token appear live
      // rather than after the fact. A handoff you cannot see while it is happening is not one.
      env: { HEADLESS: 'false' },
      interactive: true,
    });
  } finally {
    await fixture.close();
  }

  const runDir = newestRunDir(join(runtime.runtimeDir, 'runs'), 'replay-');
  const runId = runDir.split(/[\\/]/).pop() ?? runDir;
  const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')) as {
    status: string;
    completionMode?: string;
    metrics: { humanInterventions: number };
  };

  copyIntoBundle(runDir, 'handoff');

  const updated = {
    ...manifest,
    replayRunIds: { ...manifest.replayRunIds, handoff: runId },
    scenarios: [
      ...manifest.scenarios.filter((entry) => entry.scenario !== 'handoff'),
      {
        scenario: 'handoff',
        runId,
        params: { memberId: '20001', accountType: 'Savings', initialDeposit: '125.00' },
        status: result.status,
        exitCode: result.status === 'success' ? 0 : result.status === 'cancelled' ? 25 : 30,
        proves:
          'Control passes to a person and back on the SAME live session, evidenced by the browser ' +
          'context and page target ids recorded before and after. The system, not the operator, ' +
          'declares the run complete.',
      },
    ],
  };
  writeManifest(MANIFEST, updated);
  // Regenerated, so the handoff section stops saying "not run". Same source as everything else: the
  // files in the bundle.
  renderReadme({ manifest: updated });

  say();
  say('handoff run:        ' + runId);
  say('status:             ' + result.status);
  say('completion mode:    ' + (result.completionMode ?? '(not a success)'));
  say('interventions:      ' + result.metrics.humanInterventions);
  say('copied to:          ' + join(EVIDENCE_ROOT, 'handoff', runId));
  say();
  say('An ABORT here is a legitimate outcome and the bundle records it as one: status cancelled,');
  say('exit 25, a person decided to stop. It is not a malfunction and it is not a failure.');
  say();
  say('Now run: npm run evidence:verify');
  say();
}

await main();
