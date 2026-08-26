import { navigationTarget, type PolicyDecision } from '../surface/bootstrap-policy.js';
import { classifyControlRisk, isIrreversibleControl } from '../artifact/policy.js';
import { phraseMatches } from '../artifact/phrases.js';
import type { SafetyProfile } from '../artifact/profiles.js';
import type { SurfaceAction } from '../types/action.js';
import type { PerceivedControl } from '../types/perception.js';
import { maxRisk, RISK_ORDER, type RiskClass } from '../types/risk.js';
import type { Allowlist } from './allowlist.js';

/**
 * ================================================================================================
 * THE CONFIGURABLE POLICY ENGINE. IT SITS ALONGSIDE THE BOOTSTRAP MINIMUM, NEVER INSTEAD OF IT.
 * ================================================================================================
 *
 * The minimum in `src/surface/bootstrap-policy.ts` has been active since PHASE 2 and is what stood
 * behind both real model runs at GATE 1. It is not removed here, and it is not removed later: the
 * input path runs the minimum FIRST and this engine SECOND, so the effective decision is the
 * strictest of the two. A configuration that switches the minimum off is not expressible, because
 * the minimum is not configuration.
 *
 * `tests/policy.engine.test.ts` asserts that after the swap an off-origin navigate and every action
 * type on "Submit Request" are still refused. The minimum does not come out on trust.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THERE IS NO --approve-irreversible FLAG
 * ------------------------------------------------------------------------------------------------
 * IRREVERSIBLE is blocked outright, in discovery and in replay, with no override. A run-wide
 * boolean binds approval to NOTHING: not one action, not one control, not one screen state, not one
 * time window. Somebody approves "the run may submit", and what they have actually authorised is
 * every irreversible control the run happens to encounter, including ones nobody was looking at.
 *
 * The capability this system exists to demonstrate never needs to submit - it prepares a request
 * and stops at review - so blocking outright is both safer AND simpler than any grant mechanism.
 * The shape a real grant would need is written up in DECISIONS.md D53; it is deliberately not
 * built, because a half-built approval mechanism is worse than none.
 */

export interface PolicyContext {
  /** The screen the action is about to happen on. Needed for CONTEXTUAL deny rules. */
  readonly screenName?: string;
  /**
   * The risk the ARTIFACT declared for this step, if any. It is one input to the maximum, never
   * the answer: an artifact that labels "Submit Request" SAFE_REVERSIBLE must not be believed.
   */
  readonly declaredRisk?: RiskClass;
}

export interface RiskAssessment {
  readonly effective: RiskClass;
  readonly declared: RiskClass | undefined;
  readonly fromControl: RiskClass;
  readonly ceiling: RiskClass;
}

const ALLOW: PolicyDecision = { allowed: true };

export class PolicyEngine {
  readonly #allowlist: Allowlist;
  readonly #safety: SafetyProfile;

  readonly #origins: ReadonlySet<string>;

