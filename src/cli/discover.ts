import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { runDiscovery } from '../agent/loop.js';
import { AnthropicLlmClient } from '../agent/anthropic-client.js';
import { distill } from '../artifact/distill.js';
import { conditionProfilePath, loadConditionProfile } from '../artifact/profiles.js';
import { FileCapabilityStore } from '../artifact/store.js';
import { loadEnvFile, MissingEnvError, requireEnv } from '../config/env.js';
import { allowlistPath, loadAllowlist } from '../policy/allowlist.js';
import { PolicyEngine } from '../policy/engine.js';
import { installOriginBackstop } from '../policy/backstop.js';
import { pseudonymizerFromEnv } from '../redaction/pseudonymize.js';
import { loadSafetyProfile, safetyProfilePath } from '../artifact/profiles.js';
import { validateInvocationParams } from '../artifact/params.js';
import { fixtureCredentials, MERIDIAN_SIGN_ON } from '../config/sign-on.js';
import { loadDiscoverySpec } from '../config/spec.js';
import { EvidenceWriter } from '../evidence/logger.js';
import { DefaultTargetResolver } from '../perception/resolver.js';
import { LeaseManager } from '../session/lease.js';
import { SessionStateMachine } from '../session/state.js';
import { headlessFromEnv, launchDeterministicBrowser } from '../surface/playwright-web/browser.js';
import { PlaywrightWebSurface } from '../surface/playwright-web/surface.js';

/**
 * `npm run discover`
 *
 * [MUST] --goal is EXPLICIT. It may default to the spec goalTemplate, but the invocation and the
 * evidence both record what was actually asked. The brief asks for a natural-language goal plus a
 * target; a reviewer should be able to read both off the run rather than hunt for them.
 *
 * SIGN-ON IS NOT PART OF THE CAPABILITY. The CLI signs on before handing control to the model, and
 * the distilled artifact records "the application is showing the entry screen" as a PRECONDITION.
 * A capability that carried a credential would be a capability that could be replayed into an
 * account, which is a different and much worse thing than one that prepares a form.
 */
loadEnvFile();

interface DiscoverOptions {
  spec: string;
  goal?: string;
  target: string;
  inputs: string;
  config: string;
  artifacts: string;
}

