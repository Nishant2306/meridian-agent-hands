import { contentHashOf } from '../config/canonical.js';
import { maxRisk, RISK_ORDER, type RiskClass } from '../types/risk.js';
import { anyPhraseMatches, phraseMatches } from './phrases.js';
import type { PolicyLimits, SafetyProfile } from './profiles.js';

/**
 * ==============================================================================================
 * [MUST] POLICY LAYERING.
 * ==============================================================================================
 *
 *     effective policy  =  global  INTERSECT  tenant  INTERSECT  capability
 *
 * A capability may make its policy STRICTER. It may never make it weaker. Two separate mechanisms
 * enforce that, because they answer different questions:
 *
 *   AT APPROVAL   `policyIsWeakerThan` refuses an artifact that declares a looser limit than the
 *                 current global ceiling. That is an AUTHORING mistake and should be caught by a
 *                 person, not silently corrected.
 *
 *   AT RUN TIME   `effectivePolicy` takes the strictest value of every layer. This is what makes a
 *                 LATER tightening of the global ceiling bind capabilities that were approved
 *                 under a looser one, without reapproving anything.
 */
export function effectivePolicy(layers: readonly PolicyLimits[]): PolicyLimits {
  const first = layers[0];
  if (first === undefined) throw new Error('effectivePolicy needs at least one layer');

  return layers.reduce((strictest, layer) => ({
    maxRiskAllowed:
      RISK_ORDER[layer.maxRiskAllowed] < RISK_ORDER[strictest.maxRiskAllowed]
        ? layer.maxRiskAllowed
        : strictest.maxRiskAllowed,
    maxSteps: Math.min(strictest.maxSteps, layer.maxSteps),
    maxDurationMs: Math.min(strictest.maxDurationMs, layer.maxDurationMs),
  }));
}

export interface PolicyWeakening {
  field: 'maxRiskAllowed' | 'maxSteps' | 'maxDurationMs';
  ceiling: string;
  candidate: string;
}

/** Every way `candidate` is looser than `ceiling`. Empty means it is equal or stricter. */
export function policyIsWeakerThan(
  candidate: PolicyLimits,
  ceiling: PolicyLimits,
): PolicyWeakening[] {
  const weakenings: PolicyWeakening[] = [];

  if (RISK_ORDER[candidate.maxRiskAllowed] > RISK_ORDER[ceiling.maxRiskAllowed]) {
    weakenings.push({
      field: 'maxRiskAllowed',
      ceiling: ceiling.maxRiskAllowed,
      candidate: candidate.maxRiskAllowed,
    });
  }
  if (candidate.maxSteps > ceiling.maxSteps) {
    weakenings.push({
      field: 'maxSteps',
      ceiling: String(ceiling.maxSteps),
      candidate: String(candidate.maxSteps),
    });
  }
  if (candidate.maxDurationMs > ceiling.maxDurationMs) {
    weakenings.push({
      field: 'maxDurationMs',
      ceiling: String(ceiling.maxDurationMs),
      candidate: String(candidate.maxDurationMs),
    });
  }

  return weakenings;
}

/**
 * The global policy hash, materialized into run evidence.
 *
 * Without it, a run's evidence says which CAPABILITY was executed but not which rules were in force
 * while it ran. When the ceiling tightens, that is the difference between being able to explain an
 * old run and having to guess.
 */
export function globalPolicyHash(policy: PolicyLimits): string {
  return contentHashOf(policy);
}

/** Is this control one the safety profile refuses outright, on every screen? */
export function isIrreversibleControl(controlName: string, profile: SafetyProfile): string | null {
  for (const entry of profile.irreversibleControls) {
    if (phraseMatches(controlName, entry.phrase)) return entry.why;
  }
  return null;
}

/**
 * Is this control denied ON THIS SCREEN?
 *
 * The rule pure name matching cannot express: "Continue" advances a form, and on a screen whose
 * whole purpose is confirmation the same word means "do it". The control name is identical; only
 * the screen tells them apart.
 */
export function contextualDenyReason(
  screenName: string,
  controlName: string,
  profile: SafetyProfile,
): string | null {
  for (const rule of profile.contextualDeny) {
    if (
      phraseMatches(screenName, rule.screenPhrase) &&
      phraseMatches(controlName, rule.controlPhrase)
    ) {
      return rule.why;
    }
  }
  return null;
}

/**
 * The risk of acting on a control, per the safety profile.
 *
 * An unrecognised control gets `defaultRisk`, which the profile sets to RISKY_REVERSIBLE. That is
 * the conservative direction: defaulting to SAFE_REVERSIBLE would mean every control nobody thought
 * about is assumed harmless.
 */
export function classifyControlRisk(controlName: string, profile: SafetyProfile): RiskClass {
  if (isIrreversibleControl(controlName, profile) !== null) return 'IRREVERSIBLE';
  for (const rule of profile.riskRules) {
    if (anyPhraseMatches(controlName, rule.phrases)) return rule.risk;
  }
  return profile.defaultRisk;
}

/**
 * Effective risk is the MAXIMUM of the three sources that have an opinion: what the step declared
 * at distillation time, what the safety profile says about the resolved control, and any risk the
 * caller pins on the action itself. The maximum, never the average and never the most recent.
 */
export function effectiveRisk(...sources: readonly RiskClass[]): RiskClass {
  return maxRisk(...sources);
}
