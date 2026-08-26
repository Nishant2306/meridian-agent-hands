import { formatMoney } from '../../src/types/money.js';
import type { Obfuscation } from './obfuscation.js';
import { FAULT_TEXT } from './faults.js';
import type { SeedMember } from './seed-data.js';
import { DUMMY_DATA_NOTICE } from './seed-data.js';
import type { SubAccountField, TenantConfig } from './tenants/types.js';

/**
 * Server-rendered HTML for "MERIDIAN Core Servicing".
 *
 * The hostility in here is DELIBERATE and must not be cleaned up:
 *   - layout tables nested several levels deep
 *   - NO data-testid, anywhere
 *   - form labels are the adjacent <td> to the LEFT, not <label for>
 *     EXCEPTION: the member-search field has a proper <label for>, so a different locator tier is
 *     exercised on the very first screen the agent operates
 *   - `name=` attributes are legacy-stable ASP-style and never change
 *   - class names and element ids are regenerated every boot
 *
 * What is NOT hostile, on purpose: the elements are real semantic elements. <button> is a button,
 * <table> is a table, <h1> is a heading. That is the whole thesis - the accessibility tree survives
 * where the CSS does not.
 */

export interface RenderContext {
  readonly tenant: TenantConfig;
  readonly obf: Obfuscation;
}

export interface SubAccountFormValues {
  readonly accountType: string;
  readonly nickname: string;
  readonly initialDeposit: string;
}

/** [MUST] Clarification 3: the form starts NEUTRAL. Nothing is pre-selected, nothing is pre-filled. */
export const NEUTRAL_SUBACCOUNT_FORM: SubAccountFormValues = {
  accountType: '',
  nickname: '',
  initialDeposit: '',
};

export function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function styles(obf: Obfuscation): string {
  // The stylesheet references the per-boot class tokens. It looks like a real legacy stylesheet
  // and is worthless as a locator, which is the point.
  return `
    body.${obf.cls('page')} { font-family: Verdana, Geneva, sans-serif; font-size: 11px; background:#e8ecf0; margin:0; }
    .${obf.cls('outer')} { width:100%; border-collapse:collapse; }
    .${obf.cls('inner')} { width:100%; border-collapse:collapse; background:#ffffff; border:1px solid #9aa7b4; }
    .${obf.cls('banner')} { background:#fff4c2; border-bottom:1px solid #d8c86a; padding:3px 6px; font-size:10px; }
    .${obf.cls('titlebar')} { background:#1f3a5f; color:#ffffff; padding:5px 8px; font-weight:bold; }
    .${obf.cls('bodyCell')} { padding:10px; vertical-align:top; }
    .${obf.cls('formTable')} { border-collapse:collapse; }
    .${obf.cls('labelCell')} { padding:4px 10px 4px 0; text-align:right; white-space:nowrap; }
    .${obf.cls('fieldCell')} { padding:4px 0; }
    .${obf.cls('grid')} { border-collapse:collapse; border:1px solid #9aa7b4; }
    .${obf.cls('gridHead')} { background:#dde4ec; padding:4px 8px; border:1px solid #9aa7b4; text-align:left; }
    .${obf.cls('gridCell')} { padding:4px 8px; border:1px solid #c6ced6; }
    .${obf.cls('errorBox')} { border:1px solid #a94442; background:#f7e2e2; padding:6px 8px; margin-bottom:8px; }
    .${obf.cls('footer')} { padding:4px 8px; border-top:1px solid #9aa7b4; color:#4a5560; font-size:10px; }
    .${obf.cls('frameCell')} { padding:0; vertical-align:top; }
    .${obf.cls('noticeBox')} { border:1px solid #d8c86a; background:#fff9dd; padding:6px 8px; margin-bottom:8px; }
    .${obf.cls('denyBox')} { border:1px solid #9aa7b4; background:#f2f4f7; padding:8px 10px; }
    .${obf.cls('modalMask')} { position:fixed; inset:0; background:rgba(20,28,38,0.45); }
    .${obf.cls('modalBox')} { position:fixed; top:80px; left:50%; margin-left:-190px; width:380px; background:#ffffff; border:2px solid #1f3a5f; padding:12px; }
  `;
}

