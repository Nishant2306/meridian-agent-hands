import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createLegacyApp } from '../fixtures/legacy-app/server.js';
import { tenantA } from '../fixtures/legacy-app/tenants/tenant-a.js';
import { renderInventory } from '../src/perception/inventory.js';
import { EvidenceWriter } from '../src/evidence/logger.js';
import { LeaseManager } from '../src/session/lease.js';
import { SessionStateMachine } from '../src/session/state.js';
import { launchDeterministicBrowser } from '../src/surface/playwright-web/browser.js';
import { PlaywrightWebSurface } from '../src/surface/playwright-web/surface.js';
import type { TargetDescriptor } from '../src/types/control.js';
import type { LeaseToken } from '../src/types/session.js';
import type { SurfaceAction } from '../src/types/action.js';

/**
 * `npm run inventory` - the PHASE 2 spike.
 *
 * Boots the fixture, signs on, and walks the real happy path through the real input path, printing
 * the perceived control inventory at each screen. Nothing here is mocked: every line printed came
 * out of Chrome accessibility tree via the same code the agent will use in PHASE 4.
 *
 * It also SAVES each observation to tests/fixtures/observations/, so the resolver tests can run
 * against a genuine capture with no browser. Those files are recorded, never hand-written.
 *
 *   npm run inventory                 boot the fixture, walk all four screens, save captures
 *   npm run inventory -- <url>        point at an already-running app and print one screen
 *   npm run inventory -- --headed     show the browser window while it works
 */

const FIXTURE_DIR = join('tests', 'fixtures', 'observations');

const descriptor = (
  semantic: TargetDescriptor['semantic'],
  recordedTier: TargetDescriptor['recordedTier'],
): TargetDescriptor => ({ semantic, recordedTier });

