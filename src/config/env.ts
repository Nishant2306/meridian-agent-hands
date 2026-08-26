import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ================================================================================================
 * .env LOADING, AND WHY IT IS HERE RATHER THAN IN THE npm SCRIPTS
 * ================================================================================================
 *
 * Node does not read `.env` on its own. Before this file existed, `npm run discover` with a
 * correctly filled `.env` sitting in the repository root failed with "ANTHROPIC_API_KEY and
 * LLM_MODEL must be set" - a message that is true, unhelpful, and points at the wrong thing.
 *
 * Node offers three ways to fix that, and the reasons for the choice matter more than the choice:
 *
 *   --env-file=.env in the npm script     Node 20.6+. Rejected: it throws ENOENT when the file is
 *                                         absent, so `npm run replay` - which needs no API key at
 *                                         all - would stop working on a clean checkout. It also
 *                                         only covers invocations that go through npm, and it
 *                                         cannot be tested.
 *   --env-file-if-exists=.env             Fixes the ENOENT problem, but it is Node 22.9+, and
 *                                         `engines.node` here is >= 20. A flag that hard-fails on
 *                                         a version we claim to support is worse than the bug.
 *   process.loadEnvFile(path)             Node 20.12+. THE ONE WE USE.
 *
 * `process.loadEnvFile` is the SAME parser `--env-file` uses, so quoting, comments and multi-line
 * values behave identically. It is called from the entry points instead of the npm scripts, which
 * buys three things the flag does not: it works when a file is run directly with `tsx`, it works
 * from any working directory, and it is reachable from a test.
 *
 * PRECEDENCE: a variable already present in the real environment WINS over the file. That is
 * Node's behaviour, not ours, and it is the right way round - `LLM_MODEL=x npm run discover`
 * overrides the file for one run without editing it.
 *
 * THE ROOT IS FOUND FROM THIS MODULE, NOT FROM `process.cwd()`. npm sets the working directory to
 * the package root, so cwd happens to be right under `npm run ...` - and is wrong the moment
 * anyone runs `tsx src/cli/discover.ts` from somewhere else. Walking up from `import.meta.url`
 * to the directory holding package.json is correct under both, and identical under PowerShell and
 * Git Bash, which resolve paths differently but resolve this one the same way.
 */

/** What the loader did, so an error message can say whether a file was involved at all. */
export interface EnvFileLoad {
  /** The .env that was read, or null when none exists. */
  readonly path: string | null;
  /** Where the loader looked. Present even on success, so the message can always be specific. */
  readonly searched: string;
}

