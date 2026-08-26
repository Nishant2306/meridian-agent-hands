import type { AssertionEvaluator } from '../artifact/assertions.js';
import {
  detectCondition,
  type EffectiveDetectors,
  type ScreenCondition,
} from '../artifact/detectors.js';
import type { Assertion } from '../types/assertion.js';
import type { Observation } from '../types/perception.js';
import type { InputDefinition } from '../types/spec.js';
import type { Surface } from '../types/surface.js';

/**
 * ==============================================================================================
 * [MUST] THE INTEGRATED OBSERVATION LOOP.
 * ==============================================================================================
 *
 * After performing an action, until the deadline:
 *
 *     observe
 *       -> global safety detectors
 *       -> hard failures
 *       -> known business outcomes
 *       -> recoveries
 *       -> expected effects / wait predicate
 *       -> if none matched, bounded poll
 *
 * WHY DETECTORS ARE CHECKED IN THE SAME LOOP AS THE WAIT, AND NOT AFTER IT.
 *
 * Click Search for a member that does not exist. The application renders "No member found for that
 * ID." The expected effect of the NEXT step is a member-details screen, and that predicate will
 * never become true, so a wait-then-check design sits there until the timeout expires and then
 * reports TIMEOUT - a FAILURE, escalated to a human, for a run in which everything worked
 * correctly and the answer was simply "no such member".
 *
 * That is exactly the distinction this system exists to make. MEMBER_NOT_FOUND is a business
 * outcome: the automation succeeded and the answer is negative. Reporting it as a timeout tells
 * an operator the automation is broken, and tells the caller nothing at all.
 *
 * The ladder order inside `detectCondition` is itself load-bearing (DECISIONS.md D18): terminal
 * states are evaluated before non-terminal remediation, because a recovery is an ACTION and we
 * must never act on a run that is already decided.
 */
export type SettleOutcome =
  | { kind: 'settled'; observation: Observation; ms: number }
  | { kind: 'condition'; condition: ScreenCondition; observation: Observation; ms: number }
  | { kind: 'timeout'; observation: Observation; ms: number };

export interface SettleOptions {
  surface: Surface;
  detectors: EffectiveDetectors;
  evaluator: AssertionEvaluator;
  /** The predicate that says the action landed. Empty means "any observation will do". */
  expectedEffects: readonly Assertion[];
  params: Readonly<Record<string, string>>;
  inputs: readonly InputDefinition[];
  /** The observation from immediately before the action, for screen_identity_changed. */
  before?: Observation;
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: (observation: Observation) => void;
}

export async function settle(options: SettleOptions): Promise<SettleOutcome> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const started = now();
  const deadline = started + options.timeoutMs;
  let latest = await options.surface.observe();

  for (;;) {
    options.onPoll?.(latest);

    // Detectors FIRST, every pass. See the banner above.
    const condition = detectCondition(latest, options.detectors);
    if (condition !== null) {
      return { kind: 'condition', condition, observation: latest, ms: now() - started };
    }

    const context = {
      observation: latest,
      params: options.params,
      inputs: options.inputs,
      ...(options.before === undefined ? {} : { before: options.before }),
    };
    if (options.evaluator.evaluateAll(options.expectedEffects, context).passed) {
      return { kind: 'settled', observation: latest, ms: now() - started };
    }

    if (now() >= deadline) {
      return { kind: 'timeout', observation: latest, ms: now() - started };
    }

    await sleep(options.pollMs);
    latest = await options.surface.observe();
  }
}