async function run(options: DiscoverOptions): Promise<void> {
  // Reads .env first, then reports each variable's own state. See src/config/env.ts for why the
  // loading happens here rather than as an --env-file flag on the npm script.
  let apiKey: string;
  let model: string;
  try {
    const env = requireEnv(['ANTHROPIC_API_KEY', 'LLM_MODEL']);
    apiKey = env.ANTHROPIC_API_KEY;
    model = env.LLM_MODEL;
  } catch (error) {
    if (!(error instanceof MissingEnvError)) throw error;
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  const loaded = loadDiscoverySpec(options.spec);

  // ==============================================================================================
  // [MUST] ARGUMENTS ARE CHECKED BEFORE THE CLIENT IS CONSTRUCTED AND BEFORE THE BROWSER OPENS.
  // ==============================================================================================
  //
  // `runDiscovery` validates too, and that is where the property is tested. This check exists so
  // the CLI never gets as far as launching Chromium and signing on to report something it could
  // read off argv. Replay has had this ordering since PHASE 5; discovery did not, and the gap was
  // billed in real model calls.
  let runtimeInputs: Record<string, string>;
  try {
    runtimeInputs = JSON.parse(options.inputs) as Record<string, string>;
  } catch (error) {
    console.error('--inputs is not valid JSON: ' + (error as Error).message);
    process.exitCode = 2;
    return;
  }

  const validation = validateInvocationParams(loaded.spec.inputs, runtimeInputs);
  if (!validation.ok) {
    console.error(
      'INPUT_VALIDATION_FAILED' +
        String.fromCharCode(10) +
        String.fromCharCode(10) +
        validation.issues.map((issue) => '  ' + issue).join(String.fromCharCode(10)) +
        String.fromCharCode(10) +
        String.fromCharCode(10) +
        'Declared inputs for ' +
        loaded.spec.capabilityId +
        ': ' +
        loaded.spec.inputs
          .map((input) => input.name + (input.required ? '' : ' (optional)'))
          .join(', '),
    );
    process.exitCode = 2;
    return;
  }
  const goal = options.goal ?? loaded.spec.goalTemplate;
  const runId = 'discover-' + Date.now() + '-' + randomUUID().slice(0, 8);
  // The model transcript is the file most likely to contain a member's name in prose, because it
  // is the one place a model writes sentences about what it is looking at. It is pseudonymized on
  // the way to disk like every other written artefact. The ARTIFACT is not rewritten - it is
  // scanned and rejected - and the caller's result is not redacted at all. Three mechanisms.
  const evidence = new EvidenceWriter({ runId, pseudonymizer: pseudonymizerFromEnv() });
  evidence.declareSensitive({
    sensitiveNames: new Set(
      loaded.spec.inputs
        .filter((input) => input.sensitivity === 'pii' || input.sensitivity === 'secret')
        .map((input) => input.name),
    ),
    values: new Map(Object.entries(runtimeInputs)),
    recordIdentityParam: loaded.spec.recordIdentity.param,
  });

  const conditionProfile = loadConditionProfile(
    conditionProfilePath(
      options.config,
      loaded.spec.conditionProfile.id,
      loaded.spec.conditionProfile.version,
    ),
  ).profile;

  const origin = new URL(loaded.spec.target.entryPoint).origin;
  const browser = await launchDeterministicBrowser({ headless: headlessFromEnv() });
  const lease = new LeaseManager();
  const session = new SessionStateMachine();
  const resolver = new DefaultTargetResolver();

  // A real model drives this browser. The bootstrap minimum has stood behind it since PHASE 2 and
  // still runs first; the configurable engine now runs alongside it, and the browser-level backstop
  // catches what the PAGE does rather than what the model asks for.
  const policy = new PolicyEngine({
    allowlist: loadAllowlist(allowlistPath(options.config)),
    safetyProfile: loadSafetyProfile(
      safetyProfilePath(
        options.config,
        loaded.spec.safetyProfile.id,
        loaded.spec.safetyProfile.version,
      ),
    ).profile,
    runOrigin: origin,
  });
  await installOriginBackstop(browser.context, policy.allowlist.allowedOrigins);

  const surface = new PlaywrightWebSurface({
    page: browser.page,
    context: browser.context,
    allowedOrigin: origin,
    lease,
    session,
    resolver,
    evidence,
    policy,
    values: {
      params: runtimeInputs,
      secrets: fixtureCredentials(),
    },
  });

  const token = lease.issue('AUTOMATION', 10 * 60 * 1000);
  evidence.append({
    type: 'run_started',
    at: new Date().toISOString(),
    runId,
    surfaceId: surface.id,
    allowedOrigin: origin,
  });

  try {
    await surface.resolveAndPerform({ type: 'navigate', pathSegments: [] }, token);
    // ONE sign-on definition, shared with the replay SessionBroker. Discovery and replay must
    // authenticate by the same path: if they diverge, a capability is recorded against a screen
    // state that its own replay never reaches, and the mismatch surfaces as a locator failure
    // somewhere downstream rather than as the configuration drift it actually is.
    await surface.resolveAndPerform(
      {
        type: 'type',
        target: MERIDIAN_SIGN_ON.operator,
        value: { kind: 'secretRef', name: MERIDIAN_SIGN_ON.operatorSecretRef },
      },
      token,
    );
    await surface.resolveAndPerform(
      {
        type: 'type',
        target: MERIDIAN_SIGN_ON.passcode,
        value: { kind: 'secretRef', name: MERIDIAN_SIGN_ON.passcodeSecretRef },
      },
      token,
    );
    await surface.resolveAndPerform({ type: 'click', target: MERIDIAN_SIGN_ON.submit }, token);
    await surface.waitFor(
      { kind: 'text_present', text: MERIDIAN_SIGN_ON.authenticatedText },
      15_000,
    );

    const { record, result } = await runDiscovery({
      spec: loaded.spec,
      specHash: loaded.specHash,
      goal,
      target: options.target,
      runtimeInputs,
      surface,
      token,
      lease,
      session,
      resolver,
      client: new AnthropicLlmClient({ apiKey, model }),
      conditionProfile,
      evidence,
    });

    await surface.captureEvidence('screenshot');
    writeFileSync(join(evidence.runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    writeFileSync(
      join(evidence.runDir, 'metrics.json'),
      JSON.stringify(record.metrics, null, 2),
      'utf8',
    );
    // ============================================================================================
    // THE FULL RUN RECORD, so a distillation can be RE-DONE without paying for another run.
    // ============================================================================================
    //
    // Absent until after GATE 1, and its absence was felt immediately: the first run produced an
    // artifact with a member id in a step intent, and there was no way to re-distill the same run
    // against a fixed distiller to prove the fix. Evidence answered "what happened"; nothing
    // answered "what would this same run produce now".
    //
    // It contains observations, so it contains screen text, which can contain PII. It is written
    // under /runs, which is gitignored, alongside the screenshots that already have the same
    // property. PHASE 7 pseudonymizes persisted evidence and this file is part of that scope.
    writeFileSync(join(evidence.runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');

    // Conditions the run ENCOUNTERED live here and ONLY here. They never enter the artifact.
    writeFileSync(
      join(evidence.runDir, 'proposed-conditions.json'),
      JSON.stringify(record.encounteredConditions, null, 2),
      'utf8',
    );

    console.log('');
    console.log('run:      ' + runId);
    console.log('goal:     ' + goal);
    console.log('target:   ' + options.target);
    console.log('status:   ' + result.status);
    console.log('steps:    ' + record.metrics.steps + '   llm calls: ' + record.metrics.llmCalls);
    console.log('evidence: ' + evidence.runDir);

    if (result.status !== 'success') {
      process.exitCode = 1;
      return;
    }

    const distilled = distill({ run: record, resolver, configRoot: options.config });
    if (!distilled.ok) {
      console.error('');
      console.error('the run succeeded but it could not be distilled into a capability:');
      for (const issue of distilled.issues) {
        console.error('  - ' + issue.code + ': ' + issue.message);
      }
      process.exitCode = 1;
      return;
    }

    await new FileCapabilityStore(options.artifacts).put(distilled.artifact);
    console.log('');
    for (const note of distilled.notes) console.log('  ' + note);
    console.log(
      'artifact: ' +
        options.artifacts +
        '/' +
        distilled.artifact.capabilityId +
        '/' +
        distilled.artifact.capabilityVersion +
        '.json (draft)',
    );
  } finally {
    await browser.close();
  }
}

const program = new Command();

program
  .name('discover')
  .description('Drive a live UI with a model until a natural-language goal is met.')
  .requiredOption('--spec <path>', 'DiscoverySpec YAML')
  .option('--goal <text>', 'the natural-language goal (defaults to the spec goalTemplate)')
  .requiredOption('--target <tenant>', 'which deployment to drive')
  .requiredOption('--inputs <json>', 'invocation inputs as JSON')
  .option('--config <dir>', 'profile config root', 'config')
  .option('--artifacts <dir>', 'artifact store root', 'artifacts')
  .action(run);

await program.parseAsync(process.argv);
