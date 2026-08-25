import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLegacyApp } from '../fixtures/legacy-app/server.js';
import { tenantA } from '../fixtures/legacy-app/tenants/tenant-a.js';
import { LeaseManager } from '../src/session/lease.js';
import { LeaseViolationError } from '../src/session/errors.js';
import { SessionStateMachine } from '../src/session/state.js';
import { launchDeterministicBrowser } from '../src/surface/playwright-web/browser.js';
import { PlaywrightWebSurface } from '../src/surface/playwright-web/surface.js';
import type { LeaseToken } from '../src/types/session.js';
import type { TargetDescriptor } from '../src/types/control.js';

/**
 * The only test in the suite that drives a real browser.
 *
 * Everything else runs against recorded observations, which is fast and deterministic but proves
 * nothing about the EXTRACTION. This one proves the pipeline itself: a real Chromium, the real
 * accessibility tree, the real input path, the real guardrail.
 */

const descriptor = (
  semantic: TargetDescriptor['semantic'],
  recordedTier: TargetDescriptor['recordedTier'],
): TargetDescriptor => ({ semantic, recordedTier });

const D = {
  operator: descriptor(
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
  open10001: descriptor(
    {
      role: 'link',
      name: 'Open',
      nameMatch: 'exact',
      rowKey: { cellText: { kind: 'literal', value: '10001' } },
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
  deposit: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Initial Deposit'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  continue: descriptor(
    { role: 'button', name: 'Continue', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
  submit: descriptor(
    { role: 'button', name: 'Submit Request', nameMatch: 'exact' },
    'T1_EXACT_ROLE_NAME',
  ),
} as const;

describe('the live input path', () => {
  let closeFixture: () => Promise<void>;
  let closeBrowser: () => Promise<void>;
  let surface: PlaywrightWebSurface;
  let token: LeaseToken;

  beforeAll(async () => {
    const { app } = createLegacyApp({ tenant: tenantA });
    const origin = await new Promise<string>((resolve) => {
      const server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        closeFixture = () => new Promise<void>((done) => server.close(() => done()));
        resolve('http://127.0.0.1:' + address.port);
      });
    });

    const browser = await launchDeterministicBrowser({ headless: true });
    closeBrowser = browser.close;

    const lease = new LeaseManager();
    surface = new PlaywrightWebSurface({
      page: browser.page,
      context: browser.context,
      allowedOrigin: origin,
      lease,
      session: new SessionStateMachine(),
      values: { secrets: { operatorId: 'fixture-operator', passcode: 'fixture-passcode' } },
    });
    token = lease.issue('AUTOMATION', 600_000);

    await surface.resolveAndPerform({ type: 'navigate', pathSegments: [] }, token);
    await surface.resolveAndPerform(
      { type: 'type', target: D.operator, value: { kind: 'secretRef', name: 'operatorId' } },
      token,
    );
    await surface.resolveAndPerform(
      { type: 'type', target: D.passcode, value: { kind: 'secretRef', name: 'passcode' } },
      token,
    );
    await surface.resolveAndPerform({ type: 'click', target: D.logIn }, token);
    await surface.waitFor({ kind: 'text_present', text: 'Member Search' }, 10_000);
  }, 120_000);

  afterAll(async () => {
    await closeBrowser?.();
    await closeFixture?.();
  });

  it('observes the search box inside contentFrame through the accessibility tree', async () => {
    const observation = await surface.observe();
    expect(observation.perceptionPath).toBe('cdp_ax');

    const control = observation.controls.find(
      (candidate) =>
        candidate.role === 'textbox' &&
        (candidate.name.includes('Member ID') ||
          candidate.nearbyText.some((text) => text.includes('Member ID'))),
    );

    expect(control).toBeDefined();
    expect(control?.contextPath).toEqual(['contentFrame']);
  });

  it('throws LEASE_VIOLATION for a token that is no longer current', async () => {
    const stale = { ...token, leaseId: 'not-the-current-lease' };
    await expect(
      surface.resolveAndPerform({ type: 'click', target: D.search }, stale),
    ).rejects.toBeInstanceOf(LeaseViolationError);
  });

  it('blocks navigation off the configured origin', async () => {
    const { result } = await surface.resolveAndPerform(
      {
        type: 'navigate',
        pathSegments: [{ kind: 'literal', value: 'https://attacker.test/exfiltrate' }],
      },
      token,
    );

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') return;
    expect(result.error).toBe('ALLOWLIST_VIOLATION');
  });

  it('walks the happy path and then refuses to press Submit Request', async () => {
    const step = async (
      action: Parameters<typeof surface.resolveAndPerform>[0],
    ): Promise<
      ReturnType<typeof surface.resolveAndPerform> extends Promise<infer R> ? R : never
    > => {
      const outcome = await surface.resolveAndPerform(action, token);
      expect(outcome.result.status).toBe('performed');
      return outcome;
    };

    await step({ type: 'type', target: D.memberId, value: { kind: 'literal', value: '1000' } });
    await step({ type: 'click', target: D.search });
    await surface.waitFor({ kind: 'text_present', text: 'Search Results' }, 10_000);

    // Four identical "Open" links on this screen; only the row key separates them.
    const open = await step({ type: 'click', target: D.open10001 });
    expect(open.trace.tierUsed).toBe('T5_STRUCTURAL_ROW');
    await surface.waitFor({ kind: 'text_present', text: 'Member Record' }, 10_000);

    await step({ type: 'click', target: D.newSubAccount });
    await surface.waitFor({ kind: 'text_present', text: 'Account Type' }, 10_000);

    // No accessible name at all: resolved purely by the cell to its left.
    const chosen = await step({
      type: 'select',
      target: D.accountType,
      value: { kind: 'literal', value: 'Savings' },
    });
    expect(chosen.trace.tierUsed).toBe('T3_EXTERNAL_LABEL_OR_NEARBY');

    await step({ type: 'type', target: D.deposit, value: { kind: 'literal', value: '250.00' } });
    await step({ type: 'click', target: D.continue });
    await surface.waitFor({ kind: 'text_present', text: 'Review Sub-Account Request' }, 10_000);

    // The screen renders "$250.00" for a value typed as "250.00". Same money, different text.
    const review = await surface.observe();
    expect(review.controls.some((control) => control.name === '$250.00')).toBe(true);
    expect(review.controls.some((control) => control.name === 'PENDING REVIEW')).toBe(true);

    const attempt = await surface.resolveAndPerform({ type: 'click', target: D.submit }, token);
    expect(attempt.result.status).toBe('blocked');
    if (attempt.result.status !== 'blocked') return;
    expect(attempt.result.error).toBe('POLICY_BLOCKED');
    expect(attempt.result.reason).toContain('Submit Request');
  }, 120_000);
});
