import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { generateOperatorToken, interventionPath } from '../src/escalation/console-security.js';
import { startOperatorConsole, type RunningConsole } from '../src/escalation/console.js';
import { newInterventionId } from '../src/escalation/handoff.js';
import type { Intervention } from '../src/types/intervention.js';

/**
 * ================================================================================================
 * WHAT A PERSON ACTUALLY DOES: OPEN THE URL, TYPE THE TOKEN, LOOK AT THE SCREEN.
 * ================================================================================================
 *
 * This file exists because the console shipped in a state where it could not be opened at all, and
 * a full suite of route-level tests said everything was fine.
 *
 * Those tests asked the server for `/complete` and got a 404, asked for data without a cookie and
 * got a 401, checked that the token was in no URL. Every one of them was correct. Not one of them
 * did the FIRST thing a person does, which is a GET on the URL printed in the banner - and that GET
 * returned `{"error":"no valid console session"}`, because the page was mounted behind the very
 * cookie the page exists to obtain.
 *
 * The lesson is not "add a test for that bug". It is that a test which drives the API is testing a
 * DIFFERENT ARTEFACT from the one a human uses, and it will keep passing while the human-facing one
 * is broken. So this file drives a REAL BROWSER through the REAL SEQUENCE:
 *
 *     GET the banner URL with no cookie  ->  HTML, 200
 *     type the token and submit          ->  cookie set
 *     the operator view renders          ->  the reason, the step, the live screenshot
 *     choose Resume                      ->  the run is told
 *
 * If any link in that chain breaks, the handoff cannot be driven by hand, whatever the route tests
 * say.
 */

function intervention(id: string): Intervention {
  return {
    id,
    createdAt: new Date().toISOString(),
    kind: 'unknown_state',
    runId: 'runs/replay-1',
    mode: 'replay',
    capabilityId: 'prepare_subaccount_review',
    capabilityVersion: '1.0.0',
    currentStep: {
      id: 'step-4-open-subaccount-form',
      index: 3,
      intent: 'Open the sub-account form for the member identified by memberId',
    },
    stopReason: 'a blocking dialog ("Compliance attestation required") is displayed',
    state: {
      screenIdentity: 'Member Record',
      visibleHeading: 'Member Record',
      maskedScreenshotRef: 'runs/replay-1/screenshots/0001.png',
      inventoryRef: 'runs/replay-1/observation-abc.json',
    },
    previousAction: 'click (step-4-open-subaccount-form)',
    policyContext: {
      allowedOrigins: ['http://localhost:4180'],
      maxRiskAllowed: 'RISKY_REVERSIBLE',
      deniedControlPhrases: ['submit request'],
    },
    allowedChoices: ['resume', 'abort'],
    status: 'open',
  };
}

/** A 1x1 PNG, so the live view has something real to render. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('the operator console, driven the way a person drives it', () => {
  let browser: Browser;
  let page: Page;
  let console_: RunningConsole;
  const token = generateOperatorToken();
  const id = newInterventionId();
  let chosen: string | null = null;

  beforeAll(async () => {
    console_ = await startOperatorConsole(
      {
        get: (asked) => (asked === id ? intervention(id) : undefined),
        screenshot: () => Promise.resolve(PIXEL),
        choose: (_asked, choice) => {
          chosen = choice;
          return Promise.resolve();
        },
      },
      { token },
    );
    console_.banner(id);

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await console_?.close();
  });

  it('[MUST] the banner URL opens the token prompt, with no cookie', async () => {
    // THE BUG. This returned {"error":"no valid console session"} and there was nowhere to type a
    // token, so the handoff could not be driven by hand at all.
    const response = await page.goto(console_.url + interventionPath(id));

    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('text/html');
    expect(await page.locator('#token').isVisible()).toBe(true);
    expect(await page.locator('#unlock').isVisible()).toBe(true);
    expect(await page.textContent('body')).toContain('Operator token');
  }, 60_000);

  it('[MUST] the URL the banner prints is the URL the page is served at', async () => {
    // The cause underneath the bug: the banner built its URL from one literal and the page was
    // mounted at another. Both strings were correct; they were not the same string.
    expect(console_.banner(id)).toContain(interventionPath(id));
  });

  it('shows nothing about the intervention before the token is entered', async () => {
    const html = await page.content();

    expect(html).not.toContain('Compliance attestation required');
    expect(html).not.toContain('step-4-open-subaccount-form');
  }, 60_000);

  it('[MUST] typing the token exchanges it for a cookie and renders the operator view', async () => {
    await page.fill('#token', token);
    await page.click('#unlock');

    // The detail the person needs in order to decide, on screen rather than in a JSON response.
    await page.waitForSelector('#panel:not([hidden])', { timeout: 10_000 });
    const shown = (await page.textContent('body')) ?? '';
    expect(shown).toContain('Compliance attestation required');
    expect(shown).toContain('Open the sub-account form');
    expect(shown).toContain('Member Record');
    expect(await page.locator('#gate').isVisible()).toBe(false);

    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === 'MERIDIAN_OPERATOR');
    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Strict');

    // The token itself is not kept anywhere the page can read it.
    expect(await page.evaluate('localStorage.length')).toBe(0);
    expect(await page.inputValue('#token')).toBe('');
  }, 60_000);

  it('renders the live masked view', async () => {
    const src = await page.getAttribute('#shot', 'src');
    expect(src).toContain('data:image/png;base64,');
  }, 60_000);

  it('[MUST] offers Resume and Abort, and nothing that says complete', async () => {
    expect(await page.locator('#resume').isVisible()).toBe(true);
    expect(await page.locator('#abort').isVisible()).toBe(true);

    const text = (await page.textContent('body')) ?? '';
    expect(text.toLowerCase()).not.toContain('mark complete');
    expect(text.toLowerCase()).not.toContain('mark as done');
    // And it says so out loud, because an operator who expects a "done" button should be told why
    // there is not one.
    expect(text).toContain('there is no');
  }, 60_000);

  it('[MUST] clicking Resume reaches the run', async () => {
    await page.click('#resume');
    await page.waitForSelector('#finished:not([hidden])', { timeout: 10_000 });
    expect(await page.textContent('#finished')).toContain('Control handed back');

    expect(chosen).toBe('resume');
  }, 60_000);

  it('an UNKNOWN intervention id gets the same page, not a 404 oracle', async () => {
    // Returning 404 here would say which interventions exist, which is the same enumeration attack
    // the missing list endpoint prevents. The page is static; `/auth` refuses the id afterwards
    // with the same 401 a bad token gets.
    const other = await browser.newPage();
    try {
      const response = await other.goto(console_.url + interventionPath(newInterventionId()));
      expect(response?.status()).toBe(200);
      expect(await other.locator('#unlock').isVisible()).toBe(true);
    } finally {
      await other.close();
    }
  }, 60_000);

  it('a wrong token is refused in the page, without revealing anything', async () => {
    const other = await browser.newPage();
    try {
      await other.goto(console_.url + interventionPath(id));
      await other.fill('#token', 'not-the-token');
      await other.click('#unlock');

      await other.waitForFunction(
        "document.getElementById('gateError').textContent.length > 0",
        undefined,
        { timeout: 10_000 },
      );
      expect(await other.textContent('#gateError')).toContain('Rejected');
      expect(await other.content()).not.toContain('Compliance attestation required');
    } finally {
      await other.close();
    }
  }, 60_000);
});
