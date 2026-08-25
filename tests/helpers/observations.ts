import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ObservationSchema, type Observation } from '../../src/types/perception.js';

/**
 * Saved observations are REAL CAPTURES, produced by `npm run inventory` against the running
 * fixture and written verbatim. Nothing in tests/fixtures/observations is hand-authored, and
 * nothing there claims to be anything other than what Chrome accessibility tree actually said.
 *
 * They are what lets the resolver tests run with no browser: the resolver is pure, so a recorded
 * observation is a complete input to it.
 */
export type SavedScreen =
  | 'search'
  | 'search-results'
  | 'search-no-results'
  | 'member'
  | 'subaccount-new'
  | 'subaccount-form-rejected'
  | 'subaccount-review';

export function loadObservation(screen: SavedScreen): Observation {
  const path = fileURLToPath(
    new URL('../fixtures/observations/' + screen + '.json', import.meta.url),
  );
  // Parsed through the schema, so a capture that has drifted out of shape fails loudly here rather
  // than producing confusing resolver failures three tests later.
  return ObservationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