const D = {
  operatorId: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Operator ID'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  passcode: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Passcode'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  logIn: descriptor({ role: 'button', name: 'Log In', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME'),
  memberId: descriptor(
    { role: 'textbox', name: 'Member ID', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
  search: descriptor({ role: 'button', name: 'Search', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME'),
  openMember: descriptor(
    {
      role: 'link',
      name: 'Open',
      nameMatch: 'exact',
      rowKey: { cellText: { kind: 'param', name: 'memberId' } },
    },
    'T5_STRUCTURAL_ROW',
  ),
  newSubAccount: descriptor(
    { role: 'link', name: 'New Sub-Account', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
  accountType: descriptor(
    { role: 'combobox', nameMatch: 'normalized', nearbyText: ['Account Type'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  nickname: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Nickname'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  initialDeposit: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Initial Deposit'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  continue: descriptor(
    { role: 'button', name: 'Continue', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
} as const;
const RULE = '='.repeat(78);

async function startFixture(): Promise<{
  origin: string;
  seed: number;
  close: () => Promise<void>;
}> {
  const { app, seed } = createLegacyApp({ tenant: tenantA });
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address() as AddressInfo;
      resolve({
        origin: 'http://127.0.0.1:' + address.port,
        seed,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function banner(title: string): void {
  console.log('');
  console.log(RULE);
  console.log(title);
  console.log(RULE);
}

async function act(
  surface: PlaywrightWebSurface,
  token: LeaseToken,
  action: SurfaceAction,
  label: string,
): Promise<void> {
  const { result, trace } = await surface.resolveAndPerform(action, token);

  if (result.status !== 'performed') {
    console.log('  ' + label + ': ' + result.status.toUpperCase() + ' ' + result.error);
    console.log('    ' + result.reason);
    throw new Error(label + ' did not complete: ' + result.reason);
  }

  const drift = trace.downgraded ? '  [DOWNGRADED from the recorded tier]' : '';
  console.log('  ' + label + ': ok via ' + (trace.tierUsed ?? 'n/a') + drift);
}

async function snapshot(surface: PlaywrightWebSurface, name: string, save: boolean): Promise<void> {
  const observation = await surface.observe();
  banner(name);
  console.log(renderInventory(observation));

  if (save) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(join(FIXTURE_DIR, name + '.json'), JSON.stringify(observation, null, 2), 'utf8');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const urlArg = args.find((arg) => arg.startsWith('http'));

  const fixture = urlArg === undefined ? await startFixture() : null;
  const origin = fixture?.origin ?? new URL(urlArg ?? '').origin;

  if (fixture !== null) {
    console.log('fixture: ' + origin + '  (obfuscation seed ' + fixture.seed + ')');
    console.log('Class names and element ids differ on every boot. Nothing below depends on them.');
  }

  const browser = await launchDeterministicBrowser({ headless: !headed });
  const lease = new LeaseManager();
  const session = new SessionStateMachine();

  // Real evidence from a real run. /runs is gitignored; nothing here is ever authored by hand.
  const evidence = new EvidenceWriter({ runId: 'inventory-' + Date.now() });
  evidence.append({
    type: 'run_started',
    at: new Date().toISOString(),
    runId: evidence.runId,
    surfaceId: 'playwright-web',
    allowedOrigin: origin,
  });
  const surface = new PlaywrightWebSurface({
    page: browser.page,
    context: browser.context,
    allowedOrigin: origin,
    lease,
    session,
    evidence,
    values: {
      params: { memberId: '10001' },
      // Fixture sign-on accepts any non-empty pair. Even so it travels as a SECRET binding, so the
      // value never reaches a log line, a transcript or an evidence event.
      secrets: { operatorId: 'fixture-operator', operatorPasscode: 'fixture-passcode' },
    },
  });

  const token = lease.issue('AUTOMATION');
  evidence.append({
    type: 'lease_issued',
    at: new Date().toISOString(),
    leaseId: token.leaseId,
    owner: token.owner,
    expiresAt: token.expiresAt,
  });

  try {
    banner('SIGN ON');
    await act(surface, token, { type: 'navigate', pathSegments: [] }, 'navigate to entry point');
    await act(
      surface,
      token,
      { type: 'type', target: D.operatorId, value: { kind: 'secretRef', name: 'operatorId' } },
      'type operator id',
    );
    await act(
      surface,
      token,
      { type: 'type', target: D.passcode, value: { kind: 'secretRef', name: 'operatorPasscode' } },
      'type passcode',
    );
    await act(surface, token, { type: 'click', target: D.logIn }, 'click Log In');
    await surface.waitFor({ kind: 'text_present', text: 'Member Search' }, 5000);

    if (urlArg !== undefined) {
      // Through the INPUT PATH, like everything else. This used to call `page.goto` directly, and
      // `tests/policy.input-path.lint.test.ts` found it the moment that test was written: a dev
      // script is exactly where a shortcut past the lease, the allowlist and the policy engine
      // gets taken, because it does not feel like automation.
      await act(
        surface,
        token,
        {
          type: 'navigate',
          pathSegments: new URL(urlArg).pathname
            .split('/')
            .filter((segment) => segment !== '')
            .map((value) => ({ kind: 'literal' as const, value })),
        },
        'navigate to ' + urlArg,
      );
      await snapshot(surface, 'requested-screen', false);
      return;
    }

    await snapshot(surface, 'search', true);

    banner('A MEMBER THAT DOES NOT EXIST (a BUSINESS OUTCOME, not an error)');
    await act(
      surface,
      token,
      { type: 'type', target: D.memberId, value: { kind: 'literal', value: '99999' } },
      'type an absent member id',
    );
    await act(surface, token, { type: 'click', target: D.search }, 'click Search');
    await surface.waitFor({ kind: 'text_present', text: 'No member found' }, 5000);
    await snapshot(surface, 'search-no-results', true);

    banner('SEARCH FOR A PARTIAL MEMBER ID (four identical "Open" links)');
    await act(
      surface,
      token,
      { type: 'type', target: D.memberId, value: { kind: 'literal', value: '1000' } },
      'type member id',
    );
    await act(surface, token, { type: 'click', target: D.search }, 'click Search');
    await surface.waitFor({ kind: 'text_present', text: 'Search Results' }, 5000);
    await snapshot(surface, 'search-results', true);

    banner('OPEN MEMBER 10001 BY ROW KEY');
    await act(surface, token, { type: 'click', target: D.openMember }, 'click Open for 10001');
    await surface.waitFor({ kind: 'text_present', text: 'Member Record' }, 5000);
    await snapshot(surface, 'member', true);

    banner('NEW SUB-ACCOUNT');
    await act(surface, token, { type: 'click', target: D.newSubAccount }, 'click New Sub-Account');
    await surface.waitFor({ kind: 'text_present', text: 'Account Type' }, 5000);
    await snapshot(surface, 'subaccount-new', true);

    banner('THE APPLICATION REFUSES AN INCOMPLETE FORM (an alert region appears)');
    await act(surface, token, { type: 'click', target: D.continue }, 'click Continue too early');
    await surface.waitFor({ kind: 'text_present', text: 'You must select an account type' }, 5000);
    await snapshot(surface, 'subaccount-form-rejected', true);

    banner('FILL THE FORM AND CONTINUE');
    await act(
      surface,
      token,
      { type: 'select', target: D.accountType, value: { kind: 'literal', value: 'Savings' } },
      'select Savings',
    );
    await act(
      surface,
      token,
      { type: 'type', target: D.nickname, value: { kind: 'literal', value: 'Vacation' } },
      'type nickname',
    );
    await act(
      surface,
      token,
      { type: 'type', target: D.initialDeposit, value: { kind: 'literal', value: '250.00' } },
      'type initial deposit',
    );
    await act(surface, token, { type: 'click', target: D.continue }, 'click Continue');
    await surface.waitFor({ kind: 'text_present', text: 'Review Sub-Account Request' }, 5000);
    await snapshot(surface, 'subaccount-review', true);

    banner('THE GUARDRAIL');
    const submit = descriptor(
      { role: 'button', name: 'Submit Request', nameMatch: 'exact' },
      'T1_EXACT_ROLE_NAME',
    );
    const attempt = await surface.resolveAndPerform({ type: 'click', target: submit }, token);
    console.log('  click Submit Request: ' + attempt.result.status.toUpperCase());
    if (attempt.result.status !== 'performed') {
      console.log('    ' + attempt.result.error + ': ' + attempt.result.reason);
    }

    await surface.captureEvidence('screenshot');
    console.log('');
    console.log('evidence: ' + evidence.runDir);
  } finally {
    await browser.close();
    await fixture?.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
