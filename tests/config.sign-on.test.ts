import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MERIDIAN_SIGN_ON } from '../src/config/sign-on.js';

/**
 * ================================================================================================
 * THERE IS EXACTLY ONE SIGN-ON DEFINITION, AND BOTH ENTRY POINTS USE IT.
 * ================================================================================================
 *
 * `src/cli/discover.ts` once carried its own copy of the sign-on descriptors while
 * `src/replay/session-broker.ts` used `MERIDIAN_SIGN_ON`. The two copies happened to agree, which
 * is the dangerous version of this bug: nothing fails, and the copies drift later.
 *
 * Why it matters more here than duplication normally does. Discovery RECORDS a capability from the
 * screen state it reaches; replay RE-EXECUTES that capability from the screen state it reaches. If
 * the two authenticate by different paths they can arrive in different states, and the artifact is
 * then a recording of a place its own replay never visits. That surfaces as a locator failure deep
 * in a replay, which is about the least informative place for a configuration mismatch to appear.
 *
 * This is checked by READING THE SOURCE, not by running discovery. Running it would need a
 * browser, a model and money, and would prove less: a passing end-to-end run tells you the copies
 * agree TODAY, which is exactly what the duplicated version also did.
 */

const REPO = new URL('..', import.meta.url);

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, REPO)), 'utf8');
}

/** Comments describe intent and would otherwise count as definitions. Strip them first. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('one sign-on definition', () => {
  it('is declared in exactly one file', () => {
    const declarations = ['src/config/sign-on.ts', 'src/cli/discover.ts', 'src/cli/replay.ts']
      .concat(['src/replay/session-broker.ts', 'src/agent/loop.ts'])
      .filter((file) => /(?:const|let)\s+\w*SIGN_ON\w*\s*[:=]/.test(withoutComments(source(file))));

    expect(declarations).toEqual(['src/config/sign-on.ts']);
  });

  it('is referenced by BOTH the discovery CLI and the replay session broker', () => {
    // The two callers the design commitment names.
    for (const file of ['src/cli/discover.ts', 'src/replay/session-broker.ts']) {
      const code = withoutComments(source(file));
      expect(code, file).toContain('MERIDIAN_SIGN_ON');
      expect(code, file).toContain("from '../config/sign-on.js'");
    }
  });

  it('leaves no sign-on descriptor literal outside the one definition', () => {
    // The specific strings that made the duplicate a duplicate. If they reappear anywhere else,
    // someone has re-typed the descriptors rather than imported them.
    for (const file of ['src/cli/discover.ts', 'src/replay/session-broker.ts']) {
      const code = withoutComments(source(file));
      expect(code, file).not.toContain('Operator ID');
      expect(code, file).not.toContain('Passcode');
      expect(code, file).not.toContain("name: 'Log In'");
    }
  });

  it('does not re-type the credential secret refs or the authenticated-screen text', () => {
    // Discovery must reach these through the config object, so a change to the sign-on screen is
    // one edit rather than a hunt.
    const code = withoutComments(source('src/cli/discover.ts'));

    expect(code).toContain('MERIDIAN_SIGN_ON.operatorSecretRef');
    expect(code).toContain('MERIDIAN_SIGN_ON.passcodeSecretRef');
    expect(code).toContain('MERIDIAN_SIGN_ON.authenticatedText');
    expect(code).not.toContain("'Member Search'");
  });

  it('resolves credentials through fixtureCredentials in both entry points', () => {
    // The other half of the same duplication: discover.ts had its own copy of the OPERATOR_ID and
    // OPERATOR_PASSCODE fallbacks.
    const discover = withoutComments(source('src/cli/discover.ts'));

    expect(discover).toContain('fixtureCredentials()');
    expect(discover).not.toContain('OPERATOR_PASSCODE');
  });

  it('the negative control: this test can actually see a definition', () => {
    // Without this, a broken regex matching nothing would make every assertion above pass while
    // proving nothing at all.
    const code = withoutComments(source('src/config/sign-on.ts'));

    expect(/(?:const|let)\s+\w*SIGN_ON\w*\s*[:=]/.test(code)).toBe(true);
    expect(code).toContain('Operator ID');
  });

  it('exposes every field the two callers need', () => {
    expect(Object.keys(MERIDIAN_SIGN_ON).sort()).toEqual([
      'authenticatedText',
      'operator',
      'operatorSecretRef',
      'passcode',
      'passcodeSecretRef',
      'submit',
    ]);
  });
});
