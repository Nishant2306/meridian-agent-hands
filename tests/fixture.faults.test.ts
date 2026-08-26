import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAULT_TEXT } from '../fixtures/legacy-app/faults.js';
import { conditionProfilePath, loadConditionProfile } from '../src/artifact/profiles.js';
import { phraseMatches } from '../src/artifact/phrases.js';
import { getHtml, signOn, startLegacyApp, type RunningLegacyApp } from './helpers/legacy-app.js';

/**
 * ================================================================================================
 * [MUST] THE FIXTURE MATCHES THE PINNED PROFILE. THE PROFILE IS NEVER EDITED TO MATCH THE FIXTURE.
 * ================================================================================================
 *
 * `config/condition-profiles/meridian-subaccount/1.0.0.yaml` was finalized in PHASE 3. Its SHA-256
 * is pinned into every artifact and forms part of the artifact content hash, so editing it - a
 * comment included - invalidates every artifact that referenced it, including the one approved at
 * GATE 1, and replay refuses to run with PROFILE_INTEGRITY_FAILURE.
 *
 * So this file reads the REAL profile and the REAL rendered HTML and checks the detectors against
 * it. It never hard-codes a phrase from the profile: a test that compared two copies of a string
 * would pass while the page said something else.
 */

const CONFIG_ROOT = fileURLToPath(new URL('../config', import.meta.url));

function profile() {
  return loadConditionProfile(conditionProfilePath(CONFIG_ROOT, 'meridian-subaccount', '1.0.0'))
    .profile;
}

function phraseOf(detect: { kind: string; phrase?: string }): string {
  if (detect.kind !== 'text' || detect.phrase === undefined) {
    throw new Error('expected a text detector, got ' + detect.kind);
  }
  return detect.phrase;
}

