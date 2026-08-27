import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attributeValues,
  getHtml,
  signOn,
  startLegacyApp,
  type RunningLegacyApp,
} from '../helpers/legacy-app.js';

describe('MERIDIAN Core Servicing fixture', () => {
  let app: RunningLegacyApp;
  let cookie: string;

  beforeAll(async () => {
    app = await startLegacyApp({ seed: 1234 });
    cookie = await signOn(app.baseUrl);
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves a sign-on screen carrying the version marker', async () => {
    const html = await getHtml(app.baseUrl, '/', cookie);
    expect(html).toContain('MERIDIAN Core v3.2.1');
    expect(html).toContain('Core Servicing Sign On');
  });

  it('never emits a data-testid', async () => {
    for (const path of ['/', '/app', '/search?q=10001', '/member/10001/subaccount/new']) {
      const html = await getHtml(app.baseUrl, path, cookie);
      expect(html).not.toContain('data-testid');
    }
  });

  it('puts navigation and content in named iframes', async () => {
    const html = await getHtml(app.baseUrl, '/app', cookie);
    expect(html).toContain('name="navFrame"');
    expect(html).toContain('name="contentFrame"');
  });

  it('gives the member-search field a real <label for> (the deliberate exception)', async () => {
    const html = await getHtml(app.baseUrl, '/search', cookie);
    const labelFor = /<label for="([^"]+)">Member ID<\/label>/.exec(html);
    expect(labelFor).not.toBeNull();
    expect(html).toContain(`id="${labelFor?.[1]}" name="ctl00$Main$txtMemberId"`);
  });

  it('labels every other form field with the adjacent cell to the left, not <label for>', async () => {
    const html = await getHtml(app.baseUrl, '/member/10001/subaccount/new', cookie);
    expect(html).toContain('Account Type');
    expect(html).toContain('Initial Deposit');
    // No label element anywhere on the sub-account form.
    expect(html).not.toContain('<label');
  });

  it('finds a member by exact id', async () => {
    const html = await getHtml(app.baseUrl, '/search?q=10001', cookie);
    expect(html).toContain('Avery Lin');
    expect(html).toContain('Search Results');
  });

  it('accepts the search field under its legacy-stable ASP name', async () => {
    const html = await getHtml(
      app.baseUrl,
      `/search?${encodeURIComponent('ctl00$Main$txtMemberId')}=10002`,
      cookie,
    );
    expect(html).toContain('Jordan Reyes');
  });

  it('returns several identically-named "Open" links for a partial id (the T5 case)', async () => {
    const html = await getHtml(app.baseUrl, '/search?q=1000', cookie);
    const openLinks = html.match(/>Open</g) ?? [];
    expect(openLinks.length).toBe(4);
  });

  it('reports a missing member as an ordinary screen, not an error page', async () => {
    const html = await getHtml(app.baseUrl, '/search?q=99999', cookie);
    expect(html).toContain('No member found for that ID.');
  });

  it('renders balances as currency text from minor units', async () => {
    const html = await getHtml(app.baseUrl, '/member/10001', cookie);
    expect(html).toContain('$4,123.55');
    expect(html).toContain('$18,750.00');
  });

  // ---------------------------------------------------------------------------------------------
  // [MUST] Clarification 3. If this test ever fails, do not debug the agent.
  // ---------------------------------------------------------------------------------------------
  it('starts the sub-account form NEUTRAL: placeholder selected, both text fields empty', async () => {
    const html = await getHtml(app.baseUrl, '/member/10001/subaccount/new', cookie);

    expect(html).toContain('<option value="" selected>Select an account type</option>');
    expect(html).not.toContain('<option value="Savings" selected>');
    expect(html).not.toContain('<option value="Checking" selected>');

    expect(html).toMatch(/name="ctl00\$Main\$txtNickname" size="28" value=""/);
    expect(html).toMatch(/name="ctl00\$Main\$txtInitialDeposit" size="14" value=""/);
  });

  it('advances to the review screen and reports PENDING REVIEW without submitting', async () => {
    const post = await fetch(`${app.baseUrl}/member/10001/subaccount/new`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ctl00$Main$ddlAccountType: 'Savings',
        ctl00$Main$txtNickname: 'Vacation',
        ctl00$Main$txtInitialDeposit: '250.00',
      }).toString(),
    });

    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toBe('/member/10001/subaccount/review');

    const review = await getHtml(app.baseUrl, '/member/10001/subaccount/review', cookie);
    expect(review).toContain('Review Sub-Account Request');
    expect(review).toContain('PENDING REVIEW');
    // The caller typed "250.00"; the review screen says "$250.00". Same money, different text -
    // which is exactly why value_matches_param compares by declared type.
    expect(review).toContain('$250.00');
    expect(review).toContain('Submit Request');
  });

  it('rejects the form when no account type was chosen', async () => {
    const post = await fetch(`${app.baseUrl}/member/10002/subaccount/new`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ctl00$Main$ddlAccountType: '',
        ctl00$Main$txtNickname: '',
        ctl00$Main$txtInitialDeposit: '250.00',
      }).toString(),
    });

    const html = await post.text();
    expect(post.status).toBe(200);
    expect(html).toContain('role="alert"');
    expect(html).toContain('You must select an account type.');
  });

  it('rejects a deposit below the tenant minimum', async () => {
    const post = await fetch(`${app.baseUrl}/member/10002/subaccount/new`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ctl00$Main$ddlAccountType: 'Checking',
        ctl00$Main$txtNickname: '',
        ctl00$Main$txtInitialDeposit: '10.00',
      }).toString(),
    });

    expect(await post.text()).toContain('Initial deposit must be at least $25.00.');
  });

  it('requires a session for every servicing screen', async () => {
    for (const path of ['/app', '/search', '/member/10001', '/member/10001/subaccount/new']) {
      const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/');
    }
  });

  it('exposes the per-boot obfuscation seed', async () => {
    const response = await fetch(`${app.baseUrl}/__test__/seed`);
    expect(await response.json()).toMatchObject({ seed: 1234, tenant: 'tenant-a' });
  });
});

describe('per-boot cosmetic instability', () => {
  it('changes every class name across boots while leaving name= attributes untouched', async () => {
    const first = await startLegacyApp({ seed: 1 });
    const second = await startLegacyApp({ seed: 2 });

    try {
      const cookieA = await signOn(first.baseUrl);
      const cookieB = await signOn(second.baseUrl);

      const htmlA = await getHtml(first.baseUrl, '/member/10001/subaccount/new', cookieA);
      const htmlB = await getHtml(second.baseUrl, '/member/10001/subaccount/new', cookieB);

      // This is the whole thesis in one assertion pair.
      const namesA = attributeValues(htmlA, 'name');
      const namesB = attributeValues(htmlB, 'name');
      expect(namesA).toEqual(namesB);
      expect(namesA).toContain('ctl00$Main$ddlAccountType');

      const classesA = new Set(attributeValues(htmlA, 'class'));
      const classesB = new Set(attributeValues(htmlB, 'class'));
      expect(classesA.size).toBeGreaterThan(0);
      for (const token of classesA) expect(classesB.has(token)).toBe(false);

      const idsA = new Set(attributeValues(htmlA, 'id'));
      const idsB = new Set(attributeValues(htmlB, 'id'));
      for (const token of idsA) expect(idsB.has(token)).toBe(false);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