function repoRootFrom(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    // At a filesystem root, dirname(dir) === dir. Stop rather than loop forever.
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/** The repository root, located from this module rather than from the working directory. */
export function repoRoot(): string {
  return repoRootFrom(dirname(fileURLToPath(import.meta.url)));
}

let cached: EnvFileLoad | null = null;

/**
 * Load `<repo root>/.env` into `process.env` if it exists. Safe to call from every entry point:
 * the result is memoized, and Node's loader never overwrites a variable the environment already
 * set, so a second call cannot change what the first one decided.
 *
 * Absence of `.env` is NOT an error. Most commands here need no secret, and a checkout with no
 * `.env` must still be able to run the fixture, replay an artifact and run the suite.
 */
export function loadEnvFile(options: { readonly root?: string } = {}): EnvFileLoad {
  if (options.root === undefined && cached !== null) return cached;

  const searched = join(options.root ?? repoRoot(), '.env');

  if (typeof process.loadEnvFile !== 'function') {
    // Node 20.0 - 20.11. Named explicitly, because "undefined is not a function" thrown from a
    // config module at startup is a genuinely baffling way to learn about a version floor.
    throw new Error(
      'This project reads .env with process.loadEnvFile, which needs Node 20.12 or newer. ' +
        'Running Node ' +
        process.version +
        '. Upgrade Node, or export the variables in your shell.',
    );
  }

  const result: EnvFileLoad = existsSync(searched)
    ? (process.loadEnvFile(searched), { path: searched, searched })
    : { path: null, searched };

  if (options.root === undefined) cached = result;
  return result;
}

/** Test seam. Nothing in `src/` calls this. */
export function resetEnvFileCacheForTests(): void {
  cached = null;
}

/**
 * ================================================================================================
 * WHY THE ERROR NAMES EACH VARIABLE SEPARATELY
 * ================================================================================================
 *
 * The message this replaces was "ANTHROPIC_API_KEY and LLM_MODEL must be set". It cannot
 * distinguish:
 *
 *     neither variable is set              -> fill in .env
 *     one is set and the other is not      -> fix that one line
 *     both are in .env but nothing read it -> the bug that actually happened
 *     one is present but empty             -> `LLM_MODEL=` with nothing after the `=`
 *
 * Those are four different problems with one sentence between them, so the sentence sends you
 * looking in the wrong place. Each variable now reports its own state, and the message says
 * whether a .env file was found and where it was looked for.
 */
export type EnvVarState = 'ok' | 'missing' | 'empty';

export interface MissingEnvVar {
  readonly name: string;
  readonly state: Exclude<EnvVarState, 'ok'>;
}

export class MissingEnvError extends Error {
  readonly missing: readonly MissingEnvVar[];
  readonly load: EnvFileLoad;

  constructor(missing: readonly MissingEnvVar[], load: EnvFileLoad) {
    super(formatMissingEnv(missing, load));
    this.name = 'MissingEnvError';
    this.missing = missing;
    this.load = load;
  }
}

export function envVarState(name: string, env: NodeJS.ProcessEnv = process.env): EnvVarState {
  const raw = env[name];
  if (raw === undefined) return 'missing';
  // A trimmed-empty value is treated as absent. `LLM_MODEL=` parses to '' and would otherwise be
  // sent to the API as a model name, failing much later and much less clearly.
  if (raw.trim() === '') return 'empty';
  return 'ok';
}

export function formatMissingEnv(missing: readonly MissingEnvVar[], load: EnvFileLoad): string {
  const nl = String.fromCharCode(10);
  const width = Math.max(...missing.map((entry) => entry.name.length));
  const noun = missing.length === 1 ? 'variable' : 'variables';

  const lines = [
    'Missing required environment ' + noun + ': ' + missing.map((e) => e.name).join(', '),
    '',
  ];

  for (const entry of missing) {
    const explanation =
      entry.state === 'empty'
        ? 'present but empty (there is nothing after the "=")'
        : load.path === null
          ? 'not set'
          : 'not set, and not present in ' + load.path;
    lines.push('  ' + entry.name.padEnd(width) + '  ' + explanation);
  }

  lines.push('');
  lines.push(
    load.path === null
      ? 'No .env file was read. Looked for: ' +
          load.searched +
          nl +
          'Copy .env.example to .env and fill it in.'
      : 'Read .env from: ' + load.path,
  );

  return lines.join(nl);
}

/**
 * Load `.env`, then require every named variable. Returns the values, so a caller cannot forget to
 * re-read them and cannot accidentally use a `string | undefined` from `process.env`.
 *
 * Throws `MissingEnvError`. CLIs catch it, print `error.message`, and exit 2.
 */
export function requireEnv<const Names extends readonly string[]>(
  names: Names,
  options: { readonly root?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Record<Names[number], string> {
  const load = loadEnvFile(options.root === undefined ? {} : { root: options.root });
  const env = options.env ?? process.env;

  const missing: MissingEnvVar[] = [];
  const values: Record<string, string> = {};

  for (const name of names) {
    const state = envVarState(name, env);
    if (state === 'ok') values[name] = env[name] as string;
    else missing.push({ name, state });
  }

  if (missing.length > 0) throw new MissingEnvError(missing, load);
  return values as Record<Names[number], string>;
}
