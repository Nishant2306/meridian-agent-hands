import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

/**
 * ================================================================================================
 * OPERATOR CONSOLE SECURITY. THE MINIMUM, BUILT NOW, NOT DEFERRED TO PHASE 8.
 * ================================================================================================
 *
 * The handoff PROTOCOL - pause, cede, resume on the same live session - is PHASE 8. This file is
 * the shell it will run inside, and it is built first on purpose: an access-control layer retrofitted
 * onto a working console is an access-control layer that gets shipped "for now" without one.
 *
 * What this console can do, once PHASE 8 fills it in, is hand a human control of a browser that is
 * signed into a banking application. That is the most dangerous surface in the project, and the
 * threat model is not an attacker on the internet - it is a process on the operator's own machine,
 * a stale browser tab, a link in a chat window, a screenshot of a terminal.
 *
 * ------------------------------------------------------------------------------------------------
 * [MUST] THE TOKEN IS NEVER IN A URL
 * ------------------------------------------------------------------------------------------------
 * A URL carrying a token leaks through the Referer header, the browser history, the shell history,
 * any proxy log, and the screenshot somebody takes of their terminal to ask a colleague for help.
 * So the CLI prints the URL and the token on SEPARATE LINES, the page asks for the token once, and
 * that is the only time it is transmitted. It is exchanged immediately for a cookie.
 *
 * ------------------------------------------------------------------------------------------------
 * [MUST] THERE IS NO list-all-interventions ENDPOINT
 * ------------------------------------------------------------------------------------------------
 * A per-run token should not authorize viewing every open intervention. Enumeration is the whole
 * attack: with a list endpoint, one leaked token from one run becomes a directory of every run in
 * flight, each with a live authenticated banking session behind it. The session cookie is scoped to
 * ONE intervention id and the id is unguessable, so a token buys exactly the thing it was issued
 * for.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT IS HONESTLY NOT HERE
 * ------------------------------------------------------------------------------------------------
 * Enterprise identity, RBAC, per-operator accounts, audit against a real directory, and remote
 * operator access. REPORT.md says so in those words. What it must NOT say is that the console has
 * no access protection, because it does, and the difference matters to whoever deploys it.
 */

/** 32 bytes. Long enough that guessing is not a strategy, short enough to retype from a terminal. */
export function generateOperatorToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 16 bytes. An intervention id is a capability in its own right, so it is not a counter. */
export function generateInterventionId(): string {
  return 'iv_' + randomBytes(16).toString('base64url');
}

/** Constant time, and length-safe. `a === b` on a secret leaks its prefix through timing. */
export function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ConsoleSession {
  readonly interventionId: string;
  readonly expiresAt: number;
}

export interface OperatorConsoleOptions {
  /** The per-run token. Printed by the CLI on its own line; never placed in a URL. */
  readonly token: string;
  /** How long a console cookie stays valid. Short: this is an attended workflow. */
  readonly sessionTtlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const COOKIE_NAME = 'MERIDIAN_OPERATOR';

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

export class OperatorConsole {
  readonly app: Express;
  readonly #token: string;
  readonly #ttl: number;
  readonly #now: () => number;
  /** cookie value -> the ONE intervention it authorizes. */
  readonly #sessions = new Map<string, ConsoleSession>();
  readonly #interventions = new Set<string>();
  #requireScopedSession: ((req: Request, res: Response, next: NextFunction) => void) | undefined;

  constructor(options: OperatorConsoleOptions) {
    this.#token = options.token;
    this.#ttl = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = options.now ?? (() => Date.now());

    const app = express();
    app.disable('x-powered-by');
    // No CORS middleware, deliberately. There is no browser origin other than this one that has any
    // business calling these routes, and the absence of the header is the policy.
    app.use(express.json({ limit: '16kb' }));

    // ------------------------------------------------------------------------------------------
    // Anti-CSRF, applied to every state-changing request.
    //
    // Two independent checks, because each covers a case the other does not:
    //   Sec-Fetch-Site  a modern browser sets it on the request itself and a page cannot forge it
    //   Origin          checked against the loopback host we bound to
    // A form POSTed from evil.example.com carries `Sec-Fetch-Site: cross-site` and a foreign
    // Origin, and fails both. SameSite=Strict on the cookie already stops it being SENT, so this is
    // the second layer rather than the only one.
    // ------------------------------------------------------------------------------------------
    app.use((req, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        next();
        return;
      }
      const site = req.headers['sec-fetch-site'];
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
        res.status(403).json({ error: 'cross-site request refused' });
        return;
      }
      const origin = req.headers.origin;
      if (typeof origin === 'string') {
        const host = new URL(origin).hostname;
        if (host !== '127.0.0.1' && host !== 'localhost') {
          res.status(403).json({ error: 'foreign origin refused' });
          return;
        }
      }
      next();
    });

