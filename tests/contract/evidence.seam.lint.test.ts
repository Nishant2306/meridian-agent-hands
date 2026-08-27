import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EvidenceWriter } from '../../src/evidence/logger.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * ================================================================================================
 * EVERYTHING THAT PUTS A FILE IN A RUN DIRECTORY GOES THROUGH THE ONE REDACTING SEAM.
 * ================================================================================================
 *
 * The same defect happened three times in two phases, and never the same way twice:
 *
 *   D73  the CLIs wrote result.json with a bare `writeFileSync`
 *   D86  the mask manifest was written with a bare `writeFileSync` - and carried the member id the
 *        mask had correctly painted out of the image beside it
 *   D88  `captureEvidence('ax')` used `writeJson`, which did not redact. The HANDOFF path captures
 *        observations that the unattended path never does, so two `observation-*.json` files
 *        carrying a member id reached a published bundle and nothing had ever looked at them
 *
 * Each was a NEW writer bypassing an EXISTING seam, and each was fixed as an instance. Three is a
 * pattern, so this file is about the SHAPE:
 *
 *   1. `EvidenceWriter` has exactly ONE place that writes a file into a run directory, and it
 *      redacts. There is no unredacted variant to reach for by accident, which is what the old
 *      `writeJson` / `writeRedactedJson` and `transcript` / `transcriptRedacted` pairs were.
 *   2. Nothing outside `src/evidence/logger.ts` writes into a run directory, with ONE named and
 *      reasoned exception.
 *
 * This is the same tactic as `contract/policy.input-path.lint`: make the rule mechanical, keep the
 * exemptions few, and name a reason beside each one.
 */

/** Calls that put bytes on disk. `mkdirSync` is not one; a directory carries no values. */
const WRITERS = /\b(writeFileSync|appendFileSync|createWriteStream|cpSync|copyFileSync)\s*\(/;
/** A write is in scope when the same statement mentions a run directory. */
const RUN_DIR = /runDir|runs\b/;

/**
 * The one file allowed to write into a run directory without going through the writer.
 *
 * `run.json` is the full discovery record. It is an INPUT to re-distillation, not a report, and it
 * MUST stay raw: the parameterization sweep finds runtime values by looking for them verbatim, so a
 * record of labels would sail through the guard that exists to catch leaks (D77). It is never copied
 * into the published bundle - `NOT_PUBLISHED` in the evidence orchestrator excludes it - and
 * `evidence/README.md` says where it goes instead.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'src/cli/discover.ts':
    'run.json, the raw discovery record. Deliberately unredacted and never published. D77.',
};

function sourceFiles(): string[] {
  return globSync('src/**/*.ts', { cwd: REPO }).map((path) => path.split('\\').join('/'));
}

describe('the evidence redaction seam', () => {
  it('[MUST] only the evidence writer puts files in a run directory', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (file === 'src/evidence/logger.ts') continue;
      const text = readFileSync(join(REPO, file), 'utf8');

      text.split(String.fromCharCode(10)).forEach((line, index) => {
        if (!WRITERS.test(line) || !RUN_DIR.test(line)) return;
        if (file in EXEMPT) return;
        offenders.push(file + ':' + String(index + 1) + '  ' + line.trim());
      });
    }

    expect(
      offenders,
      'these write into a run directory without going through EvidenceWriter',
    ).toEqual([]);
  });

  it('every exemption still exists, and still needs its reason', () => {
    // The negative half. Without it the exemption list is a way to silence the check by adding a
    // line, and a file that stopped needing its exemption would keep it forever.
    for (const [file, reason] of Object.entries(EXEMPT)) {
      const text = readFileSync(join(REPO, file), 'utf8');
      const writes = text
        .split(String.fromCharCode(10))
        .filter((line) => WRITERS.test(line) && RUN_DIR.test(line));
      expect(
        writes.length,
        file + ' no longer writes into a run directory (' + reason + ')',
      ).toBeGreaterThan(0);
    }
  });

  it('[MUST] the writer exposes no unredacted variant to reach for', () => {
    // The three defects were not carelessness so much as autocomplete: the unsafe method held the
    // more obvious name. There is nothing left to choose between.
    const api = Object.getOwnPropertyNames(EvidenceWriter.prototype);

    expect(api).toContain('writeJson');
    expect(api).toContain('transcript');
    expect(api).not.toContain('writeRedactedJson');
    expect(api).not.toContain('transcriptRedacted');
    expect(api.filter((name) => /redact/i.test(name) && name !== 'redactText')).toEqual([]);
  });

  it('[MUST] the writer has exactly one file-writing call site', () => {
    // The structural claim the rest of this file rests on. Two would mean a caller could reach the
    // one that does not redact, and that is precisely how this happened three times.
    const text = readFileSync(join(REPO, 'src/evidence/logger.ts'), 'utf8');
    const writes = text
      .split(String.fromCharCode(10))
      .filter((line) => /writeFileSync\(/.test(line));

    // One in `#write`, one for the masked PNG - which is bytes, already masked, and has no text to
    // pseudonymize. Any third is a regression.
    expect(writes).toHaveLength(2);
  });
});
