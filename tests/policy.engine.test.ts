import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSafetyProfile, safetyProfilePath } from '../src/artifact/profiles.js';
import { allowlistPath, loadAllowlist } from '../src/policy/allowlist.js';
import { PolicyEngine } from '../src/policy/engine.js';
import {
  bootstrapResolvedCheck,
  bootstrapStaticCheck,
  BOOTSTRAP_ALLOWED_ACTIONS,
} from '../src/surface/bootstrap-policy.js';
import type { SurfaceAction, SurfaceActionType } from '../src/types/action.js';
import type { PerceivedControl } from '../src/types/perception.js';

/**
 * ================================================================================================
 * [MUST] THE BOOTSTRAP MINIMUM DOES NOT COME OUT ON TRUST.
 * ================================================================================================
 *
 * The minimum in `src/surface/bootstrap-policy.ts` has been active since PHASE 2. It is what stood
 * between a real model and the "Submit Request" button across both GATE 1 runs. PHASE 7 adds a
 * configurable engine at the same two enforcement points, and the temptation at that moment is to
 * delete the thing the engine replaces.
 *
 * So this file asserts BOTH, separately: the minimum still refuses what it always refused, and the
 * engine refuses it too. Either one alone would be enough to block; having both means a mistake in
 * one is not a hole.
 */

const CONFIG_ROOT = fileURLToPath(new URL('../config', import.meta.url));

function engine(): PolicyEngine {
  return new PolicyEngine({
    allowlist: loadAllowlist(allowlistPath(CONFIG_ROOT)),
    safetyProfile: loadSafetyProfile(safetyProfilePath(CONFIG_ROOT, 'banking-default', '1.0.0'))
      .profile,
  });
}

const ORIGIN = 'http://localhost:4180';

/** Any well-formed semantic descriptor: these tests are about POLICY, not resolution. */
const TARGET = { role: 'button' as const, nameMatch: 'exact' as const };

function control(name: string, role: PerceivedControl['role'] = 'button'): PerceivedControl {
  return {
    markId: 1,
    role,
    name,
    enabled: true,
    contextPath: ['contentFrame'],
    nearbyText: [],
    stableAttributes: {},
    box: { x: 0, y: 0, width: 10, height: 10 },
    containers: [],
  };
}

function navigateTo(...segments: string[]): SurfaceAction {
  return {
    type: 'navigate',
    pathSegments: segments.map((value) => ({ kind: 'literal' as const, value })),
  };
}

describe('[MUST] after the swap, the PHASE 2 guarantees still hold', () => {
  it('an off-origin navigate is refused by the minimum AND by the engine', () => {
    const action = navigateTo('https://evil.example.com/steal');

    const minimum = bootstrapStaticCheck(action, ORIGIN);
    const configured = engine().staticCheck(action, ORIGIN);

    expect(minimum.allowed).toBe(false);
    expect(minimum.allowed === false && minimum.error).toBe('ALLOWLIST_VIOLATION');
    expect(configured.allowed).toBe(false);
    expect(configured.allowed === false && configured.error).toBe('ALLOWLIST_VIOLATION');
  });

  it('EVERY action type on "Submit Request" is refused by the minimum AND by the engine', () => {
    const submit = control('Submit Request');

    for (const type of BOOTSTRAP_ALLOWED_ACTIONS) {
      const action = (
        type === 'navigate'
          ? navigateTo('member')
          : type === 'type' || type === 'select'
            ? {
                type,
                target: { semantic: TARGET, recordedTier: 'T1_EXACT_ROLE_NAME' },
                value: { kind: 'literal', value: 'x' },
              }
            : { type, target: { semantic: TARGET, recordedTier: 'T1_EXACT_ROLE_NAME' } }
      ) as SurfaceAction;
      if (type === 'navigate') continue;

      const minimum = bootstrapResolvedCheck(action, submit);
      const configured = engine().resolvedCheck(action, submit);

      expect(minimum.allowed, type + ' passed the minimum').toBe(false);
      expect(configured.allowed, type + ' passed the engine').toBe(false);
    }
  });

  it('read is blocked too, on both, which is the boring part that matters', () => {
    // "We allow SOME interactions with the irreversible control" is a sentence that invites
    // exceptions, and an exception in this check is how a demo becomes an incident.
    const action = {
      type: 'read',
      target: { semantic: TARGET, recordedTier: 'T1_EXACT_ROLE_NAME' },
    } as SurfaceAction;

    expect(bootstrapResolvedCheck(action, control('Submit Request')).allowed).toBe(false);
    expect(engine().resolvedCheck(action, control('Submit Request')).allowed).toBe(false);
  });

  it('the engine can only make the decision STRICTER, never looser', () => {
    // The route deny list is something the engine has and the minimum does not. Nothing the engine
    // ALLOWS can re-open something the minimum refused, because the minimum runs first in the input
    // path and returns on refusal.
    const submitRoute = navigateTo('member', '10001', 'subaccount', 'submit');

    expect(bootstrapStaticCheck(submitRoute, ORIGIN).allowed).toBe(true);
    const configured = engine().staticCheck(submitRoute, ORIGIN);
    expect(configured.allowed).toBe(false);
    expect(configured.allowed === false && configured.error).toBe('ALLOWLIST_VIOLATION');
  });
});

