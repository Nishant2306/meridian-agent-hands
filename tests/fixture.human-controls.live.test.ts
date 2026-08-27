import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createLegacyApp } from '../fixtures/legacy-app/server.js';
import { tenantA } from '../fixtures/legacy-app/tenants/tenant-a.js';
import { FAULT_TEXT } from '../fixtures/legacy-app/faults.js';

/**
 * ================================================================================================
 * THE FIXTURE'S HUMAN-FACING CONTROLS, CLICKED BY A BROWSER.
 * ================================================================================================
 *
 * D66 says: where a human-facing path exists, at least one test uses it the way the human does. That
 * rule was applied to the operator console and NOT to the application a person is handed control of,
 * and the gap cost a third blocked gate.
 *
 * The attestation modal was reachable, detected, escalated and reported correctly - the whole
 * handoff mechanism worked - and the button that clears it did nothing. Every automated test POSTed
 * to the route instead of clicking the control, so the route was proven and the CONTROL was not.
 *
 * The cause was worth the embarrassment: the handler deleted `showUnknownModal` from the SESSION
 * fault store, and for member 20001 that flag lives in the SEED DATA. It removed something that was
 * never there, the next render read the seeded flag again, and the modal never went away.
 *
 * So this file clicks. Every control here is one a person uses during the documented walkthrough,
 * and each test drives it with a real browser and then asserts the SCREEN CHANGED.
 */
describe('a person can operate the fixture controls the walkthrough depends on', () => {
  let browser: Browser;
  let page: Page;
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const { app } = createLegacyApp({ tenant: tenantA });
    base = await new Promise<string>((resolve) => {
      const server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        close = () => new Promise<void>((done) => server.close(() => done()));
        resolve('http://127.0.0.1:' + address.port);
      });
    });

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();

    // Sign on the way a person does, through the form.
    await page.goto(base + '/');
    await page.fill('input[name="ctl00$Main$txtOperator"]', 'fixture-operator');
    await page.fill('input[name="ctl00$Main$txtPasscode"]', 'fixture-passcode');
    await page.click('button[type=submit]');
    await page.waitForURL('**/app');
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await close?.();
  });

  it('[MUST] clicking the attestation button CLEARS the modal', async () => {
    // THE BUG THAT BLOCKED GATE 2. Everything up to this click worked.
    await page.goto(base + '/member/20001');
    expect(await page.locator('dialog[open]').isVisible()).toBe(true);
    expect(await page.textContent('body')).toContain(FAULT_TEXT.unknownModal);

    // The code is ON SCREEN, so a reviewer needs no knowledge they do not have.
    const shown = (await page.textContent('dialog')) ?? '';
    expect(shown).toContain(FAULT_TEXT.attestationCode);

    await page.fill('input[name="ctl00$Main$txtAttest"]', FAULT_TEXT.attestationCode);
    await page.click('button[name="ctl00$Main$btnAttest"]');
    await page.waitForURL('**/member/20001');

    // THE SCREEN CHANGED. Asserting the route returned 303 would have passed all along.
    expect(await page.locator('dialog[open]').count()).toBe(0);
    const after = (await page.textContent('body')) ?? '';
    expect(after).not.toContain(FAULT_TEXT.unknownModal);
    expect(after).toContain('Member Record');
    expect(after).toContain('New Sub-Account');
  }, 60_000);

  it('and the member record stays servable afterwards, which is what resume needs', async () => {
    // Resume re-observes and matches a resume-eligible state. If the modal came back on the next
    // render - which is exactly what the broken version did - resume would ask the same question
    // forever and the walkthrough could never be finished.
    for (let visit = 0; visit < 3; visit += 1) {
      await page.goto(base + '/member/20001');
      expect(await page.locator('dialog[open]').count(), 'visit ' + visit).toBe(0);
    }

    await page.goto(base + '/member/20001/subaccount/new');
    expect(await page.locator('dialog[open]').count()).toBe(0);
    expect(await page.textContent('body')).toContain('Account Type');
  }, 60_000);

  it('an empty code is refused, so the field is not decoration', async () => {
    const other = await browser.newPage();
    try {
      await other.goto(base + '/');
      await other.fill('input[name="ctl00$Main$txtOperator"]', 'someone');
      await other.fill('input[name="ctl00$Main$txtPasscode"]', 'else');
      await other.click('button[type=submit]');
      await other.waitForURL('**/app');

      await other.goto(base + '/member/20001');
      await other.click('button[name="ctl00$Main$btnAttest"]');

      expect(await other.textContent('body')).toContain('Enter the code shown');
      // And the modal is still there when they go back.
      await other.goto(base + '/member/20001');
      expect(await other.locator('dialog[open]').count()).toBe(1);
    } finally {
      await other.close();
    }
  }, 60_000);

  it('attesting is per SESSION, so one operator does not clear it for another', async () => {
    const other = await browser.newPage();
    try {
      await other.goto(base + '/');
      await other.fill('input[name="ctl00$Main$txtOperator"]', 'second');
      await other.fill('input[name="ctl00$Main$txtPasscode"]', 'operator');
      await other.click('button[type=submit]');
      await other.waitForURL('**/app');

      await other.goto(base + '/member/20001');
      // The first page attested; this session has not.
      expect(await other.locator('dialog[open]').count()).toBe(1);
    } finally {
      await other.close();
    }
  }, 60_000);

  it('[MUST] clicking Dismiss CLEARS the maintenance notice', async () => {
    // The other human-facing fixture control. It is a RECOVERY the automation performs itself, so
    // it has always been exercised through the input path - but never clicked, and this file is
    // about the difference.
    await page.goto(base + '/member/10004/subaccount/new');
    expect(await page.textContent('body')).toContain('Scheduled maintenance');

    await page.click('button[name="ctl00$Main$btnDismiss"]');
    await page.waitForURL('**/subaccount/new');

    expect(await page.textContent('body')).not.toContain('Scheduled maintenance');
    expect(await page.textContent('body')).toContain('Account Type');
  }, 60_000);

  it('the whole happy path is clickable by a person, end to end', async () => {
    // The walkthrough in docs/STATUS.md tells a reviewer to work in the browser window. Every
    // control it relies on is clicked here, in order, and the review screen is reached.
    await page.goto(base + '/app');
    const content = page.frameLocator('iframe[name="contentFrame"]');

    await content.locator('input[name="ctl00$Main$txtMemberId"]').fill('10001');
    await content.locator('button[name="ctl00$Main$btnSearch"]').click();
    await page.waitForTimeout(300);

    await content.getByRole('link', { name: 'Open' }).first().click();
    await page.waitForTimeout(300);
    expect(await content.locator('body').textContent()).toContain('Member Record');

    await content.getByRole('link', { name: 'New Sub-Account' }).click();
    await page.waitForTimeout(300);

    await content.locator('select[name="ctl00$Main$ddlAccountType"]').selectOption('Savings');
    await content.locator('input[name="ctl00$Main$txtInitialDeposit"]').fill('250.00');
    await content.locator('button[name="ctl00$Main$btnContinue"]').click();
    await page.waitForTimeout(400);

    const review = (await content.locator('body').textContent()) ?? '';
    expect(review).toContain('Review Sub-Account Request');
    expect(review).toContain('PENDING REVIEW');
    // And the button nothing may press is there, unpressed.
    expect(review).toContain('Submit Request');
  }, 120_000);
});
