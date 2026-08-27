import { join } from 'node:path';
import type { ScenarioRecord } from './manifest.js';
import {
  bootFixture,
  CONFIG_ROOT,
  copyIntoBundle,
  newestRunDir,
  runCli,
  say,
  type BootedFixture,
} from './runtime.js';

/**
 * ================================================================================================
 * THE FIVE UNATTENDED SCENARIOS, SEPARATED FROM THE COMMAND THAT PAYS FOR A DISCOVERY.
 * ================================================================================================
 *
 * This lives in its own file for one reason: `npm run evidence:automated` spends real money on a
 * model call and then does all of this afterwards. A bug in the replay sweep or in the bundle
 * copying would surface only after the paid step, and the way to find it out is a test that runs
 * exactly this code against the tracked example capability, for free.
 *
 * `tests/integration/evidence.sweep.live.test.ts` does that, and also drives the real verifier over
 * the bundle it produces.
 */

export type ScenarioKey =
  | 'success'
  | 'notFound'
  | 'recovery'
  | 'permissionDenied'
  | 'unavailable';

export interface ReplayScenario {
  readonly scenario: ScenarioKey;
  readonly params: Record<string, string>;
  readonly expectStatus: string;
  readonly expectExit: number;
  readonly proves: string;
  /**
   * Armed on a DEDICATED fixture boot, pinned to one fault-session key.
   *
   * Only `unavailable` needs one. Every other condition here is a property of the SEEDED RECORD,
   * which is the more honest subject: a caller asking about member 10003 is refused without anybody
   * having armed anything, which is how the real system would behave.
   */
  readonly fault?: { readonly http500OnRoute: string };
}

/** The member the model drives during discovery. The success replay must not reuse it. */
export const DISCOVERY_MEMBER = '10001';

export const DISCOVERY_INPUTS: Readonly<Record<string, string>> = {
  memberId: DISCOVERY_MEMBER,
  accountType: 'Savings',
  nickname: 'Holiday Fund',
  initialDeposit: '250.00',
};

const REPLAY_MEMBER = '10002';

export const REPLAY_SCENARIOS: readonly ReplayScenario[] = [
  {
    scenario: 'success',
    params: {
      memberId: REPLAY_MEMBER,
      accountType: 'Savings',
      nickname: 'Rainy Day',
      initialDeposit: '400.00',
    },
    expectStatus: 'success',
    expectExit: 0,
    proves:
      'The capability replays on a member the discovery run never saw, against a fixture booted ' +
      'with a different obfuscation seed, with zero model calls.',
  },
  {
    scenario: 'notFound',
    params: { memberId: '99999', accountType: 'Savings', initialDeposit: '100.00' },
    expectStatus: 'business_outcome',
    expectExit: 10,
    proves:
      'A negative answer is a BUSINESS OUTCOME with exit code 10, not a failure. There is no ' +
      'RECORD_NOT_FOUND error anywhere in the type system, so a caller cannot confuse the two.',
  },
  {
    scenario: 'recovery',
    params: {
      memberId: '10004',
      accountType: 'Checking',
      nickname: 'Notice Case',
      initialDeposit: '75.00',
    },
    expectStatus: 'success',
    expectExit: 0,
    proves:
      'A known condition described by the pinned profile is cleared by the automation, once, and ' +
      'the interrupted click is NOT repeated: the recovery rechecks the effect instead.',
  },
  {
    scenario: 'permissionDenied',
    params: { memberId: '10003', accountType: 'Savings', initialDeposit: '100.00' },
    expectStatus: 'failed',
    expectExit: 30,
    proves:
      'A hard failure reports EXPECTED beside OBSERVED, because one half of a disagreement is ' +
      'not a diagnosis.',
  },
  {
    scenario: 'unavailable',
    params: {
      memberId: REPLAY_MEMBER,
      accountType: 'Savings',
      nickname: 'Rainy Day',
      initialDeposit: '400.00',
    },
    expectStatus: 'failed',
    expectExit: 30,
    proves:
      'The application goes down part way through. The steps that completed are recorded, the ' +
      'condition is read off the page the application rendered rather than off a status code, ' +
      'and the run stops.',
    fault: { http500OnRoute: '/member/' + REPLAY_MEMBER + '/subaccount/new' },
  },
];

export interface SweepResult {
  readonly scenarios: ScenarioRecord[];
  readonly runIds: Record<string, string>;
  /** Scenarios whose status or exit code was not the one declared above. Empty on a good sweep. */
  readonly mismatches: string[];
}

export async function runReplaySweep(options: {
  capabilityId: string;
  capabilityVersion: string;
  artifacts: string;
  /** cwd for the CLI, which is also where its EvidenceWriter puts `runs/`. */
  cwd: string;
  /** The already-running fixture for the unfaulted scenarios. */
  fixture: BootedFixture;
  headless: boolean;
  evidenceRoot?: string;
}): Promise<SweepResult> {
  const scenarios: ScenarioRecord[] = [];
  const runIds: Record<string, string> = {};
  const mismatches: string[] = [];

  for (const scenario of REPLAY_SCENARIOS) {
    // A scenario with an armed fault gets its OWN boot, so nothing else in the sweep can see it.
    const fixture = scenario.fault === undefined ? options.fixture : await bootFixture();
    if (scenario.fault !== undefined) fixture.pinFaults(scenario.fault);

    const result = await runCli({
      script: 'src/cli/replay.ts',
      args: [
        '--artifact',
        options.capabilityId + '@' + options.capabilityVersion,
        '--params',
        JSON.stringify(scenario.params),
        '--artifacts',
        options.artifacts,
        '--config',
        CONFIG_ROOT,
        '--origin',
        fixture.origin,
        '--json',
        // Unattended. A needs_human condition is terminal here: the handoff has its own command
        // because it needs a person, and a run that blocked forever inside an automated sweep
        // would be indistinguishable from one that hung.
        '--no-operator',
      ],
      cwd: options.cwd,
      env: { HEADLESS: options.headless ? 'true' : 'false' },
    });

    if (scenario.fault !== undefined) {
      fixture.clearFaults();
      await fixture.close();
    }

    const line = result.stdout.split('\n').find((entry) => entry.trim() !== '') ?? '';
    let status = '(no result on stdout)';
    try {
      status = (JSON.parse(line) as { status: string }).status;
    } catch {
      mismatches.push(scenario.scenario + ': the CLI wrote no parseable result to stdout');
      process.stderr.write(result.stderr);
    }

    const runDir = newestRunDir(join(options.cwd, 'runs'), 'replay-');
    const runId = runDir.split(/[\\/]/).pop() ?? runDir;
    copyIntoBundle(runDir, scenario.scenario, options.evidenceRoot);

    const ok = status === scenario.expectStatus && result.code === scenario.expectExit;
    if (!ok) {
      mismatches.push(
        scenario.scenario +
          ': got ' +
          status +
          '/' +
          String(result.code) +
          ', expected ' +
          scenario.expectStatus +
          '/' +
          String(scenario.expectExit),
      );
    }

    say(
      '  ' +
        scenario.scenario.padEnd(18) +
        status.padEnd(18) +
        'exit ' +
        String(result.code).padEnd(5) +
        (ok ? '' : 'EXPECTED ' + scenario.expectStatus + ' / ' + String(scenario.expectExit)),
    );

    runIds[scenario.scenario] = runId;
    scenarios.push({
      scenario: scenario.scenario,
      runId,
      params: scenario.params,
      status,
      exitCode: result.code ?? -1,
      proves: scenario.proves,
    });
  }

  return { scenarios, runIds, mismatches };
}
