import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ==============================================================================================
 * LAYER 2 OF THE NO-LLM PROOF: WALK THE MODULE GRAPH.
 * ==============================================================================================
 *
 * Layer 1 is structural: `ReplayDeps` has no LlmClient field, so there is nothing to inject.
 * Layer 3 is at run time: the provider call counter is asserted to be unchanged.
 *
 * This is the one a reviewer can check in ten seconds. It starts at `src/replay/index.ts`, follows
 * every relative import TRANSITIVELY, and fails if the agent package or a provider SDK appears
 * anywhere in the closure. Not a lint rule, not a convention: a walk of what the code actually
 * imports.
 */
const REPO = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(REPO, 'src', 'replay', 'index.ts');

const FORBIDDEN_PACKAGES = ['@anthropic-ai/sdk', 'openai', '@google/generative-ai'];
const FORBIDDEN_DIRECTORY = join('src', 'agent') + sep;

/**
 * Every quoted specifier on a line that imports or re-exports.
 *
 * Deliberately over-collects rather than parsing TypeScript: a false positive here would be a
 * quoted string on an import line that is not a module specifier, which cannot make the test pass
 * when it should fail. Under-collecting could, so the crude direction is the safe one.
 */
function importsOf(source: string): string[] {
  const found: string[] = [];

  for (const line of source.split(String.fromCharCode(10))) {
    if (!line.includes('from ') && !line.includes('import ')) continue;

    for (const quote of ["'", '"']) {
      let start = line.indexOf(quote);
      while (start !== -1) {
        const end = line.indexOf(quote, start + 1);
        if (end === -1) break;
        found.push(line.slice(start + 1, end));
        start = line.indexOf(quote, end + 1);
      }
    }
  }

  return found;
}

/** NodeNext writes `./x.js`; the file on disk is `./x.ts`. */
function resolveRelative(specifier: string, fromFile: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.endsWith('.js') ? base.slice(0, -3) + '.ts' : base + '.ts',
    base + '.ts',
    join(base, 'index.ts'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

interface Walk {
  files: string[];
  packages: string[];
}

function walk(entry: string): Walk {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(specifier, file);
        if (resolved !== null) queue.push(resolved);
        continue;
      }
      if (specifier.startsWith('node:')) continue;
      packages.add(specifier);
    }
  }

  return { files: [...seen], packages: [...packages] };
}

describe('[MUST] replay makes zero LLM calls, proven by the module graph', () => {
  const closure = walk(ENTRY);

  it('reaches a real module graph, not an empty one', () => {
    // Guards the test itself. A resolver bug that returned nothing would make every assertion
    // below pass vacuously, which is the one way this test could lie.
    expect(closure.files.length).toBeGreaterThan(20);
    expect(closure.files.some((file) => file.includes(join('src', 'artifact')))).toBe(true);
    expect(closure.files.some((file) => file.includes(join('src', 'perception')))).toBe(true);
  });

  it('never reaches src/agent', () => {
    const offenders = closure.files
      .filter((file) => file.includes(FORBIDDEN_DIRECTORY))
      .map((file) => relative(REPO, file));
    expect(offenders).toEqual([]);
  });

  it('never reaches a model provider SDK', () => {
    const offenders = closure.packages.filter((name) =>
      FORBIDDEN_PACKAGES.some(
        (forbidden) => name === forbidden || name.startsWith(forbidden + '/'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('proves the walk WOULD catch it, by walking the agent package instead', () => {
    // The negative control. Without this, a broken walker looks identical to a clean boundary.
    const agent = walk(join(REPO, 'src', 'agent', 'index.ts'));
    expect(agent.files.some((file) => file.includes(FORBIDDEN_DIRECTORY))).toBe(true);

    const withClient = walk(join(REPO, 'src', 'agent', 'anthropic-client.ts'));
    expect(withClient.packages).toContain('@anthropic-ai/sdk');
  });

  it('has no LlmClient parameter on the engine', () => {
    // Comments are stripped first. The engine's own documentation says the words "no LlmClient
    // parameter", and a check that tripped on that would be testing the prose rather than the code.
    const engine = readFileSync(join(REPO, 'src', 'replay', 'engine.ts'), 'utf8');
    const code = engine
      .split(String.fromCharCode(10))
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join(String.fromCharCode(10));

    expect(code).not.toContain('LlmClient');
    expect(code.toLowerCase()).not.toContain('anthropic');
  });
});
