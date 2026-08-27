import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { formatMoney, parseMoney } from '../../src/types/money.js';
import {
  FAULT_SESSION_HEADER,
  FaultStore,
  mergeFaults,
  seededFaultsFor,
  type FaultFlags,
} from './faults.js';
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
  renderApplicationUnavailable,
  renderPermissionDenied,
  renderSessionExpired,
  renderSubmitted,
  maintenanceNoticeHtml,
  unknownModalHtml,
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
  /** Per-session fault flags. Exposed so a test can arm faults without an HTTP round trip. */
  readonly faults: FaultStore;
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

function boolFlag(body: unknown, name: string): Record<string, boolean> {
  const raw = (body as Record<string, unknown> | null)?.[name];
  // A urlencoded post sends "true"; a JSON post sends true. Both are the same intent.
  if (raw === true || raw === 'true') return { [name]: true };
  return {};
}

function numberFlag(body: unknown, name: string): Record<string, number> {
  const raw = (body as Record<string, unknown> | null)?.[name];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? { [name]: value } : {};
}

function stringFlag(body: unknown, name: string): Record<string, string> {
  const raw = (body as Record<string, unknown> | null)?.[name];
  return typeof raw === 'string' && raw !== '' ? { [name]: raw } : {};
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
  const faults = new FaultStore();
  /** Sessions that have dismissed the maintenance notice. Dismissal is per session, like the fault. */
  const dismissedNotice = new Set<string>();
  /** Sessions that have completed the attestation. Overrides the modal from EITHER source. */
  const attested = new Set<string>();
  /** sessionId -> memberId -> draft. In-memory only; a restart clears everything. */
  const drafts = new Map<string, Map<string, StoredDraft>>();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

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

  /** The key a request's faults are stored under. Header first: see faults.ts. */
  function faultKeys(req: Request): { header?: string; cookie?: string } {
    const header = req.headers[FAULT_SESSION_HEADER];
    const cookie = readCookie(req, SESSION_COOKIE);
    return {
      ...(typeof header === 'string' ? { header } : {}),
      ...(cookie === undefined ? {} : { cookie }),
    };
  }

  function faultsFor(req: Request, member?: SeedMember): FaultFlags {
    const session = faults.for(faultKeys(req));
    const seeded = member === undefined ? {} : seededFaultsFor(member.flags);
    return mergeFaults(session, seeded);
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Faults that apply to ANY servicing screen, checked before the route does its own work.
   *
   * Returns true when it has answered the request. The ordering here mirrors what a real system
   * does: a dead session is discovered before anything is fetched, and an unavailable application
   * answers before it looks anything up.
   */
  async function handledByGlobalFault(req: Request, res: Response): Promise<boolean> {
    const flags = faultsFor(req);

    if (flags.slowLoadMs !== undefined && flags.slowLoadMs > 0) await delay(flags.slowLoadMs);

    if (flags.expireSession === true) {
      // HTTP 200 and a readable screen. A 401 would let a transport check stand in for reading.
      res.status(200).type('html').send(renderSessionExpired(ctx));
      return true;
    }

    if (flags.http500OnRoute !== undefined && flags.http500OnRoute === req.path) {
      // A 5xx that still renders a page, because that is what these applications actually do.
      res.status(500).type('html').send(renderApplicationUnavailable(ctx));
      return true;
    }

    return false;
  }

  /** The overlay a screen should carry, if any. The unknown modal wins: it is BLOCKING. */
  function overlayFor(req: Request, member: SeedMember, returnTo: string): string {
    const flags = faultsFor(req, member);
    const sessionId = readCookie(req, SESSION_COOKIE);
    const hasAttested = sessionId !== undefined && attested.has(sessionId);
    if (flags.showUnknownModal === true && !hasAttested) return unknownModalHtml(ctx, returnTo);

    const dismissed = sessionId !== undefined && dismissedNotice.has(sessionId);
    if (flags.showKnownNotice === true && !dismissed) return maintenanceNoticeHtml(ctx, returnTo);

    return '';
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

  app.get('/search', requireSession, async (req, res) => {
    if (await handledByGlobalFault(req, res)) return;
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

  app.get('/member/:id', requireSession, async (req, res) => {
    if (await handledByGlobalFault(req, res)) return;
    withMember(req, res, (member) => {
      // Member 10003 is flagged `restricted` in the seed data, so this needs nothing armed. A
      // seeded member is a more honest subject than a flag: the caller asks about a member they
      // are not entitled to see, and the application says so.
      if (faultsFor(req, member).denyPermission === true) {
        res.status(200).type('html').send(renderPermissionDenied(ctx));
        return;
      }
      const overlay = overlayFor(req, member, '/member/' + encodeURIComponent(member.id));
      res.type('html').send(renderMember(ctx, member, { overlay }));
    });
  });

  // -- new sub-account ---------------------------------------------------------------------------

  app.get('/member/:id/subaccount/new', requireSession, async (req, res) => {
    if (await handledByGlobalFault(req, res)) return;
    withMember(req, res, (member) => {
      if (faultsFor(req, member).denyPermission === true) {
        res.status(200).type('html').send(renderPermissionDenied(ctx));
        return;
      }
      // The maintenance notice lands HERE, on the screen the "New Sub-Account" click navigates to.
      // That is what makes its continuation `recheck_expected_effect` rather than `retry_action`:
      // the click already worked, and repeating it would navigate a second time from a screen
      // whose link is no longer on it.
      const overlay = overlayFor(
        req,
        member,
        '/member/' + encodeURIComponent(member.id) + '/subaccount/new',
      );
      // [MUST] Clarification 3: NEUTRAL initial state. Nothing pre-selected, nothing pre-filled.
      const relabel = faultsFor(req, member).relabelContinueButton;
      res.type('html').send(
        renderSubAccountForm(ctx, member, {
          values: NEUTRAL_SUBACCOUNT_FORM,
          overlay,
          ...(relabel === undefined ? {} : { continueLabel: relabel }),
        }),
      );
    });
  });

  app.post('/member/:id/subaccount/new', requireSession, async (req, res) => {
    if (await handledByGlobalFault(req, res)) return;
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

      // NOTE THE NAME: validationErrorOnContinue. The capability stops at review and never
      // submits, so a submit-time error would be unreachable by anything this system does. This
      // fires on form -> review, which is a transition the capability actually performs.
      if (faultsFor(req, member).validationErrorOnContinue === true) {
        reject('This request could not be accepted. Please review the details and try again.');
        return;
      }

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

  app.get('/member/:id/subaccount/review', requireSession, async (req, res) => {
    if (await handledByGlobalFault(req, res)) return;
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
  /**
   * [MUST] PER SESSION, NOT SERVER-WIDE.
   *
   * The suite runs vitest files in parallel against this module. A global flag would let the file
   * testing SESSION_EXPIRED break the file testing a slow load, intermittently, and the failure
   * would move when tests were reordered.
   *
   * The key is the MERIDIAN_SESSIONID cookie, or an `X-Fault-Session` header for a caller that has
   * not signed on yet - which `expireSession` needs, since it has to be armed before the session it
   * affects is used.
   */
  app.post('/__test__/faults', (req, res) => {
    const header = req.headers[FAULT_SESSION_HEADER];
    const cookie = readCookie(req, SESSION_COOKIE);
    const key = typeof header === 'string' ? header : cookie;

    if (key === undefined) {
      res
        .status(400)
        .json({ error: 'no session: sign on first, or send an X-Fault-Session header' });
      return;
    }

    const flags: FaultFlags = {
      ...numberFlag(req.body, 'slowLoadMs'),
      ...boolFlag(req.body, 'showKnownNotice'),
      ...boolFlag(req.body, 'showUnknownModal'),
      ...boolFlag(req.body, 'expireSession'),
      ...boolFlag(req.body, 'validationErrorOnContinue'),
      ...stringFlag(req.body, 'http500OnRoute'),
      ...stringFlag(req.body, 'relabelContinueButton'),
      ...boolFlag(req.body, 'denyPermission'),
    };

    faults.set(key, flags);
    if (cookie !== undefined) {
      dismissedNotice.delete(cookie);
      attested.delete(cookie);
    }
    res.json({ session: key, flags });
  });

  app.delete('/__test__/faults', (req, res) => {
    const header = req.headers[FAULT_SESSION_HEADER];
    const cookie = readCookie(req, SESSION_COOKIE);
    for (const key of [header, cookie]) if (typeof key === 'string') faults.clear(key);
    res.json({ cleared: true });
  });

  /**
   * Dismissing the maintenance notice.
   *
   * A real "close this banner" control: it posts, the server records the dismissal for THIS
   * session, and the caller lands back where it was. Nothing about the record changes, which is
   * exactly why the profile classes it as a recovery the automation may perform unattended.
   */
  /**
   * The attestation the unrecognised modal demands.
   *
   * A PERSON can do this and the automation cannot, because no detector in the pinned profile
   * describes that modal. That asymmetry is deliberate: it is what makes the handoff demo real
   * rather than a dead end where the human is shown a wall and asked to admire it.
   */
  app.post('/__fixture__/attest', requireSession, (req, res) => {
    const sessionId = readCookie(req, SESSION_COOKIE);
    const code = formField(req.body, 'ctl00$Main$txtAttest').trim();
    const returnTo = formField(req.body, 'returnTo');

    // ANY non-empty code is accepted, and the code is printed in the modal. The thing being
    // demonstrated is the handoff, not a puzzle: a demo that needs knowledge a reviewer does not
    // have is a demo a reviewer cannot run.
    if (code === '') {
      res
        .status(200)
        .type('html')
        .send(renderMessage(ctx, 'Attestation', 'Enter the code shown.'));
      return;
    }

    // [MUST] RECORDED AS ITS OWN FACT, not by clearing a fault flag.
    //
    // The first version deleted `showUnknownModal` from the SESSION fault store. For member 20001
    // that flag lives in the SEED DATA, so the delete removed something that was never there, the
    // next render read the seeded flag again, and the modal never went away - the handoff demo
    // could be started and never finished. "This session has attested" is the actual domain fact,
    // and it overrides both sources.
    if (sessionId !== undefined) attested.add(sessionId);

    res.redirect(303, returnTo === '' ? '/app' : returnTo);
  });

  app.post('/__fixture__/dismiss-notice', requireSession, (req, res) => {
    const sessionId = readCookie(req, SESSION_COOKIE);
    if (sessionId !== undefined) dismissedNotice.add(sessionId);
    const returnTo = formField(req.body, 'returnTo');
    res.redirect(303, returnTo === '' ? '/app' : returnTo);
  });

  app.get('/__test__/seed', (_req, res) => {
    res.json({ seed, tenant: tenant.id, versionMarker: tenant.versionMarker });
  });

  return { app, tenant, seed, obfuscation, faults };
}
