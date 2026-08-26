import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ================================================================================================
 * THERE IS ONE INPUT PATH, AND THIS TEST IS HOW A REVIEWER KNOWS IT.
 * ================================================================================================
 *
 * Every software-issued action goes through `Surface.resolveAndPerform`, which is where the lease
 * is checked, the bootstrap minimum applies, the policy engine runs, the control is resolved
 * through the ONE resolver, and the recipe is revalidated immediately before the input fires.
 *
 * A single `page.click(...)` somewhere else bypasses all of it. It would not look dangerous in a
 * diff - it would look like a shortcut in a test helper or a script - and nothing else in the suite
 * would fail. So the rule is enforced mechanically rather than by review.
 *
 * The allowed directory is `src/surface/playwright-web/`, which IS the transport, plus the fixture
 * (which is the application under test, not automation of it) and this file.
 *
 * THIS TEST IS ITSELF THE POINT. It is the difference between "we intend there to be one input
 * path" and "there is one input path", and it is meant to be read by a reviewer as evidence rather
 * than run as a chore.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));

/**
 * The Playwright calls that ISSUE INPUT or MOVE THE PAGE. Read-only calls are not listed: reading
 * the page cannot press a button, and banning `page.title()` would push people into workarounds
 * without buying anything.
 */
const FORBIDDEN = [
  'page.click',
  'page.fill',
  'page.goto',
  'page.type',
  'page.press',
  'page.check',
  'page.uncheck',
  'page.selectOption',
  'page.dblclick',
  'page.tap',
  'page.setInputFiles',
  'page.dragAndDrop',
  'locator.click',
  'mouse.click',
  'keyboard.press',
  'keyboard.type',
];

/** The transport, the fixture itself, and this file. */
const ALLOWED_PREFIXES = [
  join('src', 'surface', 'playwright-web'),
  join('fixtures', 'legacy-app'),
  join('tests', 'policy.input-path.lint.test.ts'),
];

const SEARCHED_ROOTS = ['src', 'tests', 'scripts', 'fixtures'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Comments describe the rule; they are not violations of it. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('no code outside the transport issues browser input directly', () => {
  const files = SEARCHED_ROOTS.flatMap((root) => walk(join(REPO, root)));

  it('finds files to check, so a broken walker cannot pass silently', () => {
    // The negative control for the walker itself.
    expect(files.length).toBeGreaterThan(40);
  });

  it('finds the forbidden calls where they ARE allowed, so the matcher works', () => {
    // The negative control for the MATCHER. Without this, a typo in the pattern list would make
    // every assertion below pass while checking nothing at all.
    const transport = files.filter((file) =>
      relative(REPO, file).startsWith(join('src', 'surface', 'playwright-web')),
    );
    const hits = transport.flatMap((file) => {
      const code = withoutComments(readFileSync(file, 'utf8'));
      return FORBIDDEN.filter((call) => code.includes(call));
    });

    expect(hits.length).toBeGreaterThan(0);
  });

  it('[MUST] finds none anywhere else', () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = relative(REPO, file);
      if (ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;

      const code = withoutComments(readFileSync(file, 'utf8'));
      for (const call of FORBIDDEN) {
        if (code.includes(call)) violations.push(rel + ' -> ' + call);
      }
    }

    // Listed rather than counted: a violation is one line somebody has to go and look at.
    expect(violations, violations.join(String.fromCharCode(10))).toEqual([]);
  });
});