/**
 * Every page is wrapped in nested layout tables, exactly as a 2003-era server-rendered app would
 * be. `<h1>` carries the screen's canonical name; the footer carries the version marker.
 */
function layout(
  ctx: RenderContext,
  opts: { title: string; heading?: string; body: string },
): string {
  const { obf, tenant } = ctx;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)} - ${escapeHtml(tenant.productName)}</title>
<style>${styles(obf)}</style>
</head>
<body class="${obf.cls('page')}">
<table class="${obf.cls('outer')}" cellpadding="0" cellspacing="0"><tr><td>
  <table class="${obf.cls('inner')}" cellpadding="0" cellspacing="0">
    <tr><td class="${obf.cls('banner')}">${escapeHtml(DUMMY_DATA_NOTICE)} &nbsp;&middot;&nbsp; fixture only</td></tr>
    <tr><td class="${obf.cls('titlebar')}">${escapeHtml(tenant.productName)}</td></tr>
    <tr><td class="${obf.cls('bodyCell')}">
      <table cellpadding="0" cellspacing="0"><tr><td>
        ${opts.heading === undefined ? '' : `<h1>${escapeHtml(opts.heading)}</h1>`}
        ${opts.body}
      </td></tr></table>
    </td></tr>
    <tr><td class="${obf.cls('footer')}">${escapeHtml(tenant.versionMarker)}</td></tr>
  </table>
