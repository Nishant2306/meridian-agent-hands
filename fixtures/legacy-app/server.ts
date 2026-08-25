import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { formatMoney, parseMoney } from '../../src/types/money.js';
import { createObfuscation, type Obfuscation } from './obfuscation.js';
import { findMemberById, searchMembers, type SeedMember } from './seed-data.js';
import { tenantA } from './tenants/tenant-a.js';
import type { TenantConfig } from './tenants/types.js';
import {
  NEUTRAL_SUBACCOUNT_FORM,
  renderLogin,
  renderMember,
  renderMessage,
  renderNav,
  renderReview,
  renderSearch,
  renderShell,
  renderSubAccountForm,
  renderSubmitted,
  type RenderContext,
  type SubAccountDraft,
  type SubAccountFormValues,
} from './views.js';

const SESSION_COOKIE = 'MERIDIAN_SESSIONID';

interface StoredDraft extends SubAccountDraft {
  submitted: boolean;
}

export interface LegacyAppOptions {
  readonly tenant?: TenantConfig;
  /** Per-boot obfuscation seed. Supply it to reproduce a boot; omit it to get a fresh one. */
  readonly seed?: number;
}

export interface LegacyApp {
  readonly app: Express;
  readonly tenant: TenantConfig;
  readonly seed: number;
  readonly obfuscation: Obfuscation;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

/** Read a urlencoded form field without leaking `any` out of express's request body. */
function formField(body: unknown, name: string): string {
  if (typeof body !== 'object' || body === null) return '';
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

function queryParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

export function createLegacyApp(options: LegacyAppOptions = {}): LegacyApp {
  const tenant = options.tenant ?? tenantA;
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
  const obfuscation = createObfuscation(seed);
  const ctx: RenderContext = { tenant, obf: obfuscation };

  const sessions = new Set<string>();
  /** sessionId -> memberId -> draft. In-memory only; a restart clears everything. */
  const drafts = new Map<string, Map<string, StoredDraft>>();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));

  function sessionIdOf(req: Request): string | undefined {
    const id = readCookie(req, SESSION_COOKIE);
    return id !== undefined && sessions.has(id) ? id : undefined;
  }

  function requireSession(req: Request, res: Response, next: NextFunction): void {
    if (sessionIdOf(req) === undefined) {
      res.redirect(303, '/');
      return;
    }
    next();
  }

  function draftsFor(sessionId: string): Map<string, StoredDraft> {
    const existing = drafts.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Map<string, StoredDraft>();
    drafts.set(sessionId, created);
    return created;
  }

  function withMember(
    req: Request,
    res: Response,
    handler: (member: SeedMember, sessionId: string) => void,
  ): void {
    const sessionId = sessionIdOf(req);
    if (sessionId === undefined) {
      res.redirect(303, '/');
      return;
    }
    // Express 5 types a route param as `string | string[]` to cover wildcard routes; `:id` is
    // always a single segment here, so anything else is not a member id.
    const rawId = req.params['id'];
    const member = typeof rawId === 'string' ? findMemberById(rawId) : undefined;
    if (member === undefined) {
      // A member id that is not in the data set is not an application error; the app simply has no
      // such record. The AUTOMATION's interpretation of that (MEMBER_NOT_FOUND, a business outcome)
      // is decided upstream, not here.
      res.status(404).send(renderMessage(ctx, 'Member Not Found', 'No member found for that ID.'));
      return;
    }
    handler(member, sessionId);
  }

  // -- sign on -----------------------------------------------------------------------------------

  app.get('/', (_req, res) => {
    res.type('html').send(renderLogin(ctx));
  });

  app.post('/login', (req, res) => {
    const operator = formField(req.body, 'ctl00$Main$txtOperator').trim();
    const passcode = formField(req.body, 'ctl00$Main$txtPasscode').trim();

    // The fixture accepts ANY non-empty credential pair. No credential is stored in this repository
    // and none is checked, so there is nothing here that could ever become a secret.
    if (operator === '' || passcode === '') {
      res
        .status(200)
        .type('html')
        .send(renderLogin(ctx, { error: 'Operator ID and passcode are required.' }));
      return;
    }

    const sessionId = randomUUID();
    sessions.add(sessionId);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
    res.redirect(303, '/app');
  });

  // -- shell and navigation ----------------------------------------------------------------------

  app.get('/app', requireSession, (_req, res) => {
    res.type('html').send(renderShell(ctx));
  });

  app.get('/nav', requireSession, (_req, res) => {
    res.type('html').send(renderNav(ctx));
  });

  // -- member search -----------------------------------------------------------------------------