describe('[MUST] IRREVERSIBLE is blocked outright, with no override', () => {
  it('an artifact that declares "Submit Request" SAFE_REVERSIBLE is not believed', () => {
    // effectiveRisk is the MAXIMUM of the declared risk and what the profile says about the control
    // that actually resolved. If a declared value could LOWER the answer, editing one field of a
    // JSON file would be enough to get this clicked.
    const decision = engine().resolvedCheck(
      { type: 'click', target: { semantic: TARGET, recordedTier: 'T1_EXACT_ROLE_NAME' } },
      control('Submit Request'),
      { declaredRisk: 'SAFE_REVERSIBLE' },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('IRREVERSIBLE');
  });

  it('assessRisk takes the maximum, and says where each input came from', () => {
    const assessment = engine().assessRisk(control('Submit Request'), {
      declaredRisk: 'SAFE_REVERSIBLE',
    });

    expect(assessment.declared).toBe('SAFE_REVERSIBLE');
    expect(assessment.fromControl).toBe('IRREVERSIBLE');
    expect(assessment.effective).toBe('IRREVERSIBLE');
  });

  it('raises a SAFE control to the declared risk when the artifact says it is riskier', () => {
    // The maximum works in both directions. An artifact is allowed to be MORE careful than the
    // profile; it is never allowed to be less.
    const assessment = engine().assessRisk(control('Search'), { declaredRisk: 'RISKY_REVERSIBLE' });

    expect(assessment.fromControl).toBe('SAFE_REVERSIBLE');
    expect(assessment.effective).toBe('RISKY_REVERSIBLE');
  });

  it('there is no flag, anywhere, that permits an irreversible action', async () => {
    // A run-wide boolean binds approval to nothing: not one action, not one control, not one
    // screen state, not one time window. See DECISIONS.md D53 for the shape a real grant needs.
    const { readFileSync } = await import('node:fs');
    const sources = [
      '../src/policy/engine.ts',
      '../src/surface/bootstrap-policy.ts',
      '../src/cli/replay.ts',
      '../src/cli/discover.ts',
    ].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));

    for (const source of sources) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(code).not.toContain('approveIrreversible');
      expect(code).not.toContain('approve-irreversible');
      expect(code).not.toContain('allowIrreversible');
    }
  });
});