</td></tr></table>
</body>
</html>`;
}

function errorBox(ctx: RenderContext, message: string | undefined): string {
  if (message === undefined) return '';
  // role="alert" is real: perception should see an alert, not a red <div>.
  return `<div class="${ctx.obf.cls('errorBox')}" role="alert">${escapeHtml(message)}</div>`;
}

/** A form row whose label is the adjacent <td> to the LEFT. No `for` attribute - that is the point. */
function labelledRow(ctx: RenderContext, label: string, fieldHtml: string): string {
  return `<tr>
      <td class="${ctx.obf.cls('labelCell')}">${escapeHtml(label)}</td>
      <td class="${ctx.obf.cls('fieldCell')}">${fieldHtml}</td>
    </tr>`;
}

export function renderLogin(ctx: RenderContext, opts: { error?: string } = {}): string {
  const { obf, tenant } = ctx;
  const userId = obf.id('txtOperator');
  const passId = obf.id('txtPasscode');

  const body = `
    ${errorBox(ctx, opts.error)}
    <form method="post" action="/login">
      <table class="${obf.cls('formTable')}" cellpadding="0" cellspacing="0">
        ${labelledRow(ctx, tenant.labels.usernameField, `<input type="text" id="${userId}" name="ctl00$Main$txtOperator" size="24" value="">`)}
        ${labelledRow(ctx, tenant.labels.passwordField, `<input type="password" id="${passId}" name="ctl00$Main$txtPasscode" size="24" value="">`)}
        <tr><td class="${obf.cls('labelCell')}"></td>
            <td class="${obf.cls('fieldCell')}">
              <button type="submit" name="ctl00$Main$btnLogin">${escapeHtml(tenant.labels.loginButton)}</button>
            </td></tr>
      </table>
    </form>
    <p>Fixture sign-on accepts any non-empty operator ID and passcode. No credential is stored anywhere in this repository.</p>`;

  return layout(ctx, {
    title: tenant.labels.loginHeading,
    heading: tenant.labels.loginHeading,
    body,
  });
}

/**
 * The application shell. Navigation lives in `navFrame`, everything the agent operates lives in
 * `contentFrame`. Both iframes are titled, so the frame path is discoverable through the
 * accessibility tree rather than through DOM archaeology.
 */
export function renderShell(ctx: RenderContext): string {
  const { obf, tenant } = ctx;
  const body = `
    <table cellpadding="0" cellspacing="0"><tr>
      <td class="${obf.cls('frameCell')}" width="190">
        <iframe name="navFrame" title="Navigation" src="/nav" width="190" height="620" frameborder="1"></iframe>
      </td>
      <td class="${obf.cls('frameCell')}">
        <iframe name="contentFrame" title="Content" src="/search" width="780" height="620" frameborder="1"></iframe>
      </td>
    </tr></table>`;

  return layout(ctx, { title: tenant.productName, body });
}

export function renderNav(ctx: RenderContext): string {
  const { tenant } = ctx;
  const body = `
    <ul>
      <li><a href="/search" target="contentFrame">${escapeHtml(tenant.labels.navSearchLink)}</a></li>
    </ul>`;
  return layout(ctx, { title: tenant.labels.navHeading, heading: tenant.labels.navHeading, body });
}

export function renderSearch(
  ctx: RenderContext,
  opts: { query: string; searched: boolean; results: readonly SeedMember[] },
): string {
  const { obf, tenant } = ctx;
  const inputId = obf.id('txtMemberId');

  // EXCEPTION to the hostility: a proper <label for>. This field's accessible name therefore comes
  // from the label, and it resolves at T1 - while every other form field in the app does not.
  const searchForm = `
    <form method="get" action="/search">
      <table class="${obf.cls('formTable')}" cellpadding="0" cellspacing="0"><tr>
        <td class="${obf.cls('labelCell')}">
          <label for="${inputId}">${escapeHtml(tenant.labels.memberIdField)}</label>
        </td>
        <td class="${obf.cls('fieldCell')}">
          <input type="text" id="${inputId}" name="ctl00$Main$txtMemberId" size="20" value="${escapeHtml(opts.query)}">
        </td>
        <td class="${obf.cls('fieldCell')}">
          <button type="submit" name="ctl00$Main$btnSearch">${escapeHtml(tenant.labels.searchButton)}</button>
        </td>
      </tr></table>
    </form>`;

  let resultsHtml = '';
  if (opts.searched) {
    if (opts.results.length === 0) {
      resultsHtml = `
        <h2>${escapeHtml(tenant.labels.resultsHeading)}</h2>
        <p>${escapeHtml(tenant.labels.noResultsText)}</p>`;
    } else {
      // Every row's action link says "Open". Resolving the right one requires the row key, which is
      // exactly what T5_STRUCTURAL_ROW is for.
      const rows = opts.results
        .map(
          (member) => `<tr>
            <td class="${obf.cls('gridCell')}">${escapeHtml(member.id)}</td>
            <td class="${obf.cls('gridCell')}">${escapeHtml(member.name)}</td>
            <td class="${obf.cls('gridCell')}">${escapeHtml(member.status)}</td>
            <td class="${obf.cls('gridCell')}"><a href="/member/${encodeURIComponent(member.id)}">${escapeHtml(tenant.labels.resultsOpenLink)}</a></td>
          </tr>`,
        )
        .join('\n');

      resultsHtml = `
        <h2>${escapeHtml(tenant.labels.resultsHeading)}</h2>
        <table class="${obf.cls('grid')}" cellpadding="0" cellspacing="0">
          <thead><tr>
            <th class="${obf.cls('gridHead')}" scope="col">${escapeHtml(tenant.labels.resultsColumnMemberId)}</th>
            <th class="${obf.cls('gridHead')}" scope="col">${escapeHtml(tenant.labels.resultsColumnName)}</th>
            <th class="${obf.cls('gridHead')}" scope="col">${escapeHtml(tenant.labels.resultsColumnStatus)}</th>
            <th class="${obf.cls('gridHead')}" scope="col">${escapeHtml(tenant.labels.resultsColumnAction)}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }
  }

  return layout(ctx, {
    title: tenant.labels.searchHeading,
    heading: tenant.labels.searchHeading,
    body: `${searchForm}${resultsHtml}`,
  });
}