  constructor(options: {
    allowlist: Allowlist;
    safetyProfile: SafetyProfile;
    /**
     * The origin THIS RUN was configured with, when it is not one of the defaults in the allowlist
     * file - a `--origin` flag, or a fixture on an ephemeral port.
     *
     * This is deployment configuration, not a bypass, and the distinction is worth being precise
     * about. The bootstrap minimum pins the ENTIRE run to one origin and refuses everything else
     * before this engine is consulted at all, so the most this can do is agree with a decision the
     * minimum has already made. It cannot widen the run to a second origin, because the minimum
     * only ever knows about one.
     */
    runOrigin?: string;
  }) {
    this.#allowlist = options.allowlist;
    this.#safety = options.safetyProfile;
    this.#origins = new Set(
      [
        ...options.allowlist.allowedOrigins,
        ...(options.runOrigin === undefined ? [] : [options.runOrigin]),
      ].map((origin) => new URL(origin).origin),
    );
  }

  /** Every origin this engine will permit: the allowlist file, plus this run's configured origin. */
  get allowedOrigins(): readonly string[] {
    return [...this.#origins];
  }

  get allowlist(): Allowlist {
    return this.#allowlist;
  }

  /**
   * Step 3 of the input path. Static: action type, origin and route. Nothing has resolved yet, so
   * nothing here can say anything about a control.
   */
  staticCheck(action: SurfaceAction, allowedOrigin: string): PolicyDecision {
    if (!this.#allowlist.allowedActionTypes.includes(action.type)) {
      return {
        allowed: false,
        error: 'POLICY_BLOCKED',
        reason: 'action type ' + action.type + ' is not in allowedActionTypes',
      };
    }

    if (action.type !== 'navigate') return ALLOW;

    const target = navigationTarget(action.pathSegments, allowedOrigin);
    if (target === null) {
      return {
        allowed: false,
        error: 'ALLOWLIST_VIOLATION',
        reason: 'navigation target could not be resolved against the allowed origin',
      };
    }

    // EXACT origin match. No wildcards and no suffix matching: `*.example.com` is how an
    // attacker-controlled `evilexample.com` ends up allowed.
    if (!this.#origins.has(target.origin)) {
      return {
        allowed: false,
        error: 'ALLOWLIST_VIOLATION',
        reason: 'origin ' + target.origin + ' is not in allowedOrigins',
      };
    }

    // DENY WINS. A path matching both an allow and a deny pattern is denied, because the deny list
    // is what somebody wrote down after thinking about a specific danger.
    for (const pattern of this.#allowlist.deniedRoutePatterns) {
      if (new RegExp(pattern).test(target.pathname)) {
        return {
          allowed: false,
          error: 'ALLOWLIST_VIOLATION',
          reason: 'route ' + target.pathname + ' matches deniedRoutePatterns ' + pattern,
        };
      }
    }

    if (this.#allowlist.allowedRoutePatterns.length > 0) {
      const allowed = this.#allowlist.allowedRoutePatterns.some((pattern) =>
        new RegExp(pattern).test(target.pathname),
      );
      if (!allowed) {
        return {
          allowed: false,
          error: 'ALLOWLIST_VIOLATION',
          reason: 'route ' + target.pathname + ' is not in allowedRoutePatterns',
        };
      }
    }

    return ALLOW;
  }

  /**
   * effectiveRisk = MAX(artifact-declared, policy-derived from the resolved control).
   *
   * The maximum, never the most recent and never the artifact's own opinion. An artifact is
   * produced by a model and can be hand-edited afterwards; if a declared `SAFE_REVERSIBLE` could
   * lower the answer, then editing one field of a JSON file would be enough to get "Submit Request"
   * clicked, and every guarantee here would rest on the honesty of that file.
   */
  assessRisk(control: PerceivedControl, context: PolicyContext = {}): RiskAssessment {
    const fromControl = classifyControlRisk(control.name, this.#safety);
    const declared = context.declaredRisk;
    return {
      effective: declared === undefined ? fromControl : maxRisk(declared, fromControl),
      declared,
      fromControl,
      ceiling: this.#allowlist.riskRules.maxRiskAllowed,
    };
  }

  /**
   * Step 5 of the input path, after resolution, because nothing can classify "click Delete Member"
   * until it knows that what resolved is Delete Member.
   */
  resolvedCheck(
    action: SurfaceAction,
    control: PerceivedControl,
    context: PolicyContext = {},
  ): PolicyDecision {
    // 1. The pinned safety profile's irreversible list. Never overridable, on any screen.
    const irreversible = isIrreversibleControl(control.name, this.#safety);
    if (irreversible !== null) {
      return {
        allowed: false,
        error: 'POLICY_BLOCKED',
        reason:
          'refusing to ' +
          action.type +
          ' "' +
          control.name +
          '": the pinned safety profile classifies it as IRREVERSIBLE. ' +
          irreversible +
          ' There is no override.',
      };
    }

    // 2. The deployment's own deny patterns, contextual and word-bounded.
    for (const rule of this.#allowlist.deniedControlPatterns) {
      if (!phraseMatches(control.name, rule.controlPhrase)) continue;
      if (
        rule.screenPhrase !== undefined &&
        !phraseMatches(context.screenName ?? '', rule.screenPhrase)
      ) {
        continue;
      }
      return {
        allowed: false,
        error: 'POLICY_BLOCKED',
        reason:
          'refusing to ' +
          action.type +
          ' "' +
          control.name +
          '"' +
          (rule.screenPhrase === undefined
            ? ''
            : ' on a screen matching "' + rule.screenPhrase + '"') +
          ': ' +
          rule.why,
      };
    }

    // 3. The risk ceiling. `read` is exempt: it changes nothing, and a policy that refuses to LOOK
    // at a risky control leaves the run unable to explain why it stopped.
    if (action.type === 'read') return ALLOW;

    const risk = this.assessRisk(control, context);
    if (risk.effective === 'IRREVERSIBLE') {
      return {
        allowed: false,
        error: 'POLICY_BLOCKED',
        reason:
          'refusing to ' +
          action.type +
          ' "' +
          control.name +
          '": effective risk IRREVERSIBLE. There is no override in v1.',
      };
    }
    if (RISK_ORDER[risk.effective] > RISK_ORDER[risk.ceiling]) {
      return {
        allowed: false,
        error: 'POLICY_BLOCKED',
        reason:
          'refusing to ' +
          action.type +
          ' "' +
          control.name +
          '": effective risk ' +
          risk.effective +
          ' exceeds the configured ceiling ' +
          risk.ceiling,
      };
    }

    return ALLOW;
  }
}
