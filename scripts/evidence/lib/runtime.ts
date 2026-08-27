import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createLegacyApp } from '../../../fixtures/legacy-app/server.js';
import { FAULT_SESSION_HEADER, type FaultFlags } from '../../../fixtures/legacy-app/faults.js';
import { tenantA } from '../../../fixtures/legacy-app/tenants/tenant-a.js';

export const REPO = fileURLToPath(new URL('../../..', import.meta.url));
export const CONFIG_ROOT = join(REPO, 'config');
/**
 * Where the published bundle goes.
 *
 * `EVIDENCE_DIR` overrides it, and exists for exactly one caller: the test that drives this whole
 * machinery against the tracked example capability, into a temporary directory, so that a bug in
 * the sweep or in the verifier is found for free rather than after a paid discovery run.
 */
export const EVIDENCE_ROOT = process.env['EVIDENCE_DIR'] ?? join(REPO, 'evidence');
export const SPEC = join(REPO, 'config', 'specs', 'prepare_subaccount_review.yaml');

export const NL = String.fromCharCode(10);
export function say(line = ''): void {
  process.stdout.write(line + NL);
}

/**
 * The fault-session key this boot pins onto every request.
 *
 * WHY THIS IS NOT THE SERVER-WIDE FLAG D42 REFUSED. D42's objection was concurrency: vitest runs
 * files in parallel against one fixture module, and a global switch lets the file testing a dead
 * session break the file testing a slow load, intermittently, and the failure moves when the tests
 * are reordered.
 *
 * Nothing here is global. `createLegacyApp` is untouched and still keys faults by session. This
 * mounts the app under a parent that stamps ONE session key on every request of ONE boot, and the
 * orchestrator boots a dedicated instance for the single scenario that needs an armed fault and
 * runs it alone. An unarmed boot never has this key in the store, so the lookup falls straight
 * through to the cookie exactly as before.
 *
 * The alternative was a `--fault` flag on the replay CLI, which would put a test hook in the
 * command a bank would actually run.
 */
const PINNED_FAULT_KEY = 'evidence-orchestrator';

export interface BootedFixture {
  readonly origin: string;
  readonly seed: number;
  /** Arm faults for every request of this boot. Sequential use only; see PINNED_FAULT_KEY. */
  pinFaults(flags: FaultFlags): void;
  clearFaults(): void;
  close(): Promise<void>;
}