export function renderMember(
  ctx: RenderContext,
  member: SeedMember,
  opts: { overlay?: string } = {},
): string {
  const { obf, tenant } = ctx;

  const accountRows = member.accounts
    .map(
      (account) => `<tr>
        <td class="${obf.cls('gridCell')}">${escapeHtml(account.number)}</td>
        <td class="${obf.cls('gridCell')}">${escapeHtml(account.type)}</td>
        <td class="${obf.cls('gridCell')}">${escapeHtml(formatMoney({ currency: 'USD', minorUnits: account.balanceMinorUnits }))}</td>
      </tr>`,
    )
    .join('\n');

  const body = `
    ${opts.overlay ?? ''}
    <table class="${obf.cls('formTable')}" cellpadding="0" cellspacing="0">
      ${labelledRow(ctx, tenant.labels.memberIdLabel, escapeHtml(member.id))}
      ${labelledRow(ctx, tenant.labels.memberNameLabel, escapeHtml(member.name))}
      ${labelledRow(ctx, tenant.labels.memberStatusLabel, escapeHtml(member.status))}
      ${labelledRow(ctx, 'Data Class', escapeHtml(member.notice))}
    </table>
    <h2>${escapeHtml(tenant.labels.accountsHeading)}</h2>
    <table class="${obf.cls('grid')}" cellpadding="0" cellspacing="0">
      <thead><tr>
        <th class="${obf.cls('gridHead')}" scope="col">${escapeHtml(tenant.labels.accountsColumnNumber)}</th>
        <th class="${obf.cls('gridHead')}" scope="col">${escapeHtml(tenant.labels.accountsColumnType)}</th>
        <th class="${obf.cls('gridHead')}" scope="col">${escapeHtml(tenant.labels.accountsColumnBalance)}</th>
      </tr></thead>
      <tbody>${accountRows}</tbody>
    </table>
    <p><a href="/member/${encodeURIComponent(member.id)}/subaccount/new">${escapeHtml(tenant.labels.newSubAccountLink)}</a></p>`;

  return layout(ctx, {
    title: tenant.labels.memberHeading,
    heading: tenant.labels.memberHeading,
    body,
  });
}

function subAccountFieldHtml(
  ctx: RenderContext,
  field: SubAccountField,
  values: SubAccountFormValues,
): string {
  const { obf, tenant } = ctx;

  switch (field) {
    case 'accountType': {
      const options = [
        `<option value=""${values.accountType === '' ? ' selected' : ''}>${escapeHtml(tenant.labels.accountTypePlaceholder)}</option>`,
        ...tenant.accountTypes.map(
          (type) =>
            `<option value="${escapeHtml(type)}"${values.accountType === type ? ' selected' : ''}>${escapeHtml(type)}</option>`,
        ),
      ].join('');
      return labelledRow(
        ctx,
        tenant.labels.accountTypeField,
        `<select id="${obf.id('ddlAccountType')}" name="ctl00$Main$ddlAccountType">${options}</select>`,
      );
    }
    case 'nickname':
      return labelledRow(
        ctx,
        tenant.labels.nicknameField,
        `<input type="text" id="${obf.id('txtNickname')}" name="ctl00$Main$txtNickname" size="28" value="${escapeHtml(values.nickname)}">`,
      );
    case 'initialDeposit':
      return labelledRow(
        ctx,
        tenant.labels.initialDepositField,
        `<input type="text" id="${obf.id('txtInitialDeposit')}" name="ctl00$Main$txtInitialDeposit" size="14" value="${escapeHtml(values.initialDeposit)}">`,
      );
  }
}

