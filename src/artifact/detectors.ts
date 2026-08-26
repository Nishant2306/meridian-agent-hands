import type { ErrorCode } from '../types/outcomes.js';
import type { Observation } from '../types/perception.js';
import { phraseMatches } from './phrases.js';
import type { ConditionProfile, Detect, HardFailure, KnownOutcome, Recovery } from './profiles.js';

/**
 * ==============================================================================================
 * [MUST] DETECTOR LAYERING.
 * ==============================================================================================
 *
 *     effective detectors  =  GLOBAL ENGINE  +  PINNED CONDITION PROFILE  +  CAPABILITY ADDITIONS
 *
 * The GLOBAL layer is not optional and cannot be removed by a profile or by a capability. An
 * approved artifact that did not recognise a lease violation or a blocked irreversible action
 * would be an approved artifact that cannot tell "I was stopped by a guardrail" from "the screen
 * did not do what I expected", and those need opposite responses from an operator.
 *
 * The global detectors are SYSTEM-RAISED, not screen-matched. Nothing on the page tells you that a
 * lease was violated; the runtime knows. Keeping them in the same effective set anyway means there
 * is one list to look at when asking "what can stop this run", which is the question an operator
 * actually has.
 */
export interface SystemDetector {
  id: string;
  source: 'system';
  code: ErrorCode;
  description: string;
}

export const GLOBAL_DETECTORS: readonly SystemDetector[] = [
  {
    id: 'global.allowlist-violation',
    source: 'system',
    code: 'ALLOWLIST_VIOLATION',
    description: 'The run tried to leave the allowed origin.',
  },
  {
    id: 'global.lease-violation',
    source: 'system',
    code: 'LEASE_VIOLATION',
    description: 'An action arrived without the current lease. Another actor holds control.',
  },
  {
    id: 'global.surface-unavailable',
    source: 'system',
    code: 'SURFACE_UNAVAILABLE',
    description: 'The browser or driven process died. Distinct from the application erroring.',
  },
  {
    id: 'global.blocked-irreversible-action',
    source: 'system',
    code: 'POLICY_BLOCKED',
    description: 'A guardrail refused an action on a control classified as irreversible.',
  },
  {
    id: 'global.session-expired',
    source: 'system',
    code: 'SESSION_EXPIRED',
    description:
      'The authenticated session was lost. The condition profile adds the screen-text form of ' +
      'the same code; either may fire first.',
  },
];

/** Does this detector match what we can currently see? */
export function detectMatches(detect: Detect, observation: Observation): boolean {
  if (detect.kind === 'text') {
    if (phraseMatches(observation.screenIdentity.canonicalScreenName, detect.phrase)) return true;
    return observation.controls.some(
      (control) =>
        phraseMatches(control.name, detect.phrase) ||
        (control.value !== undefined && phraseMatches(control.value, detect.phrase)),
    );
  }

  return observation.controls.some(
    (control) =>
      control.role === detect.role &&
      (detect.phrase === undefined || phraseMatches(control.name, detect.phrase)),
  );
}

export interface EffectiveDetectors {
  system: readonly SystemDetector[];
  knownOutcomes: readonly KnownOutcome[];
  recoveries: readonly Recovery[];
  hardFailures: readonly HardFailure[];
}

/**
 * Build the effective set.
 *
 * Capability additions are given by ID and must NOT duplicate anything the profile already covers.
 * A duplicated detector is a second place that has to be kept in step with the first, and the
 * moment they disagree the artifact means two things at once.
 */
export function effectiveDetectors(
  profile: ConditionProfile,
  capability: {
    knownOutcomes?: readonly KnownOutcome[];
    recoveries?: readonly Recovery[];
    hardFailures?: readonly HardFailure[];
  } = {},
): EffectiveDetectors {
  return {
    system: GLOBAL_DETECTORS,
    knownOutcomes: [...profile.knownOutcomes, ...(capability.knownOutcomes ?? [])],
    recoveries: [...profile.recoveries, ...(capability.recoveries ?? [])],
    hardFailures: [...profile.hardFailures, ...(capability.hardFailures ?? [])],
  };
}

/**
 * A raised global-safety condition. The runtime already knows about these; nothing on the screen
 * tells you that a lease was violated.
 */
export interface RaisedSystemCondition {
  detectorId: string;
  reason: string;
}