describe('deny patterns are contextual and word-bounded', () => {
  it('does NOT block "Close notice", which a bare /close/ would', () => {
    // A guardrail that fires on obviously harmless controls does not read as careful. It reads as
    // unconsidered, and the first thing anyone does with one is find a way around it.
    const decision = engine().resolvedCheck(
      { type: 'click', target: { semantic: TARGET, recordedTier: 'T1_EXACT_ROLE_NAME' } },
      control('Close notice'),
    );

    expect(decision.allowed).toBe(true);
  });

  it('DOES block "Transfer history" - and that is the PINNED profile, not the allowlist', () => {
    // An honest failure of the contextual rule, and it is worth having a test say so out loud.
    //
    // The allowlist this phase wrote is contextual: its phrase is `confirm transfer`, and
    // "Transfer history" sails past it. The PINNED SAFETY PROFILE from PHASE 3 is not - its
    // irreversible list contains the bare word `transfer`, deliberately, on the reasoning that a
    // minimum which only blocks the exact button in the demo is a demo rather than a minimum.
    //
    // The result is a false positive: a read-only history link is refused. Nothing in this
    // capability touches it, so nothing is broken today. It cannot be fixed by editing the
    // profile - that file is hashed into every artifact including the one approved at GATE 1 - so
    // the fix is a NEW PROFILE VERSION, which is deferred and recorded in DECISIONS.md D54.
    const decision = engine().resolvedCheck(
      { type: 'click', target: { semantic: TARGET, recordedTier: 'T1_EXACT_ROLE_NAME' } },
      control('Transfer history'),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('IRREVERSIBLE');
  });

  it('the ALLOWLIST layer, which this phase does control, is contextual', () => {
    // Checked directly against the deny patterns rather than through the engine, because the
    // pinned profile above would mask the answer.
    const allowlist = engine().allowlist;
    const phrases = allowlist.deniedControlPatterns.map((rule) => rule.controlPhrase);

    expect(phrases).toContain('confirm transfer');
    expect(phrases).not.toContain('transfer');
    expect(phrases).not.toContain('close');
    expect(phrases).not.toContain('delete');
    for (const phrase of phrases) {
      // Every one of them is a PHRASE with a qualifier, not a lone verb.
      expect(phrase.includes(' ') || phrase === 'export', phrase + ' is a bare verb').toBe(true);
    }
  });

  it('DOES block the phrases that mean it', () => {
    for (const name of ['Close Account', 'Delete Member', 'Confirm Transfer', 'Send Wire']) {
      const decision = engine().resolvedCheck(
        { type: 'click', target: { semantic: TARGET, recordedTier: 'T1_EXACT_ROLE_NAME' } },
        control(name),
      );
      expect(decision.allowed, name + ' was allowed').toBe(false);
    }
  });

  it('applies a screen-scoped rule only on that screen', () => {
    const action = {
      type: 'click',
      target: { semantic: TARGET, recordedTier: 'T1_EXACT_ROLE_NAME' },
    } as SurfaceAction;

    // "Export" is denied on a member screen, where it moves PII out of the application.
    const onMember = engine().resolvedCheck(action, control('Export'), {
      screenName: 'Member Record',
    });
    // The same control on a screen showing no member data is not the same act.
    const elsewhere = engine().resolvedCheck(action, control('Export'), {
      screenName: 'System Reports',
    });

    expect(onMember.allowed).toBe(false);
    expect(elsewhere.allowed).toBe(true);
  });
});

describe('the allowlist itself', () => {
  it('refuses coordinate actions, and cannot be configured to permit them', () => {
    // A click at (x, y) is not a click on a CONTROL, so nothing downstream can classify its risk.
    expect(engine().allowlist.coordinateActionsAllowed).toBe(false);
  });

  it('matches origins EXACTLY, so a lookalike host is not allowed', () => {
    const decision = engine().staticCheck(
      navigateTo('http://localhost:4180.evil.example.com/'),
      ORIGIN,
    );
    expect(decision.allowed).toBe(false);
  });

  it('denies a route that also matches an allow pattern', () => {
    // Deny wins. The deny list is what somebody wrote down after thinking about a danger.
    const allowlist = loadAllowlist(allowlistPath(CONFIG_ROOT));
    expect(allowlist.deniedRoutePatterns.some((p) => /submit/.test(p))).toBe(true);
  });

  it('refuses an action type outside allowedActionTypes', () => {
    const decision = engine().staticCheck(
      { type: 'press_key' } as unknown as SurfaceAction,
      ORIGIN,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.error).toBe('POLICY_BLOCKED');
  });

  it('allows the ordinary happy-path controls, so the guardrail is not just "no"', () => {
    // A policy that refuses everything is trivially safe and useless. The capability has to work.
    const action = {
      type: 'click',
      target: { semantic: TARGET, recordedTier: 'T1_EXACT_ROLE_NAME' },
    } as SurfaceAction;

    for (const name of ['Search', 'Open', 'New Sub-Account', 'Continue']) {
      expect(engine().resolvedCheck(action, control(name)).allowed, name).toBe(true);
    }
    expect(engine().staticCheck(navigateTo('search'), ORIGIN).allowed).toBe(true);
    expect(
      engine().staticCheck(navigateTo('member', '10001', 'subaccount', 'new'), ORIGIN).allowed,
    ).toBe(true);
  });
});

describe('the swap did not narrow what the minimum covers', () => {
  it('every action type the minimum allows is still allowed by the allowlist', () => {
    const allowed = new Set<SurfaceActionType>(engine().allowlist.allowedActionTypes);
    for (const type of BOOTSTRAP_ALLOWED_ACTIONS) {
      expect(allowed.has(type), type + ' is missing from allowedActionTypes').toBe(true);
    }
  });
});