async function arm(
  app: RunningLegacyApp,
  cookie: string,
  flags: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${app.baseUrl}/__test__/faults`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(flags),
  });
  expect(response.status).toBe(200);
}

describe('fault injection is scoped per session', () => {
  let app: RunningLegacyApp;

  beforeAll(async () => {
    app = await startLegacyApp({ seed: 606 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('[MUST] a fault armed in one session does not reach another', async () => {
    // This is the whole reason faults are not a server-wide flag. Two sessions against ONE app
    // instance, which is exactly what parallel vitest files do.
    const a = await signOn(app.baseUrl);
    const b = await signOn(app.baseUrl);

    await arm(app, a, { expireSession: true });

    expect(await getHtml(app.baseUrl, '/search', a)).toContain(FAULT_TEXT.sessionExpired);
    const other = await getHtml(app.baseUrl, '/search', b);
    expect(other).not.toContain(FAULT_TEXT.sessionExpired);
    expect(other).toContain('Member Search');
  });

  it('can arm a fault BEFORE a session exists, via the X-Fault-Session header', async () => {
    // `expireSession` has to be armable before the session it affects is used, so the header is
    // not a convenience - without it that fault cannot be tested at all.
    const key = 'header-scoped-' + Date.now();
    const armed = await fetch(`${app.baseUrl}/__test__/faults`, {
      method: 'POST',
      headers: { 'x-fault-session': key, 'content-type': 'application/json' },
      body: JSON.stringify({ denyPermission: true }),
    });
    expect(armed.status).toBe(200);

    const cookie = await signOn(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/member/10001`, {
      headers: { cookie, 'x-fault-session': key },
    });

    expect(await response.text()).toContain(FAULT_TEXT.permissionDenied);
  });

  it('refuses to arm a fault with no session to attach it to', async () => {
    const response = await fetch(`${app.baseUrl}/__test__/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ denyPermission: true }),
    });

    expect(response.status).toBe(400);
  });
});

describe('every fault screen matches the PINNED detector, phrase for phrase', () => {
  let app: RunningLegacyApp;
  let cookie: string;

  beforeAll(async () => {
    app = await startLegacyApp({ seed: 607 });
    cookie = await signOn(app.baseUrl);
  });

  afterAll(async () => {
    await app.close();
  });

  it('PERMISSION_DENIED, from seed data alone, with no fault armed', async () => {
    // Member 10003 carries `restricted` in the seed data. Nothing is armed here.
    const html = await getHtml(app.baseUrl, '/member/10003', cookie);
    const failure = profile().hardFailures.find((entry) => entry.code === 'PERMISSION_DENIED');

    expect(failure).toBeDefined();
    expect(phraseMatches(html, phraseOf(failure!.detect))).toBe(true);
  });

  it('PERMISSION_DENIED answers HTTP 200, not an error status', async () => {
    // A 4xx would let a transport-level check stand in for reading the screen, and reading the
    // screen is the entire thesis.
    const response = await fetch(`${app.baseUrl}/member/10003`, { headers: { cookie } });
    expect(response.status).toBe(200);
  });

  it('SESSION_EXPIRED', async () => {
    const own = await signOn(app.baseUrl);
    await arm(app, own, { expireSession: true });

    const html = await getHtml(app.baseUrl, '/member/10001', own);
    const failure = profile().hardFailures.find((entry) => entry.code === 'SESSION_EXPIRED');

    expect(phraseMatches(html, phraseOf(failure!.detect))).toBe(true);
  });

  it('APPLICATION_UNAVAILABLE, on the one route it was armed for', async () => {
    const own = await signOn(app.baseUrl);
    await arm(app, own, { http500OnRoute: '/member/10001' });

    const response = await fetch(`${app.baseUrl}/member/10001`, { headers: { cookie: own } });
    const html = await response.text();
    const failure = profile().hardFailures.find(
      (entry) => entry.code === 'APPLICATION_UNAVAILABLE',
    );

    expect(response.status).toBe(500);
    expect(phraseMatches(html, phraseOf(failure!.detect))).toBe(true);
    // Scoped to the route, so a run can reach the failure at a chosen point rather than nowhere.
    expect(await getHtml(app.baseUrl, '/member/10002', own)).toContain('Member Record');
  });

  it('APPLICATION_VALIDATION_REJECTED is detected STRUCTURALLY, by the alert region', async () => {
    const own = await signOn(app.baseUrl);
    await arm(app, own, { validationErrorOnContinue: true });

    const response = await fetch(`${app.baseUrl}/member/10001/subaccount/new`, {
      method: 'POST',
      headers: { cookie: own, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ctl00$Main$ddlAccountType: 'Savings',
        ctl00$Main$txtNickname: '',
        ctl00$Main$txtInitialDeposit: '250.00',
      }).toString(),
    });

    const detect = profile().hardFailures.find(
      (entry) => entry.code === 'APPLICATION_VALIDATION_REJECTED',
    )?.detect;

    // The profile matches an ALERT REGION, not any particular wording: the messages belong to the
    // application and it may reword them; the alert region is the contract.
    expect(detect?.kind).toBe('control');
    expect(await response.text()).toContain('role="alert"');
    expect(response.status).toBe(200);
  });

  it('fires on form -> review, which is a transition the capability performs', async () => {
    // Named `validationErrorOnContinue` for this reason. The capability stops at review and never
    // submits, so a submit-time error would be unreachable by anything this system can do.
    const own = await signOn(app.baseUrl);
    await arm(app, own, { validationErrorOnContinue: true });

    const response = await fetch(`${app.baseUrl}/member/10001/subaccount/new`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: own, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ctl00$Main$ddlAccountType: 'Savings',
        ctl00$Main$txtInitialDeposit: '250.00',
      }).toString(),
    });

    // It does NOT reach the review screen.
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('DISMISS_MAINTENANCE_NOTICE: the phrase AND a button named exactly "Dismiss"', async () => {
    // Member 10004 carries `knownNotice` in the seed data.
    const html = await getHtml(app.baseUrl, '/member/10004/subaccount/new', cookie);
    const recovery = profile().recoveries.find(
      (entry) => entry.id === 'DISMISS_MAINTENANCE_NOTICE',
    );

    expect(phraseMatches(html, phraseOf(recovery!.detect))).toBe(true);
    // The recovery ACTION names the button exactly. A "Dismiss notice" button would not match.
    expect(recovery!.action.target.name).toBe(FAULT_TEXT.dismissButton);
    expect(html).toContain('>' + FAULT_TEXT.dismissButton + '<');
  });

  it('the notice appears on the screen the New Sub-Account click NAVIGATES TO', async () => {
    // This is what makes its continuation `recheck_expected_effect`. The click already worked; the
    // notice is on the destination. Repeating the click would navigate from a screen whose link is
    // no longer there.
    const html = await getHtml(app.baseUrl, '/member/10004/subaccount/new', cookie);

    expect(phraseMatches(html, 'Scheduled maintenance')).toBe(true);
    // The form is behind the notice, not replaced by it.
    expect(html).toContain('ctl00$Main$ddlAccountType');
  });

  it('dismissing the notice clears it for THIS session only', async () => {
    const own = await signOn(app.baseUrl);
    const other = await signOn(app.baseUrl);

    const dismissed = await fetch(`${app.baseUrl}/__fixture__/dismiss-notice`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: own, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ returnTo: '/member/10004/subaccount/new' }).toString(),
    });
    expect(dismissed.status).toBe(303);

    const after = await getHtml(app.baseUrl, '/member/10004/subaccount/new', own);
    expect(phraseMatches(after, 'Scheduled maintenance')).toBe(false);
    // Still showing for everyone else.
    const elsewhere = await getHtml(app.baseUrl, '/member/10004/subaccount/new', other);
    expect(phraseMatches(elsewhere, 'Scheduled maintenance')).toBe(true);
  });

  it('the UNKNOWN modal matches NO detector in the profile', async () => {
    // The PHASE 8 trigger. If a detector is ever written for this string, this fixture stops
    // testing what it exists to test.
    const own = await signOn(app.baseUrl);
    await arm(app, own, { showUnknownModal: true });

    const html = await getHtml(app.baseUrl, '/member/10001', own);
    const loaded = profile();
    const textDetectors = [
      ...loaded.hardFailures.map((entry) => entry.detect),
      ...loaded.knownOutcomes.map((entry) => entry.detect),
      ...loaded.recoveries.map((entry) => entry.detect),
    ].filter((detect) => detect.kind === 'text');

    expect(html).toContain(FAULT_TEXT.unknownModal);
    for (const detect of textDetectors) {
      expect(phraseMatches(html, phraseOf(detect)), 'matched ' + phraseOf(detect)).toBe(false);
    }
    // It is BLOCKING, and that is the part that must reach a human. A REAL <dialog>, not a div
    // wearing role="dialog": Chrome's accessibility tree does not expose the div form as a dialog,
    // so perception saw a heading and a button and nothing that said "blocking".
    expect(html).toContain('<dialog open');
    expect(html).toContain('aria-modal="true"');
  });

  it('slowLoadMs delays the response without changing it', async () => {
    const own = await signOn(app.baseUrl);
    await arm(app, own, { slowLoadMs: 400 });

    const started = Date.now();
    const html = await getHtml(app.baseUrl, '/member/10001', own);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    // A slow screen is still the right screen. This is a BOUNDED WAIT, not a failure.
    expect(html).toContain('Member Record');
  });
});