    /**
     * POST /auth - exchange the token for a cookie, ONCE, for ONE intervention.
     *
     * The token arrives in a JSON body, never in the URL and never in a query string. What goes
     * back is HttpOnly (so no script can read it, which is also why nothing here uses
     * localStorage), SameSite=Strict (so no other site can cause it to be sent), and short-lived.
     */
    app.post('/auth', (req, res) => {
      const body = req.body as { token?: unknown; interventionId?: unknown };
      const supplied = typeof body.token === 'string' ? body.token : '';
      const interventionId = typeof body.interventionId === 'string' ? body.interventionId : '';

      if (!tokensMatch(supplied, this.#token)) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      if (!this.#interventions.has(interventionId)) {
        // Same answer as a bad token. Telling the caller that an id is unknown turns this endpoint
        // into an oracle for which intervention ids exist.
        res.status(401).json({ error: 'invalid token' });
        return;
      }

      const cookie = randomBytes(32).toString('base64url');
      this.#sessions.set(cookie, {
        interventionId,
        expiresAt: this.#now() + this.#ttl,
      });

      res.setHeader(
        'Set-Cookie',
        COOKIE_NAME +
          '=' +
          cookie +
          '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
          Math.floor(this.#ttl / 1000),
      );
      res.json({ interventionId });
    });

    /**
     * Everything below needs a cookie that is scoped to the intervention being addressed.
     *
     * The scope check is the point. A valid cookie for intervention A is not authorization for
     * intervention B, so a leaked cookie is worth exactly one handoff.
     */
    const requireScopedSession = (req: Request, res: Response, next: NextFunction): void => {
      const cookie = readCookie(req, COOKIE_NAME);
      const session = cookie === undefined ? undefined : this.#sessions.get(cookie);

      if (session === undefined || session.expiresAt <= this.#now()) {
        if (cookie !== undefined) this.#sessions.delete(cookie);
        res.status(401).json({ error: 'no valid console session' });
        return;
      }
      if (req.params['id'] !== session.interventionId) {
        res.status(403).json({ error: 'this session is scoped to a different intervention' });
        return;
      }
      next();
    };

    // NOTE THE ABSENCE. There is no `GET /interventions`. Enumeration is the attack, and a per-run
    // token must not become a directory of every run in flight.
    //
    // There is also no `GET /intervention/:id` any more. PHASE 7 had one here as a placeholder, and
    // PHASE 8 added the real page at INTERVENTION_PATH without removing it - so two routes existed
    // for one thing, the banner pointed at the older one, and opening the URL a person was told to
    // open returned `{"error":"no valid console session"}`. The page is mounted by
    // `src/escalation/console.ts`; this file owns only the security.
    this.#requireScopedSession = requireScopedSession;
    this.app = app;
  }

  /**
   * Mount a route BEHIND the intervention-scoped session guard.
   *
   * The guard is not exported as a bare middleware anyone can forget to apply. Routes are mounted
   * through here so that "protected" is the only way to add one, rather than a convention somebody
   * has to remember at the moment they are adding a feature under time pressure.
   */
  mountScoped(
    path: string,
    method: 'get' | 'post',
    handler: (req: Request, res: Response) => void,
  ): void {
    const guard = this.#requireScopedSession;
    if (guard === undefined) throw new Error('console not initialised');
    if (method === 'get') this.app.get(path, guard, handler);
    else this.app.post(path, guard, handler);
  }

  /** Register an intervention this console will accept a session for. */
  register(interventionId: string): void {
    this.#interventions.add(interventionId);
  }

  /** Test seam, and the thing PHASE 8 will call when a handoff ends. */
  revoke(interventionId: string): void {
    this.#interventions.delete(interventionId);
    for (const [cookie, session] of this.#sessions) {
      if (session.interventionId === interventionId) this.#sessions.delete(cookie);
    }
  }

  get openSessions(): number {
    return this.#sessions.size;
  }
}

/**
 * [MUST] LOOPBACK ONLY.
 *
 * `app.listen(port)` with no host binds 0.0.0.0 and puts a console that can hand over a live
 * banking session on every interface the machine has, including the coffee-shop wifi. The host is
 * not a parameter, because a parameter is a thing somebody sets to 0.0.0.0 in a hurry.
 */
export const CONSOLE_HOST = '127.0.0.1';

/**
 * The ONE path an intervention is served at.
 *
 * A constant because it was not one. The banner built its URL from a literal here and the page was
 * mounted at a different literal in `console.ts`, which is exactly the kind of duplication that
 * looks harmless in review: both strings are correct, they are just not the same string. The result
 * was a documented manual path that could not be opened at all.
 */
export function interventionPath(interventionId: string): string {
  return '/i/' + interventionId;
}

/**
 * What the CLI prints. The URL and the token are on SEPARATE LINES so that copying the URL - into a
 * browser, a chat, a ticket - cannot carry the token with it.
 */
export function consoleBanner(port: number, token: string, interventionId: string): string {
  const nl = String.fromCharCode(10);
  return [
    'An operator is needed.',
    '',
    '  url:          http://' + CONSOLE_HOST + ':' + port + interventionPath(interventionId),
    '  token:        ' + token,
    '',
    'The page will ask for the token once. It is never part of the URL: a token in a URL leaks',
    'through browser history, the Referer header, proxy logs and screenshots.',
  ].join(nl);
}