export async function bootFixture(options: { port?: number } = {}): Promise<BootedFixture> {
  const { app, seed, faults } = createLegacyApp({ tenant: tenantA });

  const parent = express();
  parent.use((req: Request, _res: Response, next: NextFunction) => {
    req.headers[FAULT_SESSION_HEADER] = PINNED_FAULT_KEY;
    next();
  });
  parent.use(app);

  const server = parent.listen(options.port ?? 0);
  const origin = await new Promise<string>((resolve, reject) => {
    server.on('error', reject);
    server.on('listening', () => {
      const address = server.address() as AddressInfo;
      resolve('http://127.0.0.1:' + address.port);
    });
  });

  return {
    origin,
    seed,
    pinFaults: (flags) => faults.set(PINNED_FAULT_KEY, flags),
    clearFaults: () => faults.clear(PINNED_FAULT_KEY),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run one of the real CLIs as a real subprocess.
 *
 * THE COMMANDS IN README.md ARE THESE COMMANDS. The orchestrator could call the engine in process
 * and would be shorter for it, and then the evidence would prove that a function works rather than
 * that the documented path does. D66: where a human-facing path exists, use it the way the human
 * does.
 *
 * Resolves on 'exit' rather than on stdio close, because Chromium is a grandchild holding the
 * inherited pipes and 'close' waits for it long after the CLI has printed its result and gone.
 */
/**
 * `tsx`, resolved to an absolute URL against THIS file rather than against the child's cwd.
 *
 * `--import tsx` is a bare specifier and Node resolves it from the child process's working
 * directory. Every CLI here runs with its cwd set to an isolated runtime directory outside the
 * repository, so the bare form fails with ERR_MODULE_NOT_FOUND before the CLI starts. Found by
 * `tests/integration/evidence.sweep.live.test.ts` on its first run, which is the entire reason that
 * test exists: this would otherwise have surfaced immediately after a paid discovery.
 *
 * `createRequire(...).resolve` rather than `import.meta.resolve`, because vitest's SSR transform
 * does not provide the latter and this module is imported by a test as well as by the CLI scripts.
 */
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export async function runCli(options: {
  script: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Inherit the terminal, for the interactive handoff where a person has to read the banner. */
  interactive?: boolean;
}): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ['--import', TSX, join(REPO, options.script), ...options.args],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.interactive === true ? 'inherit' : 'pipe',
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const code = await new Promise<number | null>((resolve) => {
    child.on('exit', (status) => setTimeout(() => resolve(status), 250));
  });
  child.kill();
  return { code, stdout, stderr };
}

/**
 * An isolated runtime, so a real discovery never writes into the repository's own stores.
 *
 * `/artifacts` matters most: a PUBLISHED version there is immutable and the store refuses to
 * overwrite it, so an evidence run that wrote to it would make the NEXT genuine discovery fail on a
 * name collision. The CLIs are given this directory as their cwd, which is also where their
 * EvidenceWriter puts `runs/`.
 */
export function createRuntime(): { dir: string; artifacts: string; runs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-evidence-'));
  const artifacts = join(dir, 'artifacts');
  const runs = join(dir, 'runs');
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(runs, { recursive: true });
  return { dir, artifacts, runs };
}

/** The run directory created most recently under a runtime's `runs/`, by mtime. */
export function newestRunDir(runsRoot: string, prefix: string): string {
  const candidates = readdirSync(runsRoot)
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, at: statSync(join(runsRoot, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  const newest = candidates[0];
  if (newest === undefined) throw new Error('no ' + prefix + '* run directory under ' + runsRoot);
  return join(runsRoot, newest.name);
}

/**
 * Files that never enter the published bundle.
 *
 * `run.json` is the full discovery record and it is deliberately NOT pseudonymized, because the
 * distiller's parameterization sweep finds runtime values by looking for them VERBATIM and a record
 * of labels would sail straight through the guard that exists to catch leaks. It is an input, not a
 * report. It stays under the gitignored runtime directory, whose path the manifest records.
 */
const NOT_PUBLISHED = new Set(['run.json']);

/**
 * ================================================================================================
 * A BUNDLE HOLDS ONE RUN OF EACH SCENARIO. THE PREVIOUS ONE IS REMOVED, NOT LEFT BESIDE IT.
 * ================================================================================================
 *
 * The manifest names one discovery and one run per scenario; the directories were never cleared, so
 * after three evidence runs `/evidence` held three of everything and the manifest described one of
 * them. A reviewer grepping the bundle hits files from runs that are not the published ones - and
 * did: a leak reported against `evidence/` came from a superseded run nobody was claiming anything
 * about. A bundle that contains more than it claims is not a bundle, it is a directory.
 *
 * [MUST] THE HANDOFF IS CLEARED TOO, and this is the part worth stating. It is not written by
 * `evidence:automated`, so leaving it would look like kindness. But the handoff REPLAYS THE ARTIFACT
 * THE DISCOVERY PRODUCED, and a new discovery produces a new artifact with a new content hash. A
 * fresh discovery paired with a stale handoff is a bundle that lies about which capability the
 * person operated.
 *
 * So it is removed, `replayRunIds.handoff` is reset to empty, and `evidence:verify` fails with
 * "not run" until somebody drives it again. Failing loudly for a real reason beats passing on
 * evidence about a different artifact.
 */
export function clearScenarios(root = EVIDENCE_ROOT): string[] {
  const cleared: string[] = [];
  for (const scenario of [
    'discovery',
    'artifact',
    'success',
    'notFound',
    'recovery',
    'permissionDenied',
    'unavailable',
    'handoff',
  ]) {
    const dir = join(root, scenario);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    cleared.push(scenario);
  }
  return cleared;
}

export function copyIntoBundle(runDir: string, scenario: string, root = EVIDENCE_ROOT): string {
  const runId = runDir.split(/[\\/]/).pop() ?? runDir;
  const destination = join(root, scenario, runId);
  mkdirSync(destination, { recursive: true });

  for (const entry of readdirSync(runDir)) {
    if (NOT_PUBLISHED.has(entry)) continue;
    cpSync(join(runDir, entry), join(destination, entry), { recursive: true });
  }
  return destination;
}

/**
 * ================================================================================================
 * THE RAW DISCOVERY RECORD, KEPT SOMEWHERE THAT SURVIVES.
 * ================================================================================================
 *
 * `run.json` is the only file that answers "what did the model actually SEE": every other persisted
 * file is pseudonymized, so the transcript shows `[memberId:subject-01]` where the model was shown
 * `10001`. Reading the transcript as a record of what was displayed has now produced a wrong first
 * diagnosis twice.
 *
 * It cannot go in the published bundle - it is raw screen text, and it must stay raw or the
 * distiller's parameterization sweep loses the values it exists to search for (D77). But leaving it
 * only in an OS temp directory meant the one file that answers the question is deleted by the next
 * cleanup, while `evidence/README.md` pointed at it. That gap is exactly the one that section warns
 * about.
 *
 * So it is copied to `runs/evidence-raw/<runId>/`, which is gitignored and lives in the repository.
 * Durable on the machine that ran it; still never published.
 */
export function preserveRawRecord(runDir: string): string | null {
  const source = join(runDir, 'run.json');
  if (!existsSync(source)) return null;

  const runId = runDir.split(/[\\/]/).pop() ?? runDir;
  const destination = join(REPO, 'runs', 'evidence-raw', runId);
  mkdirSync(destination, { recursive: true });
  cpSync(source, join(destination, 'run.json'));
  return join(destination, 'run.json');
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function requireApiKey(): void {
  if ((process.env['ANTHROPIC_API_KEY'] ?? '').trim() !== '') return;
  say();
  say('ANTHROPIC_API_KEY is not set.');
  say();
  say('This command makes ONE REAL discovery run against a live UI. It costs money, and it is the');
  say('only part of this project that calls a model at all. It will not run without a key and it');
  say('will never stand in a scripted run for a real one: fabricated evidence is worse than none.');
  say();
  say('Set it in .env at the repository root, then run this again.');
  say();
  process.exit(2);
}

export function ensureEvidenceRoot(): void {
  if (!existsSync(EVIDENCE_ROOT)) mkdirSync(EVIDENCE_ROOT, { recursive: true });
}
