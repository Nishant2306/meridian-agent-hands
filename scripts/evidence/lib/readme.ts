import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from './manifest.js';
import { EVIDENCE_ROOT, NL } from './runtime.js';

/**
 * ================================================================================================
 * THE BUNDLE README IS GENERATED FROM THE RUN FILES, NEVER TYPED.
 * ================================================================================================
 *
 * `evidence/README.md` shipped with all 24 `<<FILL AFTER RUN>>` markers still in it, because filling
 * them was a manual step nobody was going to remember. Filling them BY HAND would be worse: it goes
 * stale the next time the bundle is regenerated, which is the exact class of rot `docs.paths` and
 * D72 exist to prevent.
 *
 * TWO RULES, and they are the whole design.
 *
 * (1) EVERY VALUE COMES FROM A FILE IN THE BUNDLE. Not from the orchestrator's memory of what it
 *     just did. The orchestrator knows what it asked for; the run files record what happened, and
 *     those are the only thing a reviewer can check. `evidence:verify` re-derives its claims from
 *     the same files, so the README and the gate cannot disagree about what the run did.
 *
 *     The one exception is marked, exactly as the verifier marks its own: a value that can only come
 *     from the manifest is rendered `[manifest] <value>` rather than asserted. Which member each run
 *     used is the case - the run files are pseudonymized with a per-run random map, so the bundle
 *     genuinely cannot tell you.
 *
 * (2) THE TEMPLATE STAYS IN THE REPOSITORY WITH ITS MARKERS INTACT. `README.template.md` is the
 *     source and is what you edit. `README.md` is a bundle artifact, like `manifest.json`: generated,
 *     carrying a header that names the run it came from, and regenerated whenever the bundle is.
 *     A stale one beside a fresh bundle is caught by the gate rather than left to be noticed.
 */

const MARKER = /<<FILL AFTER RUN(?:: ([A-Za-z.]+))?>>/g;

/** Set when the handoff has not been driven yet. Honest, and not a leftover marker. */
const NOT_RUN = '(not run - npm run evidence:handoff)';

interface ResultFile {
  status: string;
  outcome?: string;
  error?: string;
  expected?: string | null;
  observed?: string | null;
  completionMode?: string;
  metrics: {
    durationMs: number;
    llmCalls: number;
    recoveriesUsed: number;
    humanInterventions: number;
  };
}

