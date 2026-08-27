import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);

/**
 * ================================================================================================
 * LOOKING FOR A VALUE IN A PUBLISHED FILE, WITHOUT INVENTING ONE.
 * ================================================================================================
 *
 * The first version read each file as one blob and called `includes`. That reported member `20001`
 * as leaked into an observation file five times, and every hit was a substring of a floating-point
 * box measurement: `783.2000122070312` contains `20001`. The id was correctly labelled in all eight
 * places it genuinely appeared.
 *
 * A false FAIL is the worst thing a gate can produce. It is indistinguishable from a real one until
 * somebody spends an afternoon on it, and what it teaches is to stop believing the gate. So JSON is
 * parsed and only STRINGS are searched: a number cannot be an invocation value here, because every
 * one of them is a string by the time it reaches a run.
 *
 * KEYS are searched as well as values. A structure keyed BY a sensitive value carries it just as
 * surely, and the pseudonymizer had exactly that hole - so the scan has to be able to see the case
 * the walker was missing rather than share its blind spot.
 */

/** Every string a parsed JSON document contains, keys included. */
export function jsonStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const entry of value) jsonStrings(entry, into);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      jsonStrings(entry, into);
    }
  }
  return into;
}

/** The searchable strings of a file: parsed when it is JSON, the raw text when it is not. */
export function haystacksOf(file: string, text: string): string[] {
  try {
    return file.endsWith('.jsonl')
      ? text
          .split(NL)
          .filter((line) => line.trim() !== '')
          .flatMap((line) => jsonStrings(JSON.parse(line) as unknown))
      : jsonStrings(JSON.parse(text) as unknown);
  } catch {
    // Not JSON. The whole file is the haystack, which is the honest thing to do when there is no
    // structure to use.
    return [text];
  }
}

/** Which of `values` appear in one file's strings. */
export function scanForValues(file: string, values: readonly string[]): string[] {
  const haystacks = haystacksOf(file, readFileSync(file, 'utf8'));
  return values.filter(
    (value) => value.length >= 3 && haystacks.some((haystack) => haystack.includes(value)),
  );
}
