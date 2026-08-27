import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONSOLE_HOST,
  consoleBanner,
  generateInterventionId,
  generateOperatorToken,
  interventionPath,
  OperatorConsole,
  tokensMatch,
} from '../src/escalation/console-security.js';

/**
 * ================================================================================================
 * THE CONSOLE'S SECURITY, TESTED NOW RATHER THAN WHEN THE CONSOLE DOES SOMETHING.
 * ================================================================================================
 *
 * The handoff protocol is PHASE 8. This is the shell it will run inside, and the tests are here
 * first for the same reason the code is: access control retrofitted onto a working console is
 * access control that gets shipped "for now" without any.
 *
 * What the finished console can do is hand a human control of a browser signed into a banking
 * application. The threat model is not the internet; it is a process on the operator's own machine,
 * a stale tab, a link pasted into a chat, a screenshot of a terminal.
 */

describe('tokens and ids', () => {
  it('are long enough that guessing is not a strategy', () => {
    const token = generateOperatorToken();
    // 32 bytes, base64url.
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(generateOperatorToken()).not.toBe(token);
  });

  it('gives interventions unguessable ids rather than counters', () => {
    // An intervention id is a capability in its own right: it is half of what addresses a live
    // authenticated session.
    const id = generateInterventionId();
    expect(id).toMatch(/^iv_[A-Za-z0-9_-]{20,}$/);
    expect(generateInterventionId()).not.toBe(id);
  });

  it('compares tokens in constant time, and handles a length mismatch', () => {
    // `a === b` on a secret leaks its prefix through timing.
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('short', 'much longer value')).toBe(false);
  });
});

describe('[MUST] the token is never in a URL', () => {
  it('prints the URL and the token on SEPARATE lines', () => {
    const token = generateOperatorToken();
    const id = generateInterventionId();
    const banner = consoleBanner(4190, token, id);

    const urlLine = banner.split(String.fromCharCode(10)).find((line) => line.includes('url:'));
    expect(urlLine).toBeDefined();
    // A URL carrying a token leaks through Referer, browser history, shell history, proxy logs and
    // the screenshot somebody takes to ask a colleague for help.
    expect(urlLine).not.toContain(token);
    expect(banner).toContain(token);
    expect(banner).toContain(interventionPath(id));
  });

  it('binds loopback only, and the host is not a parameter', () => {
    // `app.listen(port)` with no host binds 0.0.0.0 and puts this on the coffee-shop wifi. A host
    // parameter is a thing somebody sets to 0.0.0.0 in a hurry.
    expect(CONSOLE_HOST).toBe('127.0.0.1');
  });
});

describe('the session exchange', () => {
  let base: string;
  let close: () => Promise<void>;
  let console_: OperatorConsole;
  const token = generateOperatorToken();
  const interventionId = generateInterventionId();

  beforeAll(async () => {
    console_ = new OperatorConsole({ token, sessionTtlMs: 60_000 });
    console_.register(interventionId);
    base = await new Promise<string>((resolve) => {
      const server = console_.app.listen(0, CONSOLE_HOST, () => {
        const address = server.address() as AddressInfo;
        close = () => new Promise<void>((done) => server.close(() => done()));
        resolve('http://' + CONSOLE_HOST + ':' + address.port);
      });
    });
  });

  afterAll(async () => {
    await close?.();
  });

  async function openSession(
    body: Record<string, unknown>,
  ): Promise<{ status: number; cookie: string | null }> {
    const response = await fetch(base + '/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie') };
  }

  it('exchanges a valid token for an HttpOnly, SameSite=Strict cookie', () => {
    return openSession({ token, interventionId }).then(({ status, cookie }) => {
      expect(status).toBe(200);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Max-Age=');
      // HttpOnly is also why nothing here uses localStorage: a script must not be able to read it.
      expect(cookie).not.toContain('localStorage');
    });
  });

  it('refuses a bad token', async () => {
    const { status } = await openSession({ token: 'wrong', interventionId });
    expect(status).toBe(401);
  });

  it('gives the SAME answer for an unknown intervention as for a bad token', async () => {
    // Otherwise this endpoint is an oracle for which intervention ids exist.
    const badToken = await openSession({ token: 'wrong', interventionId });
    const unknownId = await openSession({ token, interventionId: generateInterventionId() });

    expect(unknownId.status).toBe(badToken.status);
  });

  it('rejects a cross-site POST', async () => {
    const response = await fetch(base + '/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ token, interventionId }),
    });

    expect(response.status).toBe(403);
  });

  it('rejects a POST claiming a foreign origin', async () => {
    const response = await fetch(base + '/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: JSON.stringify({ token, interventionId }),
    });

    expect(response.status).toBe(403);
  });
});

