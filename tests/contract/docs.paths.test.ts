import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * ================================================================================================
 * EVERY CODE PATH A DOCUMENT NAMES HAS TO EXIST.
 * ================================================================================================
 *
 * PHASE 9 found four references in `docs/STATUS.md` to test files that had never existed. They had
 * been wrong since PHASE 4 and nobody had followed them. The fix at the time was a script somebody
 * ran once, which is the same kind of promise as the references it was checking.
 *
 * PHASE 10 found the rest of them: reorganising `/tests` into `unit`, `contract` and `integration`
 * left every `tests/foo.test.ts` reference in `CLAUDE.md` and `DECISIONS.md` pointing at nothing.
 * Twenty-one of them.
 *
 * So it is a test now. A reader who clicks a path in a document and lands on a 404 stops trusting
 * the document, and they are right to.
 *
 * SCOPE. Source, test, config and fixture paths inside backticks. Deliberately NOT evidence output
 * (`/evidence/manifest.json` and friends do not exist until somebody runs the evidence commands),
 * and not illustrative names like `screenshots/NNNN.mask.json`.
 */

const DOCS = [
  'README.md',
  'REPORT.md',
  'CLAUDE.md',
  'DECISIONS.md',
  'docs/STATUS.md',
  'docs/DECISIONS.md',
  'docs/TEST_MAP.md',
  'docs/DATA_HANDLING.md',
  'docs/SCHEMA.md',
  // The TEMPLATE, not the generated README: the template is tracked and always present, while
  // `evidence/README.md` is a bundle artifact that a clone which has never run anything may not
  // have. Checking the source is what keeps the paths honest either way.
  'evidence/README.template.md',
];

/** Only the directories that hold code and configuration checked into the repository. */
const CODE_PATH =
  /`((?:src|tests|scripts|fixtures|config|examples)\/[A-Za-z0-9_./-]+\.(?:ts|yaml|json))`/g;

/**
 * Paths a document names in order to say they are NOT there.
 *
 * Each needs a reason, because "the test was failing" is not one. A file that stops being
 * deliberately absent should be removed from this list rather than left to make the check weaker.
 */
const KNOWN_ABSENT: Readonly<Record<string, string>> = {
  // Currently empty, and that is the finding rather than an omission. The first entry written here
  // was `fixtures/legacy-app/tenants/tenant-b.ts`, on the strength of three documents saying it did
  // not exist. It does: a documented TODO that exports nothing. The negative control below caught
  // that on the first run, and all three documents now say what is actually there.
};

describe('documents point at files that exist', () => {
  for (const doc of DOCS) {
    it(doc + ' names no path that is not there', () => {
      const full = join(REPO, doc);
      expect(existsSync(full), doc + ' does not exist').toBe(true);

      const text = readFileSync(full, 'utf8');
      const broken: string[] = [];

      for (const match of text.matchAll(CODE_PATH)) {
        const path = match[1];
        if (path === undefined) continue;
        if (path in KNOWN_ABSENT) continue;
        // A brace or star is a shorthand for several files, not a path.
        if (/[{}*]/.test(path)) continue;
        if (!existsSync(join(REPO, path))) broken.push(path);
      }

      expect(broken, doc + ' points at files that do not exist').toEqual([]);
    });
  }

  it('every KNOWN_ABSENT entry is still absent', () => {
    // The negative half. Without it this list becomes a way to silence the check by adding a line,
    // and a path that came back would stay exempt forever.
    for (const [path, reason] of Object.entries(KNOWN_ABSENT)) {
      expect(existsSync(join(REPO, path)), path + ' exists now (' + reason + ')').toBe(false);
    }
  });
});
