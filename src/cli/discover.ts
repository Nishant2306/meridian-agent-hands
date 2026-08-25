import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { runDiscovery } from '../agent/loop.js';
import { AnthropicLlmClient } from '../agent/anthropic-client.js';
import { distill } from '../artifact/distill.js';
import { conditionProfilePath, loadConditionProfile } from '../artifact/profiles.js';
import { FileCapabilityStore } from '../artifact/store.js';
import { loadDiscoverySpec } from '../config/spec.js';
import { EvidenceWriter } from '../evidence/logger.js';
import { DefaultTargetResolver } from '../perception/resolver.js';
import { LeaseManager } from '../session/lease.js';
import { SessionStateMachine } from '../session/state.js';
import { headlessFromEnv, launchDeterministicBrowser } from '../surface/playwright-web/browser.js';
import { PlaywrightWebSurface } from '../surface/playwright-web/surface.js';
import type { TargetDescriptor } from '../types/control.js';

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
const descriptor = (
  semantic: TargetDescriptor['semantic'],
  recordedTier: TargetDescriptor['recordedTier'],
): TargetDescriptor => ({ semantic, recordedTier });

const SIGN_ON = {
  operator: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Operator ID'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  passcode: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Passcode'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  logIn: descriptor({ role: 'button', name: 'Log In', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME'),
};

interface DiscoverOptions {
  spec: string;
  goal?: string;
  target: string;
  inputs: string;
  config: string;
  artifacts: string;
}

async function run(options: DiscoverOptions): Promise<void> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const model = process.env['LLM_MODEL'];
  if (apiKey === undefined || apiKey === '' || model === undefined || model === '') {
    console.error('ANTHROPIC_API_KEY and LLM_MODEL must be set. Copy .env.example to .env.');
    process.exitCode = 2;
    return;
  }

  const loaded = loadDiscoverySpec(options.spec);
  const runtimeInputs = JSON.parse(options.inputs) as Record<string, string>;
  const goal = options.goal ?? loaded.spec.goalTemplate;
  const runId = 'discover-' + Date.now() + '-' + randomUUID().slice(0, 8);
  const evidence = new EvidenceWriter({ runId });

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

  const surface = new PlaywrightWebSurface({
    page: browser.page,
    context: browser.context,
    allowedOrigin: origin,
    lease,
    session,
    resolver,
    evidence,
    values: {
      params: runtimeInputs,
      secrets: {
        operatorId: process.env['OPERATOR_ID'] ?? 'fixture-operator',
        operatorPasscode: process.env['OPERATOR_PASSCODE'] ?? 'fixture-passcode',
      },
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
    await surface.resolveAndPerform(
      { type: 'type', target: SIGN_ON.operator, value: { kind: 'secretRef', name: 'operatorId' } },
      token,
    );
    await surface.resolveAndPerform(
      {
        type: 'type',
        target: SIGN_ON.passcode,
        value: { kind: 'secretRef', name: 'operatorPasscode' },
      },
      token,
    );
    await surface.resolveAndPerform({ type: 'click', target: SIGN_ON.logIn }, token);
    await surface.waitFor({ kind: 'text_present', text: 'Member Search' }, 15_000);

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
