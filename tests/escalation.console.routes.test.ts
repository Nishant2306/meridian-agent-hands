import { describe, expect, it } from 'vitest';
import { generateOperatorToken } from '../src/escalation/console-security.js';
import { startOperatorConsole, type ConsoleChoice } from '../src/escalation/console.js';
import { newInterventionId } from '../src/escalation/handoff.js';
import type { Intervention } from '../src/types/intervention.js';

/**
 * ================================================================================================
 * WHAT THE CONSOLE CAN AND CANNOT BE ASKED TO DO.
 * ================================================================================================
 *
 * The absences are the design, so they are tested as hard as the presences. A console that grew a
 * `/complete` button would make the strongest claim in this project false, and it would not fail
 * any test that only checked the happy path.
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
    currentStep: { id: 'step-4', index: 3, intent: 'Open the sub-account form' },
    stopReason: 'a blocking dialog is displayed and no condition in the profile describes it',
    state: {
      screenIdentity: 'Member Record',
      visibleHeading: 'Member Record',
      maskedScreenshotRef: 'runs/replay-1/screenshots/0001.png',
      inventoryRef: 'runs/replay-1/observation-abc.json',
    },
    previousAction: 'click (step-4)',
    policyContext: {
      allowedOrigins: ['http://localhost:4180'],
      maxRiskAllowed: 'RISKY_REVERSIBLE',
      deniedControlPhrases: ['submit request'],
    },
    allowedChoices: ['resume', 'abort'],
    status: 'open',
  };
}

async function withConsole(
  run: (context: {
    base: string;
    token: string;
    id: string;
    chosen: () => { choice: ConsoleChoice; notes: string } | null;
    cookie: () => Promise<string>;
  }) => Promise<void>,
): Promise<void> {
  const token = generateOperatorToken();
  const id = newInterventionId();
  let chosen: { choice: ConsoleChoice; notes: string } | null = null;

  const console_ = await startOperatorConsole(
    {
      get: (asked) => (asked === id ? intervention(id) : undefined),
      screenshot: () => Promise.resolve('data:image/png;base64,AAAA'),
      choose: (_asked, choice, notes) => {
        chosen = { choice, notes };
        return Promise.resolve();
      },
    },
    { token },
  );
  console_.banner(id);

  const cookie = async (): Promise<string> => {
    const response = await fetch(console_.url + '/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ token, interventionId: id }),
    });
    return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };

  try {
    await run({ base: console_.url, token, id, chosen: () => chosen, cookie });
  } finally {
    await console_.close();
  }
}

describe('[MUST] the console cannot be asked to declare success', () => {
  it('has NO /complete endpoint', async () => {
    await withConsole(async ({ base, id, cookie }) => {
      const authed = await cookie();
      for (const path of [
        '/i/' + id + '/complete',
        '/i/' + id + '/success',
        '/i/' + id + '/done',
      ]) {
        const response = await fetch(base + path, {
          method: 'POST',
          headers: {
            cookie: authed,
            'content-type': 'application/json',
            'sec-fetch-site': 'same-origin',
          },
          body: '{}',
        });
        expect(response.status, path + ' answered').toBe(404);
      }
    });
  });

  it('offers the operator exactly resume and abort', async () => {
    await withConsole(async ({ base, id, cookie }) => {
      const response = await fetch(base + '/i/' + id + '/detail', {
        headers: { cookie: await cookie() },
      });
      const body = (await response.json()) as Intervention;

      expect(body.allowedChoices).toEqual(['resume', 'abort']);
    });
  });

  it('has NO endpoint that lists interventions', async () => {
    await withConsole(async ({ base, cookie }) => {
      const authed = await cookie();
      for (const path of ['/i', '/interventions', '/api/interventions']) {
        const response = await fetch(base + path, { headers: { cookie: authed } });
        expect(response.status, path + ' answered').toBe(404);
      }
    });
  });
});

describe('every route with data behind it needs the cookie', () => {
  it('refuses detail, screenshot, resume and abort without one', async () => {
    await withConsole(async ({ base, id }) => {
      expect((await fetch(base + '/i/' + id + '/detail')).status).toBe(401);
      expect((await fetch(base + '/i/' + id + '/screenshot')).status).toBe(401);

      for (const choice of ['resume', 'abort']) {
        const response = await fetch(base + '/i/' + id + '/' + choice, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
          body: '{}',
        });
        expect(response.status, choice).toBe(401);
      }
    });
  });

  it('serves the PAGE without a cookie, because the page is what asks for one', async () => {
    await withConsole(async ({ base, id }) => {
      const response = await fetch(base + '/i/' + id);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('Operator token');
      // And it does not leak the intervention's contents to an unauthenticated caller.
      expect(html).not.toContain('Open the sub-account form');
    });
  });

  it('[MUST] the token appears in no URL the page ever constructs', async () => {
    await withConsole(async ({ base, id, token }) => {
      const html = await (await fetch(base + '/i/' + id)).text();

      expect(html).not.toContain(token);
      // The page posts the token in a JSON BODY, once, and never puts it in a query string.
      expect(html).toContain("fetch('/auth'");
      expect(html).not.toMatch(/[?&]token=/);
    });
  });
});

describe('the two choices', () => {
  it('resume reaches the run, with the notes', async () => {
    await withConsole(async ({ base, id, cookie, chosen }) => {
      const response = await fetch(base + '/i/' + id + '/resume', {
        method: 'POST',
        headers: {
          cookie: await cookie(),
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ notes: 'cleared the attestation modal by hand' }),
      });

      expect(response.status).toBe(200);
      expect(chosen()).toEqual({
        choice: 'resume',
        notes: 'cleared the attestation modal by hand',
      });
    });
  });

  it('abort reaches the run', async () => {
    await withConsole(async ({ base, id, cookie, chosen }) => {
      await fetch(base + '/i/' + id + '/abort', {
        method: 'POST',
        headers: {
          cookie: await cookie(),
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ notes: '' }),
      });

      expect(chosen()?.choice).toBe('abort');
    });
  });

  it('serves a masked screenshot of the same page', async () => {
    await withConsole(async ({ base, id, cookie }) => {
      const response = await fetch(base + '/i/' + id + '/screenshot', {
        headers: { cookie: await cookie() },
      });
      const body = (await response.json()) as { dataUri: string };

      expect(body.dataUri.startsWith('data:image/png;base64,')).toBe(true);
    });
  });
});
