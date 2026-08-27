import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { conditionProfilePath, loadConditionProfile } from '../artifact/profiles.js';
import { FileCapabilityStore } from '../artifact/store.js';
import { contentHash } from '../artifact/hash.js';
import { loadEnvFile } from '../config/env.js';
import { fixtureCredentials } from '../config/sign-on.js';
import { EvidenceWriter } from '../evidence/logger.js';
import { DefaultTargetResolver } from '../perception/resolver.js';
import { ReplayEngine } from '../replay/engine.js';
import { validateInvocationParams } from '../artifact/params.js';
import { formatResultForHuman } from '../replay/report.js';
import { HandoffCoordinator } from '../escalation/handoff.js';
import { startOperatorConsole, type RunningConsole } from '../escalation/console.js';
import { generateOperatorToken } from '../escalation/console-security.js';
import type { Intervention } from '../types/intervention.js';
import { allowlistPath, loadAllowlist } from '../policy/allowlist.js';
import { PolicyEngine } from '../policy/engine.js';
import { pseudonymizerFromEnv } from '../redaction/pseudonymize.js';
import type { SensitivityDeclaration } from '../redaction/masking.js';
import { loadSafetyProfile, safetyProfilePath } from '../artifact/profiles.js';
import type { CapabilityArtifact } from '../artifact/schema.js';
import { SessionBroker } from '../replay/session-broker.js';
import { headlessFromEnv } from '../surface/playwright-web/browser.js';
import type { RunResult } from '../types/run.js';

/**
 * `npm run replay -- --artifact <id>@<version> --params '<json>' [--tenant tenant-a] [--json]`
 *
 * [MUST] WITH --json, EXACTLY ONE JSON OBJECT GOES TO STDOUT AND EVERY LOG LINE GOES TO STDERR.
 *
 * This is not tidiness. The caller of this command is an AI agent reading stdout, and a single
 * stray progress line turns a machine-readable result into a parse error at the worst possible
 * moment - in production, on the run that mattered. So stdout has exactly one writer, at the very
 * end, and everything else in this file writes to stderr by construction.
 *
 * EXIT CODES (also in README):
 *    0  success
 *   10  business_outcome   the automation worked and the answer is negative
 *   20  needs_human
 *   25  cancelled
 *   30  failed
 *
 * 10 is separate from 30 on purpose: "there is no such member" must not page anybody.
 */
// Replay REQUIRES no variable - it makes no model call and the fixture accepts any operator.
// It still reads OPERATOR_ID, OPERATOR_PASSCODE and HEADLESS when they are present, so the
// file has to be loaded. Absence of .env is not an error here and must never become one.
loadEnvFile();

const EXIT_CODES: Record<RunResult['status'], number> = {
  success: 0,
  business_outcome: 10,
  needs_human: 20,
  cancelled: 25,
  failed: 30,
};

interface ReplayCliOptions {
  artifact: string;
  params: string;
  tenant?: string;
  json?: boolean;
  /** `--no-operator` makes a needs_human condition terminal, for an unattended caller. */
  operator?: boolean;
  artifacts: string;
  config: string;
  origin?: string;
}

/**
 * What this run treats as sensitive, read off the capability's own declarations.
 *
 * The DECLARED sensitivity is the primary mechanism. The shape detectors in the pseudonymizer are a
 * net under it, not a substitute: a member's NAME has no recognisable shape, and the only reason we
 * know to protect it is that a human wrote `sensitivity: pii` beside the field it came from.
 */
function sensitivityOf(
  artifact: CapabilityArtifact,
  params: Readonly<Record<string, string>>,
): SensitivityDeclaration {
  const sensitiveNames = new Set<string>();
  for (const input of artifact.inputs) {
    if (input.sensitivity === 'pii' || input.sensitivity === 'secret')
      sensitiveNames.add(input.name);
  }
  for (const output of artifact.outputs) {
    if (output.sensitivity === 'pii' || output.sensitivity === 'secret') {
      sensitiveNames.add(output.name);
    }
  }

  return {
    sensitiveNames,
    values: new Map(Object.entries(params)),
    recordIdentityParam: artifact.recordIdentity.param,
  };
}

