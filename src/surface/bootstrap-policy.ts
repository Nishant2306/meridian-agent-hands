import type { SurfaceAction, SurfaceActionType } from '../types/action.js';
import type { ErrorCode } from '../types/outcomes.js';
import type { PerceivedControl } from '../types/perception.js';
import type { TextMatcher } from '../types/values.js';

/**
 * ==============================================================================================
 * [MUST] CLARIFICATION 5. THE BOOTSTRAP SAFETY MINIMUM.
 * ==============================================================================================
 *
 * GATE 1 ran a real model against a live UI at the end of PHASE 5. The configurable policy engine
 * did not arrive until PHASE 7. Between those two points there was a window in which a real model
 * drove a real browser with no policy engine in existence, and the ONLY thing standing between it
 * and the "Submit Request" button would otherwise have been the wording of a prompt.
 *
 * A prompt is not a control. So from PHASE 2 onward the input path enforces a hardcoded minimum
 * that cannot be configured off:
 *
 *   allowed origin   the single configured local fixture origin, and nothing else
 *   allowed actions  navigate, click, type, select, read
 *   always blocked   navigation off-origin, and any action on a resolved control whose accessible
 *                    name matches the irreversible patterns
 *
 * PHASE 7 added the configurable engine ALONGSIDE this, not in place of it. This runs FIRST on
 * every action and the engine runs second, so the effective decision is the strictest of the two.
 * The minimum is never absent, and a configuration that would disable it is not expressible,
 * because the minimum is not configuration. `tests/policy.engine.test.ts` asserts that both still
 * refuse an off-origin navigate and every action type on "Submit Request".
 */

/**
 * Names that mean "this cannot be undone from inside the application".
 *
 * Matched against the RESOLVED control's accessible name, which is why this check happens after
 * resolution rather than before it: a policy cannot classify "click Delete Member" until it knows
 * that the thing that resolved is, in fact, Delete Member.
 *
 * The list is intentionally broader than this fixture needs. A minimum that only blocks the exact
 * button in the demo is a demo, not a minimum.
 */
export const IRREVERSIBLE_NAME_PATTERNS: readonly RegExp[] = [
  /\bsubmit request\b/i,
  /\bsubmit\b.*\brequest\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bclose account\b/i,
  /\btransfer\b/i,
  /\bwire\b/i,
  /\bapprove\b/i,
  /\bauthorize\b/i,
  /\bpost\b.*\btransaction\b/i,
];

export const BOOTSTRAP_ALLOWED_ACTIONS: readonly SurfaceActionType[] = [
  'navigate',
  'click',
  'type',
  'select',
  'read',
];

export type PolicyDecision =
  { allowed: true } | { allowed: false; error: ErrorCode; reason: string };

const ALLOW: PolicyDecision = { allowed: true };

function literalSegments(segments: readonly TextMatcher[]): string[] {
  return segments.map((segment) => (segment.kind === 'literal' ? segment.value : ''));
}

/**
 * Build the URL a navigate action would go to, so its ORIGIN can be checked before anything moves.
 *
 * Segments are joined against the allowed origin. An absolute URL smuggled in as a segment
 * therefore re-bases the result, and the origin comparison catches it. That is the whole point of
 * resolving the URL rather than pattern-matching the segments.
 */
export function navigationTarget(
  segments: readonly TextMatcher[],
  allowedOrigin: string,
): URL | null {
  try {
    const joined = literalSegments(segments)
      .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
      .filter((segment) => segment !== '')
      .join('/');
    return new URL(joined, allowedOrigin);
  } catch {
    return null;
  }
}

/**
 * Step 2 of the input path. Static: action type and origin only. Nothing has been resolved yet.
 */
export function bootstrapStaticCheck(action: SurfaceAction, allowedOrigin: string): PolicyDecision {
  if (!BOOTSTRAP_ALLOWED_ACTIONS.includes(action.type)) {
    return {
      allowed: false,
      error: 'POLICY_BLOCKED',
      reason: 'action type ' + action.type + ' is outside the bootstrap safety minimum',
    };
  }

  if (action.type === 'navigate') {
    const target = navigationTarget(action.pathSegments, allowedOrigin);
    if (target === null) {
      return {
        allowed: false,
        error: 'ALLOWLIST_VIOLATION',
        reason: 'navigation target could not be resolved against the allowed origin',
      };
    }
    if (target.origin !== new URL(allowedOrigin).origin) {
      return {
        allowed: false,
        error: 'ALLOWLIST_VIOLATION',
        reason:
          'navigation to ' +
          target.origin +
          ' is outside the allowed origin ' +
          new URL(allowedOrigin).origin,
      };
    }
  }

  return ALLOW;
}

/**
 * Step 5 of the input path. Runs AFTER resolution, because it needs to know what resolved.
 *
 * Every action on an irreversible control is blocked, including `read`. Reading a button label is
 * harmless in itself, but "we allow some interactions with the irreversible control" is a sentence
 * that invites exceptions, and an exception in this particular check is how the demo becomes an
 * incident. The minimum stays boring.
 */
export function bootstrapResolvedCheck(
  action: SurfaceAction,
  control: PerceivedControl,
): PolicyDecision {
  for (const pattern of IRREVERSIBLE_NAME_PATTERNS) {
    if (pattern.test(control.name)) {
      return {
        allowed: false,
        error: 'POLICY_BLOCKED',
        reason:
          'refusing to ' +
          action.type +
          ' the control "' +
          control.name +
          '": its name matches an irreversible-action pattern (' +
          String(pattern) +
          ')',
      };
    }
  }
  return ALLOW;
}

/**
 * The no-policy fallback, used when a surface is constructed without a `PolicyEngine`.
 *
 * These were the PHASE 7 hook points, and PHASE 7 filled that slot with `PolicyEngine`. They remain
 * as the permissive default so the input path has ONE shape whether or not an engine is configured -
 * a surface with no engine behaves exactly as it did in PHASE 2, which is to say the bootstrap
 * minimum and nothing else. Every browser-free test relies on that.
 */
export function staticPolicyHook(_action: SurfaceAction, _allowedOrigin: string): PolicyDecision {
  return ALLOW;
}

export function resolvedPolicyHook(
  _action: SurfaceAction,
  _control: PerceivedControl,
): PolicyDecision {
  return ALLOW;
}
