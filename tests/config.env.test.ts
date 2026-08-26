import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  envVarState,
  formatMissingEnv,
  loadEnvFile,
  MissingEnvError,
  repoRoot,
  requireEnv,
  resetEnvFileCacheForTests,
} from '../src/config/env.js';

/**
 * GATE 1 was blocked by this exact bug: a correctly filled .env sat in the repository root and
 * nothing read it, and the error message - "ANTHROPIC_API_KEY and LLM_MODEL must be set" - could
 * not tell that story apart from "you have not filled in your key yet". These tests pin both
 * halves: that the file is read, and that the message says which variable and whether a file was
 * involved.
 */

const roots: string[] = [];

function tempRoot(envContents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'envtest-'));
  roots.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"name":"envtest"}');
  if (envContents !== null) writeFileSync(join(dir, '.env'), envContents);
  return dir;
}

afterEach(() => {
  resetEnvFileCacheForTests();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadEnvFile', () => {
  it('reads a .env from the given root into process.env', () => {
    const root = tempRoot('ENV_TEST_ALPHA=from-file\n');
    delete process.env['ENV_TEST_ALPHA'];

    const load = loadEnvFile({ root });

    expect(load.path).toBe(join(root, '.env'));
    expect(process.env['ENV_TEST_ALPHA']).toBe('from-file');
    delete process.env['ENV_TEST_ALPHA'];
  });

  it('treats an absent .env as normal, and still reports where it looked', () => {
    const root = tempRoot(null);

    const load = loadEnvFile({ root });

    // Not an error. `npm run replay` and the test suite must work on a checkout with no .env.
    expect(load.path).toBeNull();
    expect(load.searched).toBe(join(root, '.env'));
  });

  it('lets the real environment win over the file', () => {
    const root = tempRoot('ENV_TEST_BRAVO=from-file\n');
    process.env['ENV_TEST_BRAVO'] = 'from-shell';

    loadEnvFile({ root });

    // Node's precedence, relied upon deliberately: `LLM_MODEL=x npm run discover` overrides the
    // file for one run without editing it.
    expect(process.env['ENV_TEST_BRAVO']).toBe('from-shell');
    delete process.env['ENV_TEST_BRAVO'];
  });

  it('finds the repository root from the module, not from the working directory', () => {
    // The bug this guards: npm sets cwd to the package root, so a cwd-based loader looks correct
    // under `npm run ...` and breaks under `tsx src/cli/discover.ts` from anywhere else.
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(repoRoot()).toBe(original);
    } finally {
      process.chdir(original);
    }
  });

  it('actually locates this repository .env.example, proving the root walk works here', () => {
    // A weaker version of this test would pass against a root walk that returned any directory.
    expect(requireEnv([], { root: repoRoot() })).toEqual({});
    expect(loadEnvFile({ root: repoRoot() }).searched).toBe(join(repoRoot(), '.env'));
  });
});

describe('requireEnv reports which variable, not just that something is wrong', () => {
  const root = (): string => tempRoot(null);

  it('names ONLY the missing one when the other is set', () => {
    const load = { path: '/somewhere/.env', searched: '/somewhere/.env' };
    const error = new MissingEnvError([{ name: 'LLM_MODEL', state: 'missing' }], load);

    expect(error.message).toContain('LLM_MODEL');
    expect(error.message).not.toContain('ANTHROPIC_API_KEY');
    // Singular, because reading "variables: LLM_MODEL" makes you look for a second one.
    expect(error.message).toContain('Missing required environment variable:');
  });

  it('distinguishes "no .env was read" from "read it, and the variable is not in there"', () => {
    const missing = [{ name: 'ANTHROPIC_API_KEY', state: 'missing' as const }];

    const withoutFile = formatMissingEnv(missing, { path: null, searched: '/repo/.env' });
    const withFile = formatMissingEnv(missing, { path: '/repo/.env', searched: '/repo/.env' });

    // This is the distinction whose absence blocked GATE 1.
    expect(withoutFile).toContain('No .env file was read. Looked for: /repo/.env');
    expect(withoutFile).toContain('Copy .env.example to .env');
    expect(withFile).toContain('Read .env from: /repo/.env');
    expect(withFile).toContain('not present in /repo/.env');
    expect(withFile).not.toContain('No .env file was read');
  });

  it('calls out a variable that is present but empty', () => {
    const message = formatMissingEnv([{ name: 'LLM_MODEL', state: 'empty' }], {
      path: '/repo/.env',
      searched: '/repo/.env',
    });

    // `LLM_MODEL=` parses to '' and would otherwise be sent to the API as a model name.
    expect(message).toContain('present but empty');
  });

  it('classifies unset, empty and whitespace-only as not usable, and a real value as ok', () => {
    const env = { SET: 'value', EMPTY: '', BLANK: '   ' };

    expect(envVarState('SET', env)).toBe('ok');
    expect(envVarState('EMPTY', env)).toBe('empty');
    expect(envVarState('BLANK', env)).toBe('empty');
    expect(envVarState('ABSENT', env)).toBe('missing');
  });

  it('throws MissingEnvError listing both when neither is set', () => {
    expect(() => requireEnv(['ONE', 'TWO'], { root: root(), env: {} })).toThrow(MissingEnvError);

    try {
      requireEnv(['ONE', 'TWO'], { root: root(), env: {} });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvError);
      expect((error as MissingEnvError).missing.map((entry) => entry.name)).toEqual(['ONE', 'TWO']);
      expect((error as MissingEnvError).message).toContain('variables: ONE, TWO');
    }
  });

  it('returns the values when everything is present', () => {
    const values = requireEnv(['ONE', 'TWO'], {
      root: root(),
      env: { ONE: 'a', TWO: 'b' },
    });

    expect(values).toEqual({ ONE: 'a', TWO: 'b' });
  });

  it('reads the file and then requires from it, which is the whole GATE 1 path', () => {
    const dir = tempRoot('ENV_TEST_KEY=sk-not-a-real-key\nENV_TEST_MODEL=claude-opus-5\n');
    delete process.env['ENV_TEST_KEY'];
    delete process.env['ENV_TEST_MODEL'];

    const values = requireEnv(['ENV_TEST_KEY', 'ENV_TEST_MODEL'], { root: dir });

    expect(values.ENV_TEST_KEY).toBe('sk-not-a-real-key');
    expect(values.ENV_TEST_MODEL).toBe('claude-opus-5');
    delete process.env['ENV_TEST_KEY'];
    delete process.env['ENV_TEST_MODEL'];
  });
});