async function run(options: ReplayCliOptions): Promise<void> {
  // Every human-facing line goes to stderr. There is one write to stdout in this file.
  const log = (line: string): void => {
    if (options.json !== true) process.stderr.write(line + String.fromCharCode(10));
  };

  const separator = options.artifact.lastIndexOf('@');
  if (separator <= 0) {
    process.stderr.write('expected <capabilityId>@<version>' + String.fromCharCode(10));
    process.exitCode = 30;
    return;
  }

  const capabilityId = options.artifact.slice(0, separator);
  const version = options.artifact.slice(separator + 1);

  const store = new FileCapabilityStore(options.artifacts);
  const artifact = await store.get(capabilityId, version);
  if (artifact === undefined) {
    process.stderr.write(
      capabilityId + '@' + version + ' is not in ' + options.artifacts + String.fromCharCode(10),
    );
    process.exitCode = 30;
    return;
  }

  const params = JSON.parse(options.params) as Record<string, unknown>;

  // STEP 1 of the execution order, before anything is opened. A caller who passed a bad member id
  // pays nothing for finding out.
  const validation = validateInvocationParams(artifact.inputs, params);
  if (!validation.ok) {
    const result: RunResult = {
      status: 'failed',
      error: 'INPUT_VALIDATION_FAILED',
      expected: null,
      observed: validation.issues.join('; '),
      attempts: 0,
      evidenceRef: '(no run: the browser was never opened)',
      metrics: {
        steps: 0,
        durationMs: 0,
        llmCalls: 0,
        recoveriesUsed: 0,
        locatorTierDowngrades: 0,
        humanInterventions: 0,
      },
    };
    if (options.json === true)
      process.stdout.write(JSON.stringify(result) + String.fromCharCode(10));
    else
      for (const issue of validation.issues)
        process.stderr.write('  - ' + issue + String.fromCharCode(10));
    process.exitCode = EXIT_CODES.failed;
    return;
  }

  const runId = 'replay-' + Date.now();

  // ============================================================================================
  // THE THREE DATA MECHANISMS, SET UP HERE AND KEPT APART.
  // ============================================================================================
  //
  //  (1) PERSISTENCE  the pseudonymizer below. Applied to events, the transcript, screenshots and
  //                   the human-readable output on stderr.
  //  (2) ARTIFACTS    scanned and REJECTED at distillation, never rewritten. Nothing here touches
  //                   the artifact.
  //  (3) CALLER       the --json result on stdout is NOT redacted. The brief requires replay to
  //                   RETURN what it read, and a capability that will not tell its caller the
  //                   answer is useless to it.
  const evidence = new EvidenceWriter({ runId, pseudonymizer: pseudonymizerFromEnv() });
  evidence.declareSensitive(sensitivityOf(artifact, validation.params));
  const origin = options.origin ?? new URL(artifact.target.entryPoint).origin;
  const resolver = new DefaultTargetResolver();

  log('capability:   ' + capabilityId + '@' + version + '  (' + artifact.status + ')');
  log('content hash: ' + contentHash(artifact));
  log('tenant:       ' + (options.tenant ?? '(default)'));
  log('origin:       ' + origin);

  // ============================================================================================
  // THE HANDOFF, WIRED FOR A REAL PERSON.
  // ============================================================================================
  //
  // The engine knows nothing about consoles. It calls `escalate` when it cannot continue; this
  // starts the console, prints where to go and blocks the run until the operator chooses. The
  // browser is HEADED by default, so the window the person is asked to work in is the one already
  // in front of them - the same context, the same page, still signed in.
  //
  // `--no-operator` turns it off, and then a needs_human condition is terminal, which is the right
  // behaviour for an unattended caller with nobody to ask.
  const coordinator = new HandoffCoordinator();
  let consoleServer: RunningConsole | undefined;
  const pending = new Map<string, (choice: 'resume' | 'abort') => void>();
  const openInterventions = new Map<string, Intervention>();

  const escalation =
    options.operator === false
      ? undefined
      : {
          escalate: async (request: { intervention: Intervention }) => {
            const intervention = request.intervention;
            openInterventions.set(intervention.id, intervention);

            consoleServer ??= await startOperatorConsole(
              {
                get: (id) => openInterventions.get(id),
                screenshot: async (id) => {
                  if (!openInterventions.has(id)) return null;
                  // A fresh MASKED capture of the same page, every poll. The evidence writer will
                  // not write an unmasked one, so what the operator sees is what a reviewer sees.
                  const ref = await brokered.surface.captureEvidence('screenshot');
                  try {
                    return 'data:image/png;base64,' + readFileSync(ref).toString('base64');
                  } catch {
                    return null;
                  }
                },
                choose: async (id, choice) => {
                  const resolve = pending.get(id);
                  if (resolve === undefined) throw new Error('that intervention is not open');
                  pending.delete(id);
                  openInterventions.delete(id);
                  resolve(choice);
                },
              },
              { token: generateOperatorToken() },
            );

            await coordinator.cede({
              surface: brokered.surface,
              lease: brokered.lease,
              session: brokered.session,
              evidence,
              interventionId: intervention.id,
              reason: intervention.stopReason,
            });

            // stderr, like every other human-facing line. The URL and the token are on SEPARATE
            // lines: a token in a URL leaks through history, Referer, proxy logs and screenshots.
            const nl = String.fromCharCode(10);
            process.stderr.write(
              nl +
                consoleServer.banner(intervention.id) +
                nl +
                nl +
                '  why:          ' +
                intervention.stopReason +
                nl +
                '  step:         ' +
                intervention.currentStep.id +
                ' - ' +
                intervention.currentStep.intent +
                nl +
                '  screen:       ' +
                intervention.state.screenIdentity +
                nl +
                nl +
                'The browser window in front of you IS the run. Act in it, then choose Resume.' +
                nl +
                'There is no "mark complete": the system re-checks the screen and decides itself.' +
                nl +
                nl,
            );

            const choice = await new Promise<'resume' | 'abort'>((resolve) => {
              pending.set(intervention.id, resolve);
            });

            const reclaimed = await coordinator.reclaim({
              surface: brokered.surface,
              lease: brokered.lease,
              session: brokered.session,
              evidence,
            });

            if (choice === 'abort') return { choice: 'abort' as const, notes: '' };
            return {
              choice: 'resume' as const,
              notes: '',
              humanEvents: reclaimed.humanEvents,
              token: reclaimed.token,
              sameSession: coordinator.sameSession(),
            };
          },
        };

  const engine = new ReplayEngine({
    resolver,
    ...(escalation === undefined ? {} : { escalation }),
    conditionProfile: loadConditionProfile(
      conditionProfilePath(
        options.config,
        artifact.profiles.condition.id,
        artifact.profiles.condition.version,
      ),
    ).profile,
    configRoot: options.config,
    evidence,
  });

  evidence.append({
    type: 'run_started',
    at: new Date().toISOString(),
    runId,
    surfaceId: 'playwright-web',
    allowedOrigin: origin,
  });

  // The configurable engine, ALONGSIDE the bootstrap minimum that the surface enforces first.
  // Supplying it also arms the browser-level origin backstop inside the broker.
  const policy = new PolicyEngine({
    allowlist: loadAllowlist(allowlistPath(options.config)),
    safetyProfile: loadSafetyProfile(
      safetyProfilePath(
        options.config,
        artifact.profiles.safety.id,
        artifact.profiles.safety.version,
      ),
    ).profile,
    runOrigin: origin,
  });

  const brokered = await new SessionBroker().open({
    origin,
    secrets: fixtureCredentials(),
    params: validation.params,
    resolver,
    headless: headlessFromEnv(),
    evidence,
    policy,
  });

  try {
    const outcome = await engine.run({
      artifact,
      params,
      surface: brokered.surface,
      token: brokered.token,
    });

    writeFileSync(
      join(evidence.runDir, 'result.json'),
      JSON.stringify(outcome.result, null, 2),
      'utf8',
    );
    writeFileSync(
      join(evidence.runDir, 'steps.json'),
      JSON.stringify(outcome.steps, null, 2),
      'utf8',
    );

    log('');
    for (const step of outcome.steps) {
      log(
        '  ' +
          step.stepId.padEnd(30) +
          step.status.padEnd(11) +
          (step.tierUsed ?? '').padEnd(28) +
          step.detail,
      );
    }
    log('');
    log('llm calls: ' + outcome.result.metrics.llmCalls);
    log('');
    // Everything a person needs to decide the next move, without opening the artifact or the
    // evidence bundle. Still on stderr: stdout has exactly one writer.
    for (const line of formatResultForHuman({ artifact, outcome }).split(String.fromCharCode(10))) {
      log(line);
    }

    if (options.json === true) {
      // THE ONLY WRITE TO STDOUT IN THIS FILE.
      process.stdout.write(JSON.stringify(outcome.result) + String.fromCharCode(10));
    }

    process.exitCode = EXIT_CODES[outcome.result.status];
  } finally {
    await consoleServer?.close();
    await brokered.close();
  }
}

const program = new Command();

program
  .name('replay')
  .description('Execute a capability artifact deterministically. No model is involved.')
  .requiredOption('--artifact <id@version>', 'capability to execute')
  .requiredOption('--params <json>', 'invocation parameters as JSON')
  .option('--tenant <name>', 'which deployment to run against')
  .option('--json', 'write exactly one JSON result object to stdout; logs go to stderr')
  .option('--artifacts <dir>', 'artifact store root', 'artifacts')
  .option('--config <dir>', 'profile config root', 'config')
  .option('--origin <url>', 'override the origin (for a fixture on an ephemeral port)')
  .option(
    '--no-operator',
    'do not offer a human handoff; a needs_human condition ends the run instead',
  )
  .action(run);

await program.parseAsync(process.argv);