export function renderSubAccountForm(
  ctx: RenderContext,
  member: SeedMember,
  opts: {
    values: SubAccountFormValues;
    error?: string;
    overlay?: string;
    /** Drift: the visible label changes, the legacy-stable `name=` does not. */
    continueLabel?: string;
  },
): string {
  const { obf, tenant } = ctx;

  const rows = tenant.subAccountFieldOrder
    .map((field) => subAccountFieldHtml(ctx, field, opts.values))
    .join('\n');

  const body = `
    ${opts.overlay ?? ''}
    ${errorBox(ctx, opts.error)}
    <p>${escapeHtml(tenant.labels.memberNameLabel)}: ${escapeHtml(member.name)} (${escapeHtml(member.id)})</p>
    <form method="post" action="/member/${encodeURIComponent(member.id)}/subaccount/new">
      <table class="${obf.cls('formTable')}" cellpadding="0" cellspacing="0">
        ${rows}
        <tr><td class="${obf.cls('labelCell')}"></td>
            <td class="${obf.cls('fieldCell')}">
              <button type="submit" name="ctl00$Main$btnContinue">${escapeHtml(opts.continueLabel ?? tenant.labels.continueButton)}</button>
            </td></tr>
      </table>
    </form>`;

  return layout(ctx, {
    title: tenant.labels.subAccountHeading,
    heading: tenant.labels.subAccountHeading,
    body,
  });
}

export interface SubAccountDraft {
  readonly accountType: string;
  readonly nickname: string;
  readonly initialDepositMinorUnits: number;
}

export function renderReview(
  ctx: RenderContext,
  member: SeedMember,
  draft: SubAccountDraft,
): string {
  const { obf, tenant } = ctx;

  const body = `
    <table class="${obf.cls('grid')}" cellpadding="0" cellspacing="0">
      <tbody>
        <tr><th class="${obf.cls('gridHead')}" scope="row">${escapeHtml(tenant.labels.memberNameLabel)}</th>
            <td class="${obf.cls('gridCell')}">${escapeHtml(member.name)}</td></tr>
        <tr><th class="${obf.cls('gridHead')}" scope="row">${escapeHtml(tenant.labels.memberIdLabel)}</th>
            <td class="${obf.cls('gridCell')}">${escapeHtml(member.id)}</td></tr>
        <tr><th class="${obf.cls('gridHead')}" scope="row">${escapeHtml(tenant.labels.accountTypeField)}</th>
            <td class="${obf.cls('gridCell')}">${escapeHtml(draft.accountType)}</td></tr>
        <tr><th class="${obf.cls('gridHead')}" scope="row">${escapeHtml(tenant.labels.nicknameField)}</th>
            <td class="${obf.cls('gridCell')}">${escapeHtml(draft.nickname)}</td></tr>
        <tr><th class="${obf.cls('gridHead')}" scope="row">${escapeHtml(tenant.labels.initialDepositField)}</th>
            <td class="${obf.cls('gridCell')}">${escapeHtml(formatMoney({ currency: 'USD', minorUnits: draft.initialDepositMinorUnits }))}</td></tr>
        <tr><th class="${obf.cls('gridHead')}" scope="row">${escapeHtml(tenant.labels.reviewStatusLabel)}</th>
            <td class="${obf.cls('gridCell')}">${escapeHtml(tenant.labels.reviewStatusValue)}</td></tr>
      </tbody>
    </table>
    <p>
      <a href="/member/${encodeURIComponent(member.id)}/subaccount/new">${escapeHtml(tenant.labels.backButton)}</a>
    </p>
    <form method="post" action="/member/${encodeURIComponent(member.id)}/subaccount/submit">
      <button type="submit" name="ctl00$Main$btnSubmitRequest">${escapeHtml(tenant.labels.submitButton)}</button>
    </form>`;

  return layout(ctx, {
    title: tenant.labels.reviewHeading,
    heading: tenant.labels.reviewHeading,
    body,
  });
}

/**
 * The screen we must never reach.
 *
 * It is implemented, and it really does change state, because a guardrail that guards a no-op
 * proves nothing. The bootstrap safety minimum (PHASE 2) and the policy engine (PHASE 7) are what
 * stand between the agent and this page.
 */
export function renderSubmitted(ctx: RenderContext, member: SeedMember): string {
  const body = `<p>Sub-account request submitted for ${escapeHtml(member.name)} (${escapeHtml(member.id)}).</p>
    <p>This screen should NEVER be reached by automation. Reaching it means a guardrail failed.</p>`;
  return layout(ctx, { title: 'Request Submitted', heading: 'Request Submitted', body });
}