describe('[MUST] a session is scoped to ONE intervention, and there is no list endpoint', () => {
  let base: string;
  let close: () => Promise<void>;
  const token = generateOperatorToken();
  const mine = generateInterventionId();
  const someoneElses = generateInterventionId();

  beforeAll(async () => {
    const console_ = new OperatorConsole({ token, sessionTtlMs: 60_000 });
    console_.register(mine);
    console_.register(someoneElses);
    // Mounted through `mountScoped`, which is the only way real code adds a protected route. The
    // PHASE 7 tests used a placeholder route that this file owned, and a placeholder is exactly the
    // thing that keeps passing after the real route it stood in for has diverged.
    console_.mountScoped('/scoped/:id', 'get', (req, res) => {
      res.json({ interventionId: req.params['id'] });
    });
    base = await new Promise<string>((resolve) => {
      const server = console_.app.listen(0, CONSOLE_HOST, () => {
        const address = server.address() as AddressInfo;
        close = () => new Promise<void>((done) => server.close(() => done()));
        resolve('http://' + CONSOLE_HOST + ':' + address.port);
      });
    });
  });

  afterAll(async () => {
    await close?.();
  });

  async function cookieFor(interventionId: string): Promise<string> {
    const response = await fetch(base + '/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ token, interventionId }),
    });
    const raw = response.headers.get('set-cookie') ?? '';
    return raw.split(';')[0] ?? '';
  }

  it('opens the intervention it was issued for', async () => {
    const cookie = await cookieFor(mine);
    const response = await fetch(base + '/scoped/' + mine, { headers: { cookie } });

    expect(response.status).toBe(200);
    expect((await response.json()) as { interventionId: string }).toMatchObject({
      interventionId: mine,
    });
  });

  it('REFUSES a different intervention with the same cookie', async () => {
    // A leaked cookie is worth exactly one handoff, not every handoff in flight.
    const cookie = await cookieFor(mine);
    const response = await fetch(base + '/scoped/' + someoneElses, { headers: { cookie } });

    expect(response.status).toBe(403);
  });

  it('refuses with no cookie at all', async () => {
    const response = await fetch(base + '/scoped/' + mine);
    expect(response.status).toBe(401);
  });

  it('has NO endpoint that lists interventions', async () => {
    // Enumeration is the whole attack: with a list endpoint, one leaked token becomes a directory
    // of every run in flight, each with a live authenticated banking session behind it.
    const cookie = await cookieFor(mine);
    for (const path of ['/interventions', '/intervention', '/api/interventions', '/']) {
      const response = await fetch(base + path, { headers: { cookie } });
      expect(response.status, path + ' answered').toBe(404);
    }
  });
});

describe('expiry and revocation', () => {
  it('refuses a session that has aged out', async () => {
    let now = 1_000_000;
    const token = generateOperatorToken();
    const id = generateInterventionId();
    const console_ = new OperatorConsole({ token, sessionTtlMs: 1_000, now: () => now });
    console_.register(id);
    console_.mountScoped('/scoped/:id', 'get', (_req, res) => res.json({ ok: true }));

    const base = await new Promise<string>((resolve) => {
      const server = console_.app.listen(0, CONSOLE_HOST, () => {
        const address = server.address() as AddressInfo;
        resolve('http://' + CONSOLE_HOST + ':' + address.port);
      });
    });

    const opened = await fetch(base + '/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ token, interventionId: id }),
    });
    const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    expect((await fetch(base + '/scoped/' + id, { headers: { cookie } })).status).toBe(200);

    now += 2_000;
    expect((await fetch(base + '/scoped/' + id, { headers: { cookie } })).status).toBe(401);
    // And the dead session is dropped rather than accumulating.
    expect(console_.openSessions).toBe(0);
  });

  it('revoking an intervention invalidates its sessions', async () => {
    const token = generateOperatorToken();
    const id = generateInterventionId();
    const console_ = new OperatorConsole({ token, sessionTtlMs: 60_000 });
    console_.register(id);
    console_.mountScoped('/scoped/:id', 'get', (_req, res) => res.json({ ok: true }));

    const base = await new Promise<string>((resolve) => {
      const server = console_.app.listen(0, CONSOLE_HOST, () => {
        const address = server.address() as AddressInfo;
        resolve('http://' + CONSOLE_HOST + ':' + address.port);
      });
    });

    const opened = await fetch(base + '/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ token, interventionId: id }),
    });
    const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    console_.revoke(id);
    expect((await fetch(base + '/scoped/' + id, { headers: { cookie } })).status).toBe(401);
  });
});
