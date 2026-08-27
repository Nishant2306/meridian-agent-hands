import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Pseudonymizer } from '../../src/redaction/pseudonymize.js';
import { haystacksOf, jsonStrings, scanForValues } from '../../scripts/evidence/lib/leak-scan.js';

/**
 * ================================================================================================
 * THE WALKER, AND THE SCAN THAT LOOKS FOR WHAT THE WALKER MISSED.
 * ================================================================================================
 *
 * A published handoff bundle appeared to show a member id half-redacted: labelled in some positions
 * and verbatim in others. It was two separate things, and neither was the one that looked obvious.
 *
 *   the id was labelled EVERYWHERE it actually appeared. The five "leaks" the gate reported were
 *   substrings of floating-point box measurements - `783.2000122070312` contains `20001` - so the
 *   defect was in the SCAN, not the walker
 *
 *   the walker did have a real hole, in KEY position, which nothing in the evidence happens to be
 *   shaped like. It survived because nothing had stepped in it yet
 *
 * Both are pinned here. The walker tests cover array elements, object values and keys at depth; the
 * scan tests cover the false positive that started this and the key case the walker used to miss.
 */
const DECLARED = new Map([
  ['memberId', '20001'],
  ['memberName', 'Dana Whitfield'],
]);

describe('the pseudonymizer walks the whole structure', () => {
  it('[MUST] redacts array elements, object values and KEYS, at depth', () => {
    const redacted = new Pseudonymizer().value(
      {
        level1: {
          arrayOfStrings: ['20001', 'untouched', ['nested', 'Dana Whitfield']],
          objectValue: { who: 'Dana Whitfield' },
          '20001': { keyedByTheValue: true },
          arrayOfObjects: [{ inner: ['20001'] }],
        },
      },
      DECLARED,
    );

    const text = JSON.stringify(redacted);
    expect(text).not.toContain('20001');
    expect(text).not.toContain('Dana Whitfield');
    expect(text).toContain('untouched');

    // The key really is a key, not a value that happened to be labelled.
    const level1 = (redacted as Record<string, Record<string, unknown>>)['level1'] ?? {};
    expect(Object.keys(level1)).toContain('[memberId:subject-01]');
  });

  it('gives a value the SAME label in key and value position', () => {
    // Otherwise a reviewer cannot tell that the key and the value refer to the same subject, which
    // is most of what a pseudonym is for.
    const redacted = new Pseudonymizer().value({ '20001': 'seen at 20001' }, DECLARED) as Record<
      string,
      string
    >;

    const [key] = Object.keys(redacted);
    expect(key).toBe('[memberId:subject-01]');
    expect(redacted[key as string]).toContain('[memberId:subject-01]');
  });

  it('a key matching the SECRET pattern is still replaced wholesale, not labelled', () => {
    // A token is not a subject to be labelled consistently; the only safe thing to record about it
    // is that it was there.
    const redacted = new Pseudonymizer().value({ passcode: 'hunter2' }, DECLARED) as Record<
      string,
      string
    >;
    expect(redacted['passcode']).toBe('[redacted:passcode]');
  });
});

describe('the leak scan looks at strings, not at raw file text', () => {
  const write = (name: string, body: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'leak-scan-')), name);
    writeFileSync(path, body, 'utf8');
    return path;
  };

  it('[MUST] does not report a number that merely contains the digits', () => {
    // The exact false positive from the handoff bundle. `783.2000122070312` contains `20001`, and
    // the old scan reported it as a leak of the member id five times over.
    const file = write(
      'observation.json',
      // The bundle's real widths were 783.2000122070312 and 407.20001220703125; shortened here
      // because a literal that long loses precision at runtime and the lint rightly says so. What
      // matters is unchanged: these are NUMBERS whose digits contain the member id.
      JSON.stringify({ box: { width: 783.20001, height: 407.20001 } }),
    );

    expect(scanForValues(file, ['20001'])).toEqual([]);
  });

  it('still reports the value when it is genuinely there', () => {
    // The negative control. Making the scan stop lying must not make it stop looking.
    const file = write('observation.json', JSON.stringify({ controls: [{ name: '20001' }] }));
    expect(scanForValues(file, ['20001'])).toEqual(['20001']);
  });

  it('reports a value that appears inside a longer string', () => {
    const file = write('r.json', JSON.stringify({ text: 'Member Name: Dana Whitfield (20001)' }));
    expect(scanForValues(file, ['20001', 'Dana Whitfield']).sort()).toEqual([
      '20001',
      'Dana Whitfield',
    ]);
  });

  it('[MUST] reports a value in KEY position, which is the case the walker used to miss', () => {
    const file = write('r.json', JSON.stringify({ '20001': { seen: true } }));
    expect(scanForValues(file, ['20001'])).toEqual(['20001']);
  });

  it('reads JSONL line by line, and falls back to raw text when a file is not JSON', () => {
    const jsonl = write(
      'events.jsonl',
      JSON.stringify({ a: 1 }) + String.fromCharCode(10) + JSON.stringify({ who: '20001' }),
    );
    expect(scanForValues(jsonl, ['20001'])).toEqual(['20001']);

    const plain = write('notes.txt', 'member 20001 was serviced');
    expect(scanForValues(plain, ['20001'])).toEqual(['20001']);
    // And the fallback is a whole-text search, so it keeps the old behaviour where it is all we have.
    expect(haystacksOf('notes.txt', 'not json')).toEqual(['not json']);
  });

  it('collects keys and values alike', () => {
    expect(jsonStrings({ outer: { '20001': ['deep'] } }).sort()).toEqual([
      '20001',
      'deep',
      'outer',
    ]);
  });
});
