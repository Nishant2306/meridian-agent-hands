import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest } from './lib/manifest.js';
import { renderReadme } from './lib/readme.js';
import { EVIDENCE_ROOT, say } from './lib/runtime.js';

/**
 * `npm run evidence:readme` - regenerate the bundle's README from the files already in it.
 *
 * `evidence:automated` and `evidence:handoff` do this themselves at the end of a run. This exists
 * because the filling is DERIVED: every value comes from a file in the bundle, so a bundle that was
 * produced before the README was generated can be brought up to date without running anything, and
 * without paying for another discovery.
 *
 * It reads no state of its own. If it produces something different from what a run produced, the
 * bundle changed underneath it, which is what `evidence:verify` checks.
 */
const manifestPath = join(EVIDENCE_ROOT, 'manifest.json');
if (!existsSync(manifestPath)) {
  say();
  say('There is no ' + manifestPath + '.');
  say();
  say('The README is rendered from the runs a bundle contains, so there has to be a bundle.');
  say('Run `npm run evidence:automated` first.');
  say();
  process.exit(2);
}

const result = renderReadme({ manifest: readManifest(manifestPath) });

say();
say('wrote ' + result.path);
if (result.unfilled.length > 0) {
  say();
  say('still unfilled, because the bundle has no file to read them from:');
  for (const key of result.unfilled) say('  ' + key);
  say();
  say('`npm run evidence:verify` fails while any placeholder remains.');
}
say();
