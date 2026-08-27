import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * ================================================================================================
 * PUT THE TRACKED EXAMPLE ARTIFACT WHERE A CLI CAN LOAD IT.
 * ================================================================================================
 *
 * Found by auditing the PHASE 8 walkthrough against a clean checkout: the documented command is
 *
 *     npm run replay -- --artifact prepare_subaccount_review@1.0.0 --params '...'
 *
 * and it fails with "prepare_subaccount_review@1.0.0 is not in artifacts", because `/artifacts` is
 * gitignored. It holds RUN OUTPUT, so a fresh clone has none - and the only documented ways to fill
 * it were to run a real discovery, which costs money, or to already have done so.
 *
 * A reviewer who cannot run the walkthrough cannot check any of the claims it makes. So this copies
 * the TRACKED example - the same artifact `docs/SCHEMA.md` annotates - into `artifacts-demo/`, which
 * is a throwaway store the replay CLI can be pointed at.
 *
 * IT IS NOT `artifacts/`, deliberately. That is the path a real discovery writes to, a published
 * version there is IMMUTABLE, and dropping an example into it would mean the next genuine run is
 * refused by the store. `artifacts-demo/` is already the convention `distill:demo` uses.
 */
const REPO = new URL('..', import.meta.url);
const EXAMPLE = fileURLToPath(
  new URL('examples/artifacts/prepare_subaccount_review@1.0.0.example.json', REPO),
);
const STORE = fileURLToPath(new URL('artifacts-demo/prepare_subaccount_review', REPO));

mkdirSync(STORE, { recursive: true });
copyFileSync(EXAMPLE, join(STORE, '1.0.0.json'));

const nl = String.fromCharCode(10);
process.stdout.write(
  nl +
    '  Copied the tracked example capability into artifacts-demo/.' +
    nl +
    nl +
    '  It is a DRAFT, distilled from the scripted fake client - not from a model run. Its' +
    nl +
    '  provenance says so. Replay does not care: the point of an artifact is that it executes' +
    nl +
    '  the same way whoever produced it.' +
    nl +
    nl +
    '  Now run:' +
    nl +
    nl +
    '    npm run replay -- --artifact prepare_subaccount_review@1.0.0 \\' +
    nl +
    '      --artifacts artifacts-demo \\' +
    nl +
    `      --params '{"memberId":"20001","accountType":"Savings","initialDeposit":"250.00"}'` +
    nl +
    nl,
);