export type ScreenCondition =
  | { kind: 'system'; detector: SystemDetector; reason: string }
  | { kind: 'hard_failure'; failure: HardFailure }
  | { kind: 'known_outcome'; outcome: KnownOutcome }
  | { kind: 'recovery'; recovery: Recovery }
  | { kind: 'needs_human'; reason: string };

export interface DetectContext {
  /** A global-safety condition the runtime has already raised, if any. */
  systemRaised?: RaisedSystemCondition;
  /**
   * Whether the observation matched a state this capability knows about. False means we are
   * somewhere the artifact does not describe, which is a needs_human answer once every explanation
   * above it has been ruled out.
   */
  screenRecognised?: boolean;
}

/**
 * ==============================================================================================
 * [MUST] THE ORDER OF THIS LADDER IS THE DESIGN.
 * ==============================================================================================
 *
 *   1  GLOBAL SAFETY        raised by the runtime, not read off the screen. Outranks everything:
 *                           if a guardrail stopped us, that is the answer, whatever the page says.
 *   2  HARD FAILURES        terminal. A screen showing both a permission denial and a stale
 *                           "No member found" is a permission problem, and reporting it as a clean
 *                           business outcome would tell a caller the member does not exist when
 *                           the truth is that we were not allowed to look.
 *   3  KNOWN OUTCOMES       terminal. The automation worked and this is the answer.
 *   4  RECOVERIES           NON-TERMINAL, and the only rung that TAKES AN ACTION.
 *   5  NEEDS_HUMAN          we are somewhere nothing above explains.
 *
 * THE PRINCIPLE: terminal states are evaluated before non-terminal remediation, because a recovery
 * is an ACTION and we must never act on a run that is already decided. A screen carrying both a
 * dismissible maintenance notice and a genuine MEMBER_NOT_FOUND returns the OUTCOME. Dismissing
 * the notice and retrying would spend an action, and possibly change state, on a question that had
 * already been answered.
 *
 * (An earlier version of this file put recoveries ahead of known outcomes, reasoning that an
 * overlay is why the rest of the screen looks wrong. That reasoning is real but much weaker than
 * the rule above: the risk it guards against is a misread, while the risk it creates is an
 * unnecessary ACTION on a decided run. See DECISIONS.md D18.)
 */
export function detectCondition(
  observation: Observation,
  detectors: EffectiveDetectors,
  context: DetectContext = {},
): ScreenCondition | null {
  // 1. Global safety.
  const raised = context.systemRaised;
  if (raised !== undefined) {
    const detector = detectors.system.find((entry) => entry.id === raised.detectorId);
    if (detector !== undefined) {
      return { kind: 'system', detector, reason: raised.reason };
    }
  }

  // 2. Terminal: the run failed.
  for (const failure of detectors.hardFailures) {
    if (detectMatches(failure.detect, observation)) return { kind: 'hard_failure', failure };
  }

  // 3. Terminal: the run succeeded and the answer is negative.
  for (const outcome of detectors.knownOutcomes) {
    if (detectMatches(outcome.detect, observation)) return { kind: 'known_outcome', outcome };
  }

  // 4. Non-terminal, and the first rung that would DO something.
  for (const recovery of detectors.recoveries) {
    if (detectMatches(recovery.detect, observation)) return { kind: 'recovery', recovery };
  }

  // 5. Nothing above explains where we are.
  //
  // A BLOCKING overlay nobody described is the sharpest form of this. The modal sits over a screen
  // that is otherwise perfectly recognisable, so "the screen matches no known state" would not
  // fire - and yet nothing can proceed, because a modal that demands an attestation code is not
  // something an automation may guess its way past.
  //
  // Detected STRUCTURALLY, by role, for the same reason APPLICATION_VALIDATION_REJECTED is: the
  // wording of a modal belongs to the application and it may reword it at any time. What we can
  // rely on is that a blocking dialog is marked as one.
  const blocking = observation.controls.find((control) => control.role === 'dialog');
  if (blocking !== undefined) {
    return {
      kind: 'needs_human',
      reason:
        'a blocking dialog' +
        (blocking.name === '' ? '' : ' ("' + blocking.name + '")') +
        ' is displayed, and no condition in the profile describes it. An unrecognised blocking ' +
        'state is a human decision, not something to guess past.',
    };
  }

  if (context.screenRecognised === false) {
    return {
      kind: 'needs_human',
      reason:
        'the screen "' +
        observation.screenIdentity.canonicalScreenName +
        '" matches no state ' +
        'this capability describes, and no known condition explains it',
    };
  }

  return null;
}
