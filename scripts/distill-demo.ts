import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { distill } from '../src/artifact/distill.js';
import { contentHash } from '../src/artifact/hash.js';
import { FileCapabilityStore } from '../src/artifact/store.js';
import { EvidenceWriter } from '../src/evidence/logger.js';
import { DefaultTargetResolver } from '../src/perception/resolver.js';
import { CONFIG_ROOT, runScriptedDiscovery } from './lib/scripted-run.js';
import { HAPPY_PATH, INPUTS } from './lib/happy-path.js';

/**
 * `npm run distill:demo`
 *
 * ==============================================================================================
 * A REAL RUN WITH A SCRIPTED DECISION-MAKER. NO MODEL IS CALLED.
 * ==============================================================================================
 *
 * Everything except the choice of action is genuine: a real browser, the real fixture, the real
 * accessibility tree, the real input path, the real resolver, the real guardrails, and the real
 * distiller. The only thing replaced is the model, by the same scripted client the tests use.
 *
 * The artifact says so about itself. Its provenance records
 * `model: "scripted-fake-NO-MODEL-WAS-CALLED"`, so a file produced here can never be mistaken for
 * the output of a genuine discovery run.
 *
 * WHY THIS EXISTS. At GATE 1 the model becomes a variable. This command lets the distiller be
 * examined while it is the ONLY variable: schema readability, the parameterization sweep, the
 * shape of the steps. Debugging two things at once is how a gate turns into an afternoon.
 */
const ARTIFACT_ROOT = 'artifacts-demo';

async function main(): Promise<void> {
  const headed = process.argv.includes('--headed');
  const runId = 'distill-demo-' + Date.now();
  const evidence = new EvidenceWriter({ runId });

  console.log('Running the scripted happy path against the real fixture. No model is called.');
  console.log('');

  evidence.append({
    type: 'run_started',
    at: new Date().toISOString(),
    runId,
    surfaceId: 'playwright-web',
    allowedOrigin: '(ephemeral fixture)',
  });

  const { outcome } = await runScriptedDiscovery({
    script: HAPPY_PATH,
    runtimeInputs: INPUTS,
    evidence,
    headless: !headed,
  });

  const { record, result } = outcome;
  console.log('status:   ' + result.status);
  console.log('steps:    ' + record.metrics.steps + '   llm calls: ' + record.metrics.llmCalls);
  console.log('evidence: ' + evidence.runDir);

  writeFileSync(join(evidence.runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  writeFileSync(
    join(evidence.runDir, 'proposed-conditions.json'),
    JSON.stringify(record.encounteredConditions, null, 2),
    'utf8',
  );

  if (result.status !== 'success') {
    console.error('');
    console.error('the scripted run did not succeed, so there is nothing to distil');
    process.exitCode = 1;
    return;
  }

  const distilled = distill({
    run: record,
    resolver: new DefaultTargetResolver(),
    configRoot: CONFIG_ROOT,
  });

  if (!distilled.ok) {
    console.error('');
    console.error('the run succeeded but it could not be distilled into a capability:');
    for (const issue of distilled.issues) console.error('  - ' + issue.code + ': ' + issue.message);
    process.exitCode = 1;
    return;
  }

  const artifact = distilled.artifact;
  const path = join(ARTIFACT_ROOT, artifact.capabilityId, artifact.capabilityVersion + '.json');

  // A published version is immutable, so the store refuses to overwrite one. This is a THROWAWAY
  // store for reading distiller output, and a dev command you cannot run twice is a dev command
  // nobody runs, so the previous demo output is removed first - loudly.
  if (existsSync(path)) {
    console.log('');
    console.log('removing the previous demo artifact at ' + path);
    rmSync(path);
  }
  await new FileCapabilityStore(ARTIFACT_ROOT).put(artifact);

  console.log('');
  for (const note of distilled.notes) console.log('  ' + note);
  console.log('');
  console.log('artifact:     ' + path);
  console.log('content hash: ' + contentHash(artifact));
  console.log('status:       ' + artifact.status);
  console.log('provenance:   model = ' + artifact.provenance.model);
  console.log('');
  console.log('states:');
  for (const state of artifact.states) {
    console.log(
      '  ' +
        state.id.padEnd(28) +
        (state.resumeEligible ? 'resumable    ' : 'precondition ') +
        state.qualifiers.length +
        ' qualifier(s)',
    );
  }
  console.log('');
  console.log('steps:');
  for (const step of artifact.steps) {
    const target =
      step.action.type === 'navigate'
        ? '(navigate)'
        : (step.action.target.semantic.name ??
          'near: ' + (step.action.target.semantic.nearbyText ?? []).join(' | '));
    const bound =
      'value' in step.action && step.action.value.kind === 'param'
        ? '  <- {{' + step.action.value.name + '}}'
        : '';
    console.log(
      '  ' +
        step.id.padEnd(30) +
        step.action.type.padEnd(9) +
        step.risk.padEnd(18) +
        target +
        bound,
    );
  }
  console.log('');
  console.log('outputs:');
  for (const output of artifact.outputs) {
    console.log(
      '  ' +
        output.name.padEnd(14) +
        'from state "' +
        output.source.stateId +
        '" via ' +
        (output.source.target.semantic.nearbyText ?? []).join(' | '),
    );
  }
  console.log('');
  console.log('Read the whole thing with:');
  console.log('  cat ' + path.split(String.fromCharCode(92)).join('/'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