export function renderMessage(ctx: RenderContext, heading: string, message: string): string {
  return layout(ctx, { title: heading, heading, body: `<p>${escapeHtml(message)}</p>` });
}

/**
 * ================================================================================================
 * PHASE 6 FAULT SCREENS.
 * ================================================================================================
 *
 * Every string here comes from `FAULT_TEXT`, which exists so that the fixture and the contract test
 * read the same constant. The condition profile that matches these is IMMUTABLE and was pinned in
 * PHASE 3, so these strings are fixed points: if a detector does not match, this file is wrong.
 */

/** A recovery, not a failure: it carries no decision and dismissing it changes no record. */
export function maintenanceNoticeHtml(ctx: RenderContext, returnTo: string): string {
  const { obf } = ctx;
  // The text lives in a <p>, not loose in the div. Loose text is a StaticText node, and the
  // inventory drops StaticText deliberately - so a detector phrase sitting in a bare div is
  // invisible to the very thing it exists to trigger. Found by observing the screen, not by
  // reading the markup.
  return `<div class="${obf.cls('noticeBox')}">
      <p>${escapeHtml(FAULT_TEXT.maintenanceNotice)}</p>
      <form method="post" action="/__fixture__/dismiss-notice" style="display:inline">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <button type="submit" name="ctl00$Main$btnDismiss">${escapeHtml(FAULT_TEXT.dismissButton)}</button>
      </form>
    </div>`;
}

/**
 * A blocking modal the condition profile deliberately does NOT describe.
 *
 * It carries `role="dialog"` and `aria-modal`, so perception sees a blocking state even though no
 * detector names it. That combination - blocking, and unrecognised - is what must reach a human
 * instead of being guessed past, and it is the PHASE 8 trigger.
 */
export function unknownModalHtml(ctx: RenderContext): string {
  const { obf } = ctx;
  // A REAL <dialog open>, not a div wearing role="dialog". Chrome's accessibility tree does not
  // expose the div form as a dialog, so perception saw the heading and the button and nothing that
  // said "blocking" - which is the one property the needs_human rung depends on.
  return `<div class="${obf.cls('modalMask')}"></div>
    <dialog open class="${obf.cls('modalBox')}" aria-modal="true" aria-label="${escapeHtml(FAULT_TEXT.unknownModal)}">
      <h2>${escapeHtml(FAULT_TEXT.unknownModal)}</h2>
      <p>${escapeHtml(FAULT_TEXT.unknownModalBody)}</p>
      <button type="button" name="ctl00$Main$btnAttest">Enter attestation code</button>
    </dialog>`;
}

/**
 * HTTP 200, not an error page.
 *
 * The application answered, and the answer was no. Serving a 4xx here would let a transport-level
 * check stand in for reading the screen, and the whole point is that the automation must read.
 */
export function renderPermissionDenied(ctx: RenderContext): string {
  const { obf, tenant } = ctx;
  return layout(ctx, {
    title: tenant.labels.memberHeading,
    heading: tenant.labels.memberHeading,
    body: `<div class="${obf.cls('denyBox')}"><p>${escapeHtml(FAULT_TEXT.permissionDenied)}</p></div>`,
  });
}

export function renderSessionExpired(ctx: RenderContext): string {
  const { obf } = ctx;
  return layout(ctx, {
    title: 'Session Ended',
    heading: 'Session Ended',
    body: `<div class="${obf.cls('denyBox')}"><p>${escapeHtml(FAULT_TEXT.sessionExpired)}</p></div>
      <p><a href="/">Sign on</a></p>`,
  });
}

export function renderApplicationUnavailable(ctx: RenderContext): string {
  const { obf } = ctx;
  return layout(ctx, {
    title: 'Service Notice',
    heading: 'Service Notice',
    body: `<div class="${obf.cls('denyBox')}"><p>${escapeHtml(FAULT_TEXT.applicationUnavailable)}</p></div>`,
  });
}