interface StepFile {
  stepId: string;
  status: string;
  tierUsed: string | null;
  attempts: number;
  recoveriesAttempted?: string[];
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function runDir(root: string, scenario: string, runId: string): string {
  return join(root, scenario, runId);
}

/** How a result reads in one line: the status, plus the code that gives it meaning. */
function describe(result: ResultFile | undefined): string {
  if (result === undefined) return NOT_RUN;
  if (result.status === 'business_outcome') {
    return result.status + '  ' + String(result.outcome);
  }
  if (result.status === 'failed') return result.status + '  ' + String(result.error);
  return result.status;
}

export function renderReadme(options: {
  manifest: Manifest;
  root?: string;
}): { path: string; unfilled: string[] } {
  const root = options.root ?? EVIDENCE_ROOT;
  const manifest = options.manifest;

  const values = new Map<string, string>();
  const put = (key: string, value: string | undefined): void => {
    values.set(key, value === undefined || value === '' ? NOT_RUN : value);
  };

  const scenarioFiles = (
    scenario: string,
    runId: string,
  ): { result?: ResultFile; steps?: StepFile[]; dir: string } => {
    const dir = runDir(root, scenario, runId);
    return {
      dir,
      ...(readJson<ResultFile>(join(dir, 'result.json')) === undefined
        ? {}
        : { result: readJson<ResultFile>(join(dir, 'result.json')) }),
      ...(readJson<StepFile[]>(join(dir, 'steps.json')) === undefined
        ? {}
        : { steps: readJson<StepFile[]>(join(dir, 'steps.json')) }),
    };
  };

  // ---- discovery ---------------------------------------------------------------------------------
  const discoveryDir = runDir(root, 'discovery', manifest.discoveryRunId);
  const completion = readJson<{ model: string; metrics: { llmCalls: number; steps: number } }>(
    join(discoveryDir, 'completion.json'),
  );
  const discoveryResult = readJson<ResultFile>(join(discoveryDir, 'result.json'));

  put('discovery.runId', existsSync(discoveryDir) ? manifest.discoveryRunId : undefined);
  put(
    'discovery.model',
    completion === undefined
      ? undefined
      : completion.model +
          '   ' +
          String(completion.metrics.llmCalls) +
          ' calls over ' +
          String(completion.metrics.steps) +
          ' steps',
  );
  put('discovery.result', describe(discoveryResult));

  // ---- success -----------------------------------------------------------------------------------
  const success = scenarioFiles('success', manifest.replayRunIds.success);
  put('success.runId', existsSync(success.dir) ? manifest.replayRunIds.success : undefined);
  put('success.result', describe(success.result));
  put(
    'success.llmCalls',
    success.result === undefined ? undefined : String(success.result.metrics.llmCalls),
  );
  put(
    'success.tiers',
    success.steps === undefined
      ? undefined
      : success.steps
          .filter((step) => step.tierUsed !== null)
          .map((step) => step.stepId + ' -> ' + String(step.tierUsed))
          .join(NL + '             '),
  );
  // [manifest]: the run files are pseudonymized with a map that is random PER RUN, so the bundle
  // cannot say which member this was. Marked rather than asserted, exactly as the verifier does.
  const successMember = manifest.scenarios.find((entry) => entry.scenario === 'success')?.params[
    'memberId'
  ];
  put(
    'success.member',
    successMember === undefined
      ? undefined
      : '[manifest] ' + successMember + ', against discovery on ' + manifest.discovery.memberId,
  );

  // ---- notFound ----------------------------------------------------------------------------------
  const notFound = scenarioFiles('notFound', manifest.replayRunIds.notFound);
  put('notFound.runId', existsSync(notFound.dir) ? manifest.replayRunIds.notFound : undefined);
  put('notFound.result', describe(notFound.result));
  put(
    'notFound.elapsed',
    notFound.result === undefined ? undefined : String(notFound.result.metrics.durationMs) + 'ms',
  );

  // ---- recovery ----------------------------------------------------------------------------------
  const recovery = scenarioFiles('recovery', manifest.replayRunIds.recovery);
  const recovered = (recovery.steps ?? []).find(
    (step) => (step.recoveriesAttempted ?? []).length > 0,
  );
  put('recovery.runId', existsSync(recovery.dir) ? manifest.replayRunIds.recovery : undefined);
  put('recovery.result', describe(recovery.result));
  put(
    'recovery.recoveriesUsed',
    recovery.result === undefined ? undefined : String(recovery.result.metrics.recoveriesUsed),
  );
  put(
    'recovery.attempts',
    recovered === undefined
      ? undefined
      : String(recovered.attempts) + '   on ' + recovered.stepId,
  );

  // ---- permissionDenied --------------------------------------------------------------------------
  const denied = scenarioFiles('permissionDenied', manifest.replayRunIds.permissionDenied);
  put(
    'permissionDenied.runId',
    existsSync(denied.dir) ? manifest.replayRunIds.permissionDenied : undefined,
  );
  put('permissionDenied.error', denied.result?.error);
  put('permissionDenied.expected', denied.result?.expected ?? undefined);
  put('permissionDenied.observed', denied.result?.observed ?? undefined);

  // ---- unavailable -------------------------------------------------------------------------------
  const unavailable = scenarioFiles('unavailable', manifest.replayRunIds.unavailable);
  put(
    'unavailable.runId',
    existsSync(unavailable.dir) ? manifest.replayRunIds.unavailable : undefined,
  );
  put('unavailable.error', unavailable.result?.error);
  put(
    'unavailable.stepsCompleted',
    unavailable.steps === undefined
      ? undefined
      : String(unavailable.steps.filter((step) => step.status === 'performed').length) +
          ' of ' +
          String(unavailable.steps.length),
  );

  // ---- handoff -----------------------------------------------------------------------------------
  const handoffId = manifest.replayRunIds.handoff;
  const handoff = handoffId === '' ? undefined : scenarioFiles('handoff', handoffId);
  put('handoff.runId', handoff !== undefined && existsSync(handoff.dir) ? handoffId : undefined);
  put('handoff.result', handoff === undefined ? undefined : describe(handoff.result));
  put('handoff.completionMode', handoff?.result?.completionMode);
  put(
    'handoff.interventions',
    handoff?.result === undefined
      ? undefined
      : String(handoff.result.metrics.humanInterventions),
  );

  // The same-session claim comes from the EVENT STREAM, which is where the comparison was recorded.
  // Reading it back rather than restating it is the difference between evidence and a caption.
  let sameSession: string | undefined;
  if (handoff !== undefined && existsSync(join(handoff.dir, 'events.jsonl'))) {
    const comparisons = readFileSync(join(handoff.dir, 'events.jsonl'), 'utf8')
      .split(NL)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event['type'] === 'handoff_same_session');
    if (comparisons.length > 0) {
      sameSession =
        comparisons.every((event) => event['same'] === true) ? 'true' : 'FALSE - see events.jsonl';
      sameSession += '   (' + String(comparisons.length) + ' comparison(s))';
    }
  }
  put('handoff.sameSession', sameSession);

  // ---- render ------------------------------------------------------------------------------------
  const templatePath = join(root, 'README.template.md');
  const template = readFileSync(templatePath, 'utf8');
  const unfilled: string[] = [];

  const body = template.replace(MARKER, (whole, key: string | undefined) => {
    if (key === undefined) return whole;
    const value = values.get(key);
    if (value === undefined) {
      unfilled.push(key);
      return whole;
    }
    return value;
  });

  const header =
    '<!-- GENERATED by npm run evidence:automated / evidence:handoff.' +
    NL +
    '     Source: evidence/README.template.md. Do not edit this file; edit the template.' +
    NL +
    '     Every value below is read from a file in this bundle, except where marked [manifest]. -->' +
    NL +
    NL +
    '> Generated ' +
    new Date().toISOString() +
    ' from discovery run `' +
    manifest.discoveryRunId +
    '`.' +
    NL;

  const path = join(root, 'README.md');
  writeFileSync(path, header + body, 'utf8');
  return { path, unfilled };
}

/** Bundle files that may still carry a marker, for the gate to look at. */
export function markersIn(root = EVIDENCE_ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.md') || entry === 'README.template.md') continue;
    const text = readFileSync(join(root, entry), 'utf8');
    if (text.includes('<<FILL AFTER RUN')) found.push(entry);
  }
  return found;
}