  app.get('/search', requireSession, (req, res) => {
    // The form field carries the legacy-stable ASP name, so submitting it produces
    // /search?ctl00%24Main%24txtMemberId=10001. The short `q` alias is also accepted, because a
    // deep link of the form /search?q=10001 is part of this app's documented surface.
    const query = queryParam(req, 'ctl00$Main$txtMemberId') ?? queryParam(req, 'q');
    if (query === undefined) {
      res.type('html').send(renderSearch(ctx, { query: '', searched: false, results: [] }));
      return;
    }
    res
      .type('html')
      .send(renderSearch(ctx, { query, searched: true, results: searchMembers(query) }));
  });

  // -- member record -----------------------------------------------------------------------------

  app.get('/member/:id', requireSession, (req, res) => {
    withMember(req, res, (member) => {
      res.type('html').send(renderMember(ctx, member));
    });
  });

  // -- new sub-account ---------------------------------------------------------------------------

  app.get('/member/:id/subaccount/new', requireSession, (req, res) => {
    withMember(req, res, (member) => {
      // [MUST] Clarification 3: NEUTRAL initial state. Nothing pre-selected, nothing pre-filled.
      res.type('html').send(renderSubAccountForm(ctx, member, { values: NEUTRAL_SUBACCOUNT_FORM }));
    });
  });

  app.post('/member/:id/subaccount/new', requireSession, (req, res) => {
    withMember(req, res, (member, sessionId) => {
      const values: SubAccountFormValues = {
        accountType: formField(req.body, 'ctl00$Main$ddlAccountType'),
        nickname: formField(req.body, 'ctl00$Main$txtNickname'),
        initialDeposit: formField(req.body, 'ctl00$Main$txtInitialDeposit'),
      };

      const reject = (message: string): void => {
        res
          .status(200)
          .type('html')
          .send(renderSubAccountForm(ctx, member, { values, error: message }));
      };

      if (!tenant.accountTypes.includes(values.accountType)) {
        reject('You must select an account type.');
        return;
      }

      const deposit = parseMoney(values.initialDeposit);
      if (deposit === null) {
        reject('Initial deposit must be an amount, for example 250.00.');
        return;
      }
      if (deposit.minorUnits < tenant.minimumDepositMinorUnits) {
        reject(
          `Initial deposit must be at least ${formatMoney({
            currency: 'USD',
            minorUnits: tenant.minimumDepositMinorUnits,
          })}.`,
        );
        return;
      }
      if (values.nickname.trim().length > 40) {
        reject('Nickname must be 40 characters or fewer.');
        return;
      }

      draftsFor(sessionId).set(member.id, {
        accountType: values.accountType,
        nickname: values.nickname.trim(),
        initialDepositMinorUnits: deposit.minorUnits,
        submitted: false,
      });

      res.redirect(303, `/member/${encodeURIComponent(member.id)}/subaccount/review`);
    });
  });

  // -- review ------------------------------------------------------------------------------------

  app.get('/member/:id/subaccount/review', requireSession, (req, res) => {
    withMember(req, res, (member, sessionId) => {
      const draft = draftsFor(sessionId).get(member.id);
      if (draft === undefined) {
        res.redirect(303, `/member/${encodeURIComponent(member.id)}/subaccount/new`);
        return;
      }
      res.type('html').send(renderReview(ctx, member, draft));
    });
  });

  /**
   * The irreversible one.
   *
   * This route really does mutate state. It exists so that the guardrails have something real to
   * guard: a "Submit Request" button wired to a no-op would make every safety claim in this project
   * unfalsifiable. Nothing in the automation is permitted to reach it.
   */
  app.post('/member/:id/subaccount/submit', requireSession, (req, res) => {
    withMember(req, res, (member, sessionId) => {
      const memberDrafts = draftsFor(sessionId);
      const draft = memberDrafts.get(member.id);
      if (draft === undefined) {
        res.redirect(303, `/member/${encodeURIComponent(member.id)}/subaccount/new`);
        return;
      }
      memberDrafts.set(member.id, { ...draft, submitted: true });
      res.type('html').send(renderSubmitted(ctx, member));
    });
  });

  // -- test hooks --------------------------------------------------------------------------------

  /**
   * Exposes the per-boot obfuscation seed. PHASE 10 uses this to EVIDENCE the restart claim:
   * two boots, two seeds, two sets of class names, one unchanged capability.
   */
  app.get('/__test__/seed', (_req, res) => {
    res.json({ seed, tenant: tenant.id, versionMarker: tenant.versionMarker });
  });

  return { app, tenant, seed, obfuscation };
}
