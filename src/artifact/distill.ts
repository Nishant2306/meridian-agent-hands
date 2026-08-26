import { readFileSync } from 'node:fs';
import { AssertionEvaluator } from './assertions.js';
import { classifyControlRisk } from './policy.js';
import { reconstructPath, type PathSegment } from './path.js';
import { sweepParameterization } from './parameterize.js';
import {
  conditionProfilePath,
  loadSafetyProfile,
  profileHash,
  safetyProfilePath,
} from './profiles.js';
import {
  CapabilityArtifactSchema,
  SCHEMA_VERSION,
  type CapabilityArtifact,
  type State,
  type Step,
} from './schema.js';
import {
  checkResumeEligibleExclusivity,
  checkStepDiscrimination,
  validateArtifactStructure,
  type ValidationIssue,
} from './validate.js';
import { foldCase, normalizeText } from '../types/normalize.js';
import { maxRisk, RISK_ORDER, type RiskClass } from '../types/risk.js';
import type { Assertion } from '../types/assertion.js';
import type { DiscoveryRunRecord, ProposedEffect, RecordedStep } from '../types/discovery.js';
import { observationById } from '../types/discovery.js';
import type { Observation } from '../types/perception.js';
import type { TargetResolver } from '../types/surface.js';
import type { InputDefinition } from '../types/spec.js';

/**
 * ==============================================================================================
 * THE DISTILLER: a successful run becomes a reusable capability.
 * ==============================================================================================
 *
 * It FAILS CLOSED at every stage. A run that cannot be distilled into something that satisfies
 * every rule produces no artifact at all, with the reasons listed. The alternative - emitting a
 * plausible artifact with a warning - means the warning is read once and the artifact is executed
 * forever.
 *
 * It also has NO ACCESS TO A MODEL. Its only input is a DiscoveryRunRecord: what was observed, what
 * was done, and what the model PROPOSED about it. Proposals are evidence to be checked against
 * observations, never instructions to be transcribed.
 */
export interface DistillOptions {
  run: DiscoveryRunRecord;
  resolver: TargetResolver;
  capabilityVersion?: string;
  configRoot?: string;
  now?: () => string;
}

export type DistillResult =
  | { ok: true; artifact: CapabilityArtifact; notes: string[] }
  | { ok: false; issues: ValidationIssue[] };

/**
 * A descriptive id for an effect the MODEL proposed, derived the way its siblings are.
 *
 * `step-8-continue.proposed-1` among `step-8-continue.arrived` is a machine artefact sitting in a
 * document meant to be read. The id comes from what the assertion is ABOUT.
 */
function proposedEffectId(stepId: string, effect: ProposedEffect, index: number): string {
  const expected = effect.expected;
  if (expected !== undefined && expected.kind === 'literal') {
    const fromValue = slug(expected.value);
    if (fromValue !== '') return stepId + '.' + fromValue;
  }
  if (expected !== undefined && expected.kind === 'param') {
    return stepId + '.matches-' + slug(expected.name);
  }
  const fromDescription = slug(effect.description.split(' ').slice(0, 4).join(' '));
  return fromDescription === ''
    ? stepId + '.proposed-' + (index + 1)
    : stepId + '.' + fromDescription;
}

function uniqueId(candidate: string, used: Set<string>): string {
  let id = candidate;
  let suffix = 2;
  while (used.has(id)) {
    id = candidate + '-' + suffix;
    suffix += 1;
  }
  used.add(id);
  return id;
}

/**
 * The OPTIONAL parameter this step's value is bound to, if any.
 *
 * A step typing `{{nickname}}` has nothing to type when no nickname was supplied, and the executor
 * refuses to invent a value. So the step carries a guard and replay skips it.
 */
function optionalParamOf(run: DiscoveryRunRecord, step: RecordedStep): string | undefined {
  const action = step.action;
  if (action.type !== 'type' && action.type !== 'select') return undefined;
  if (action.value.kind !== 'param') return undefined;
  const bound = action.value.name;
  const declared = run.spec.inputs.find((input) => input.name === bound);
  return declared !== undefined && !declared.required ? bound : undefined;
}

/** Omitted when it would only restate the intent. */
function notesFor(step: RecordedStep): string | undefined {
  const rationale = step.descriptorRationale.trim();
  if (rationale === '') return undefined;
  if (foldCase(normalizeText(rationale)) === foldCase(normalizeText(step.intent))) return undefined;
  return 'Identified by ' + rationale + '.';
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function screenOf(run: DiscoveryRunRecord, observationId: string): string {
  return observationById(run, observationId)?.screenIdentity.canonicalScreenName ?? '(unknown)';
}

const literal = (value: string): Assertion['expected'] => ({ kind: 'literal', value });
const param = (name: string): Assertion['expected'] => ({ kind: 'param', name });

/** Every observation the run captured on a given screen. Used to test candidate assertions. */
function observationsOnScreen(run: DiscoveryRunRecord, screen: string): Observation[] {
  return run.observations.filter(
    (observation) => observation.screenIdentity.canonicalScreenName === screen,
  );
}

/**
 * The strongest identity check that actually HOLDS on every observation of this screen.
 *
 * The bound record-identity descriptor is preferred, because it compares the displayed identity
 * against the requested one in the declared type's own space. Some screens do not display the
 * identity in an addressable field at all - this application's sub-account form shows it inside a
 * sentence - and on those the honest fallback is that the id appears in the screen text. Choosing
 * per screen, by TESTING both against what was really observed, avoids inventing an invariant that
 * would fail on every run.
 */
function identityInvariant(
  run: DiscoveryRunRecord,
  screens: readonly string[],
  evaluator: AssertionEvaluator,
  inputs: readonly InputDefinition[],
): Assertion | null {
  const identity = run.recordIdentity;
  const observations = screens.flatMap((candidate) => observationsOnScreen(run, candidate));
  if (observations.length === 0) return null;
  const screen = screens[0] ?? '';

  const context = (observation: Observation) => ({
    observation,
    params: run.runtimeInputs,
    inputs,
  });

  if (identity !== null) {
    const strong: Assertion = {
      id: slug(screen) + '.identity',
      kind: 'value_matches_param',
      target: identity.target,
      expected: param(identity.param),
      description: 'the record shown is the record we were asked about',
    };
    if (
      observations.every((observation) => evaluator.evaluate(strong, context(observation)).passed)
    ) {
      return strong;
    }
  }

  const weak: Assertion = {
    id: slug(screen) + '.identity-in-text',
    kind: 'text_present',
    expected: param(run.spec.recordIdentity.param),
    description:
      'the record identity appears in the screen text. This screen does not display it in an ' +
      'addressable field, so this is the strongest check available on it.',
  };
  return observations.every((observation) => evaluator.evaluate(weak, context(observation)).passed)
    ? weak
    : null;
}

interface FilledField {
  step: RecordedStep;
  paramName: string;
}

function filledFields(segment: PathSegment): FilledField[] {
  const filled: FilledField[] = [];
  for (const step of segment.steps) {
    if (step.action.type !== 'type' && step.action.type !== 'select') continue;
    if (step.action.value.kind !== 'param') continue;
    filled.push({ step, paramName: step.action.value.name });
  }
  return filled;
}

/**
 * States, built from OBSERVED screen identities.
 *
 * One base state per screen on the retained path. Where a segment filled fields, a `-complete`
 * variant is added carrying those fields as QUALIFIERS, and the base state stops being
 * resume-eligible: it becomes a step precondition only.
 *
 * That is what produces the property that matters. A HALF-FILLED form matches the base state and
 * NOT the complete one, so it matches no resumable state at all, and a resume lands on a human
 * rather than on a guess about which half of the work was already done. The base and complete
 * states overlap by construction, and that overlap is harmless precisely because only one of them
 * is resumable.
 */
function buildStates(
  run: DiscoveryRunRecord,
  segments: readonly PathSegment[],
  successScreen: string,
  evaluator: AssertionEvaluator,
): { states: State[]; stateIdForScreen: Map<string, { base: string; complete?: string }> } {
  const states: State[] = [];
  const stateIdForScreen = new Map<string, { base: string; complete?: string }>();
  const inputs = run.spec.inputs;

  const screens = [...segments.map((segment) => segment.screen)];
  if (!screens.includes(successScreen)) screens.push(successScreen);

  for (const screen of screens) {
    if (stateIdForScreen.has(screen)) continue;

    const base = slug(screen);
    const segment = segments.find((candidate) => candidate.screen === screen);
    const filled = segment === undefined ? [] : filledFields(segment);
    const identity = identityInvariant(run, [screen], evaluator, inputs);
    const invariants = identity === null ? [] : [identity];

    const screenAssertions: Assertion[] = [
      {
        id: base + '.screen',
        kind: 'screen_identity',
        expected: literal(screen),
        description: 'the screen is "' + screen + '"',
      },
    ];

    const isSuccess = screen === successScreen;
    if (isSuccess) {
      // A heading alone is not a complete screen identity: the same heading is on screen a moment
      // before the application has finished deciding what it is showing. Anything the model
      // proposed as a value_equals effect on the transition INTO success is promoted here, because
      // "the application itself reports this state" is a stronger claim than "the title matches".
      screenAssertions.push({
        id: base + '.text',
        kind: 'text_present',
        expected: literal(screen),
        description: 'the screen text carries "' + screen + '"',
      });
      const finalStep = segments.at(-1)?.steps.at(-1);
      for (const effect of finalStep?.proposedEffects ?? []) {
        if (effect.kind !== 'value_equals' || effect.target === undefined) continue;
        if (effect.expected === undefined || effect.expected.kind !== 'literal') continue;
        screenAssertions.push({
          id: base + '.reported-status',
          kind: 'value_equals',
          target: effect.target,
          expected: effect.expected,
          description: effect.description,
        });
      }
    }

    states.push({
      id: base,
      description: 'The application is showing "' + screen + '".',
      screenAssertions,
      qualifiers: [],
      invariants,
      resumeEligible: filled.length === 0,
    });
    stateIdForScreen.set(screen, { base });

    if (filled.length === 0) continue;

    const completeId = base + '-complete';
    states.push({
      id: completeId,
      description:
        'The application is showing "' +
        screen +
        '" AND it is filled in with the values we were ' +
        'asked for. A half-filled screen matches this no better than any other resumable state, ' +
        'which is the point.',
      screenAssertions: screenAssertions.map((assertion) => ({
        ...assertion,
        id: completeId + assertion.id.slice(base.length),
      })),
      qualifiers: filled.map((field) => {
        const declared = inputs.find((input) => input.name === field.paramName);
        const optional = declared !== undefined && !declared.required;
        return {
          id: completeId + '.' + field.paramName,
          kind: 'value_matches_param' as const,
          target: field.step.action.type === 'navigate' ? undefined : field.step.action.target,
          expected: param(field.paramName),
          description: 'the field holds the requested ' + field.paramName,
          // An OPTIONAL input needs a guard, or every invocation that legitimately omits it fails
          // an assertion about it and reports INVARIANT_VIOLATED.
          ...(optional ? { when: { paramPresent: field.paramName } } : {}),
        };
      }),
      invariants,
      resumeEligible: true,
    });
    stateIdForScreen.set(screen, { base, complete: completeId });
  }

  return { states, stateIdForScreen };
}

/**
 * [MUST] Effects prove the ACTION happened. Invariants must hold on both sides of it.
 *
 * Effects are DERIVED from what the run measured - the screen changed, the target's value changed -
 * and then the model's own proposals are added on top. Deriving first matters: a step whose only
 * evidence is a sentence the model wrote has no evidence at all.
 */
function newContentAssertion(
  run: DiscoveryRunRecord,
  step: RecordedStep,
  stepId: string,
  runtimeValues: readonly string[],
): Assertion | null {
  const before = observationById(run, step.beforeObservationId);
  const after = observationById(run, step.afterObservationId);
  if (before === undefined || after === undefined) return null;

  const seen = new Set(before.controls.map((control) => control.role + ':' + control.name));
  const appeared = after.controls.filter(
    (control) =>
      control.name !== '' &&
      !seen.has(control.role + ':' + control.name) &&
      !runtimeValues.some(
        (value) => foldCase(normalizeText(value)) === foldCase(normalizeText(control.name)),
      ),
  );

  // A HEADING is preferred over any other new text: it is the application naming what it just
  // produced, which is a far more stable thing to assert on than a row of data that will be
  // different on the next invocation.
  const heading = appeared.find((control) => control.role === 'heading') ?? appeared[0];
  if (heading === undefined) return null;

  return {
    id: stepId + '.new-content',
    kind: 'text_present',
    expected: literal(heading.name),
    description: '"' + heading.name + '" appeared, which was not on screen before the action',
  };
}

function expectedEffectsFor(
  run: DiscoveryRunRecord,
  step: RecordedStep,
  stepId: string,
  runtimeValues: readonly string[],
): Assertion[] {
  const effects: Assertion[] = [];
  const afterScreen = screenOf(run, step.afterObservationId);

  // A search changes neither the screen name nor the button that ran it. What it changes is the
  // content that came back, and without this that step would look like a no-op and be deleted.
  if (!step.changedScreen && step.changedInventory) {
    const appeared = newContentAssertion(run, step, stepId, runtimeValues);
    if (appeared !== null) effects.push(appeared);
  }

  if (step.changedScreen) {
    effects.push({
      id: stepId + '.arrived',
      kind: 'screen_identity',
      expected: literal(afterScreen),
      description: 'the screen is now "' + afterScreen + '"',
    });
  }

  if (step.changedTargetValue && step.action.type !== 'navigate') {
    const value = 'value' in step.action ? step.action.value : undefined;
    if (value !== undefined && value.kind === 'param') {
      const declared = run.spec.inputs.find((input) => input.name === value.name);
      effects.push({
        id: stepId + '.value-set',
        kind: 'value_matches_param',
        target: step.action.target,
        expected: param(value.name),
        description: 'the control now holds the requested ' + value.name,
        ...(declared !== undefined && !declared.required
          ? { when: { paramPresent: value.name } }
          : {}),
      });
    } else if (value !== undefined && value.kind === 'literal') {
      // A fill with a FIXED value still has to prove it landed. Without this a step typing a
      // literal derives no effect at all, and the discriminating-effect rule then rejects it -
      // correctly, because nothing about it could tell a successful fill from a swallowed one.
      effects.push({
        id: stepId + '.value-set',
        kind: 'value_equals',
        target: step.action.target,
        expected: literal(value.value),
        description: 'the control now holds "' + value.value + '"',
      });
    }
    // There is deliberately no `control_visible` derivation for a click here. `changedTargetValue`
    // is set when the target resolved before the action and NOT after it - which is what happens
    // when the click navigates away - so asserting the control is still visible would assert the
    // opposite of what was observed. The screen change is the effect worth recording, and it
    // already is. Found by reading the output of `npm run distill:demo`.
  }

  const used = new Set(effects.map((effect) => effect.id));
  for (const [index, proposed] of step.proposedEffects.entries()) {
    if (proposed.kind === 'value_equals' && proposed.target === undefined) continue;
    effects.push({
      id: uniqueId(proposedEffectId(stepId, proposed, index), used),
      kind: proposed.kind,
      description: proposed.description,
      ...(proposed.target === undefined ? {} : { target: proposed.target }),
      ...(proposed.expected === undefined ? {} : { expected: proposed.expected }),
    });
  }

  return effects;
}

/**
 * Step risk, decided by WHAT THE ACTION DOES first and by what the control is called second.
 *
 * Filling a field on a form that has not been submitted is SAFE_REVERSIBLE whatever the field is
 * called. A CLICK is the action that can do anything, so a click is where the safety profile's
 * opinion of the control name governs - and where an unrecognised control falls through to the
 * profile's defaultRisk of RISKY_REVERSIBLE, because assuming that something nobody described is
 * harmless is exactly backwards.
 *
 * An earlier version asked the profile first for any NAMED control. That made typing into the
 * search box RISKY_REVERSIBLE (the field is named "Member ID", which matches no risk phrase, so it
 * fell to defaultRisk) while typing into the unnamed nickname box beside it was SAFE_REVERSIBLE.
 * Same kind of action, opposite classification, decided by whether the field happened to carry an
 * accessible name. Found by reading the output of `npm run distill:demo`.
 *
 * The escalation on the last line is defensive rather than reachable: the bootstrap minimum
 * already refuses EVERY action on an irreversible control, so a type against one cannot get here.
 */
function stepRisk(
  step: RecordedStep,
  safety: Parameters<typeof classifyControlRisk>[1],
): RiskClass {
  const named = step.resolvedControlName !== '';

  if (step.action.type === 'click') {
    return named ? classifyControlRisk(step.resolvedControlName, safety) : safety.defaultRisk;
  }

  const byName = named ? classifyControlRisk(step.resolvedControlName, safety) : 'SAFE_REVERSIBLE';
  return byName === 'IRREVERSIBLE' ? 'IRREVERSIBLE' : 'SAFE_REVERSIBLE';
}

/** Every value THIS invocation used or read. Neither may be baked into a reusable capability. */
function runtimeValuesFor(run: DiscoveryRunRecord): string[] {
  return [
    ...Object.values(run.runtimeInputs),
    ...run.outputs.map((output) => output.observedValue),
    ...(run.recordIdentity === null ? [] : [run.recordIdentity.observedValue]),
  ].filter((value) => value !== '');
}

export function distill(options: DistillOptions): DistillResult {
  const { run, resolver } = options;
  const configRoot = options.configRoot ?? 'config';
  const evaluator = new AssertionEvaluator(resolver);
  const issues: ValidationIssue[] = [];
  const notes: string[] = [];

  if (run.successObservationId === null) {
    return {
      ok: false,
      issues: [
        {
          code: 'RUN_DID_NOT_SUCCEED',
          message:
            'this run has no VERIFIED success observation. A capability is distilled from a run ' +
            'the system confirmed, never from one the model said went well.',
        },
      ],
    };
  }

  const successScreen = screenOf(run, run.successObservationId);
  const segments = reconstructPath(run);
  if (segments.length === 0) {
    return {
      ok: false,
      issues: [{ code: 'NO_STEPS', message: 'the run recorded no usable steps' }],
    };
  }

  const safety = loadSafetyProfile(
    safetyProfilePath(configRoot, run.spec.safetyProfile.id, run.spec.safetyProfile.version),
  ).profile;

  const { states, stateIdForScreen } = buildStates(run, segments, successScreen, evaluator);
  const successState = stateIdForScreen.get(successScreen)?.base;
  if (successState === undefined) {
    return {
      ok: false,
      issues: [{ code: 'NO_SUCCESS_STATE', message: 'could not identify the success state' }],
    };
  }

  const steps: Step[] = [];
  let stepNumber = 0;

  for (const [segmentIndex, segment] of segments.entries()) {
    const ids = stateIdForScreen.get(segment.screen);
    const nextScreen = segments[segmentIndex + 1]?.screen ?? successScreen;

    for (const [stepIndex, recorded] of segment.steps.entries()) {
      stepNumber += 1;
      const isLastInSegment = stepIndex === segment.steps.length - 1;
      // A step id a reviewer can read. The control's accessible name when it has one, and
      // otherwise the label beside it - which for every form field on this application is the only
      // thing that identifies the field at all. Falling straight to the action type gives three
      // consecutive steps called "type", which is the moment an artifact stops being reviewable.
      const nearbyLabel =
        recorded.action.type === 'navigate'
          ? undefined
          : recorded.action.target.semantic.nearbyText?.[0];
      const stepId =
        'step-' +
        stepNumber +
        '-' +
        (slug(recorded.resolvedControlName) || slug(nearbyLabel ?? '') || recorded.action.type);

      // The LAST step of a segment leaves from the COMPLETE state when there is one: it is the
      // step that requires the screen to be filled in. Earlier steps in the segment are what put
      // it into that state, so they leave from the base.
      const fromState = isLastInSegment ? (ids?.complete ?? ids?.base) : ids?.base;
      const toState = isLastInSegment ? stateIdForScreen.get(nextScreen)?.base : undefined;

      const effects = expectedEffectsFor(run, recorded, stepId, runtimeValuesFor(run));
      const optionalParam = optionalParamOf(run, recorded);
      // AN INVARIANT MUST HOLD ON BOTH SIDES OF THE STEP, which for a step that changes screen
      // means both screens. The strong identity check - the cell beside the "Member ID" label -
      // holds on the member record and does not exist on the sub-account form, so a transition
      // step falls back to the weaker check that holds on both. Choosing it from the FROM screen
      // alone produces an artifact that distils cleanly and fails on the first replay, one step
      // after the one that is actually wrong.
      const invariantScreens = isLastInSegment ? [segment.screen, nextScreen] : [segment.screen];
      const identity =
        ids === undefined
          ? null
          : identityInvariant(run, invariantScreens, evaluator, run.spec.inputs);

      const step: Step = {
        id: stepId,
        intent: recorded.intent,
        action: recorded.action,
        ...(fromState === undefined ? {} : { fromState }),
        ...(toState === undefined ? {} : { toState }),
        expectedEffects: effects,
        invariants: identity === null ? [] : [{ ...identity, id: stepId + '.identity' }],
        wait: { timeoutMs: 10_000, pollMs: 100 },
        risk: stepRisk(recorded, safety),
        onFailure: recorded.changedScreen ? 'try_recoveries_then_fail' : 'fail',
        retries: { max: 1, backoffMs: [250] },
        // `intent` is the MODEL's account of why this control is the right one. `notes` is the
        // SYSTEM's account of how it was identified and which tier recorded it. A note that only
        // restates its neighbour is noise in the first document a reviewer reads, so it is omitted
        // when it would add nothing.
        ...(notesFor(recorded) === undefined ? {} : { notes: notesFor(recorded) }),
        // A step bound to an OPTIONAL parameter is conditional, and says so in the artifact.
        ...(optionalParam === undefined ? {} : { when: { paramPresent: optionalParam } }),
      };
      steps.push(step);

      // [MUST] The discriminating-effect rule, checked against the observations this very step
      // produced. Not a claim about the artifact: a measurement of the run that made it.
      const before = observationById(run, recorded.beforeObservationId);
      const after = observationById(run, recorded.afterObservationId);
      if (before === undefined || after === undefined) {
        issues.push({
          code: 'MISSING_OBSERVATION',
          message: 'step "' + stepId + '" references an observation that was not recorded',
        });
        continue;
      }
      issues.push(
        ...checkStepDiscrimination(
          step,
          before,
          after,
          evaluator,
          run.runtimeInputs,
          run.spec.inputs,
        ),
      );
    }
  }

  if (steps.length === 0) {
    return {
      ok: false,
      issues: [{ code: 'NO_STEPS', message: 'every recorded step was a no-op' }],
    };
  }

  // Every declared output has to have been bound during the run, and the record identity with it.
  // These are contract obligations, so a missing one is a refusal rather than a warning.
  const unbound = run.spec.outputs.filter(
    (declared) => !run.outputs.some((binding) => binding.name === declared.name),
  );
  for (const declared of unbound) {
    issues.push({
      code: 'OUTPUT_NOT_BOUND',
      message: 'declared output "' + declared.name + '" was never bound during the run',
    });
  }
  if (run.recordIdentity === null) {
    issues.push({
      code: 'RECORD_IDENTITY_NOT_BOUND',
      message: 'the record identity was never bound during the run',
    });
  }
  const identityBinding = run.recordIdentity;
  if (unbound.length > 0 || identityBinding === null) return { ok: false, issues };

  const outputs = run.spec.outputs.map((declared) => {
    const binding = run.outputs.find((candidate) => candidate.name === declared.name);
    const screen = binding === undefined ? successScreen : screenOf(run, binding.observationId);
    const ids = stateIdForScreen.get(screen);
    return {
      ...declared,
      source: {
        // The output belongs to a STATE, not a step position. Prefer the COMPLETE variant when the
        // screen has one: that is the state in which the value is actually there to be read.
        stateId: ids?.complete ?? ids?.base ?? successState,
        target: binding?.target ?? identityBinding.target,
        parse: binding?.parseAs ?? ('text' as const),
      },
    };
  });

  const firstScreen = segments[0]?.screen ?? successScreen;
  const risks = steps.map((step) => step.risk);
  const ceiling = maxRisk(...risks);
  if (RISK_ORDER[ceiling] >= RISK_ORDER.IRREVERSIBLE) {
    issues.push({
      code: 'IRREVERSIBLE_STEP',
      message: 'this run took an action classified IRREVERSIBLE. It cannot become a capability.',
    });
  }

  // [MUST, clarification 1] LOAD THE PROFILES, HASH THEM, WRITE THE PINS - and only then compute
  // the content hash. Approval VERIFIES these pins; it never introduces them. That ordering is
  // what makes the draft and the approved artifact hash identically.
  const conditionPin = profileHash(
    readFileSync(
      conditionProfilePath(
        configRoot,
        run.spec.conditionProfile.id,
        run.spec.conditionProfile.version,
      ),
      'utf8',
    ),
  );
  const safetyPin = profileHash(
    readFileSync(
      safetyProfilePath(configRoot, run.spec.safetyProfile.id, run.spec.safetyProfile.version),
      'utf8',
    ),
  );

  const draft = {
    schemaVersion: SCHEMA_VERSION,
    capabilityId: run.spec.capabilityId,
    name: run.spec.name,
    description: run.spec.description,
    capabilityVersion: options.capabilityVersion ?? '1.0.0',
    status: 'draft' as const,
    target: {
      product: run.spec.target.product,
      surfaceKind: 'legacy_web' as const,
      entryPoint: run.spec.target.entryPoint,
      compatibility: { versionRange: run.spec.target.compatibility.versionRange },
      fingerprint: [
        {
          kind: 'text' as const,
          // Truncated to major.minor on purpose: a patch release of the vendor product should not
          // fail a capability that never touched anything the patch changed.
          expected: truncateVersionMarker(
            observationById(run, run.successObservationId)?.screenIdentity.versionMarker ??
              run.spec.target.product,
          ),
        },
      ],
    },
    inputs: run.spec.inputs,
    outputs,
    recordIdentity: {
      param: run.spec.recordIdentity.param,
      target: identityBinding.target,
    },
    preconditions: [
      {
        description: 'The application is showing "' + firstScreen + '" when the capability starts.',
        check: {
          id: 'precondition.entry',
          kind: 'screen_identity' as const,
          expected: literal(firstScreen),
          description: 'the entry screen is "' + firstScreen + '"',
        },
      },
    ],
    states,
    steps,
    successState,
    profiles: {
      condition: {
        id: run.spec.conditionProfile.id,
        version: run.spec.conditionProfile.version,
        sha256: conditionPin,
      },
      safety: {
        id: run.spec.safetyProfile.id,
        version: run.spec.safetyProfile.version,
        sha256: safetyPin,
      },
    },
    policy: {
      maxRiskAllowed: ceiling,
      maxSteps: Math.max(steps.length * 2, 20),
      maxDurationMs: 120_000,
    },
    // Capability-specific ADDITIONS only. Conditions the run merely ENCOUNTERED are written to
    // /runs/<id>/proposed-conditions.json and never here: an artifact must not carry a "proposed
    // but maybe active" condition, because nobody reviewed it.
    knownOutcomes: [],
    recoveries: [],
    hardFailures: [],
    provenance: {
      discoveryRunId: run.runId,
      model: run.model,
      promptVersion: run.promptVersion,
      // goalTemplate only. No rendered goal, and no goalDigest.
      goalTemplate: run.spec.goalTemplate,
      specHash: run.specHash,
      createdAt: options.now?.() ?? new Date().toISOString(),
    },
  };

  const parsed = CapabilityArtifactSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: 'SCHEMA_INVALID',
        message: (issue.path.join('.') || '(root)') + ': ' + issue.message,
      });
    }
    return { ok: false, issues };
  }

  const artifact = parsed.data;

  issues.push(...validateArtifactStructure(artifact));

  // The values THIS run used, plus everything it read off the page. Both are runtime values, and
  // neither may be baked into a capability that is supposed to work for the next invocation.
  issues.push(...sweepParameterization({ artifact, runtimeValues: runtimeValuesFor(run) }));

  // Mutual exclusivity of resumable states, checked against every observation the run produced.
  issues.push(
    ...checkResumeEligibleExclusivity(
      artifact,
      run.observations,
      evaluator,
      run.runtimeInputs,
      run.spec.inputs,
    ),
  );

  issues.push(...reviewabilityLint(artifact));

  if (issues.length > 0) return { ok: false, issues };

  notes.push(
    'retained ' +
      segments.length +
      ' screen segments and ' +
      steps.length +
      ' steps from ' +
      run.steps.length +
      ' recorded actions',
  );
  notes.push('pinned ' + artifact.profiles.condition.id + ' and ' + artifact.profiles.safety.id);

  return { ok: true, artifact, notes };
}

/**
 * [MUST] REVIEWABILITY LINT.
 *
 * The artifact is going to be read by a person who was not there when it was recorded, and then
 * executed without a model. Anything they cannot check is a step nobody is checking.
 */
export function reviewabilityLint(artifact: CapabilityArtifact): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const step of artifact.steps) {
    if (step.intent.trim().length < 10) {
      issues.push({
        code: 'STEP_INTENT_TOO_THIN',
        message:
          'step "' +
          step.id +
          '" has no usable intent. A reviewer cannot tell whether this step ' +
          'is doing the right thing without one.',
      });
    }
    if (step.wait.timeoutMs <= 0 || step.wait.pollMs <= 0) {
      issues.push({
        code: 'STEP_WAIT_UNBOUNDED',
        message: 'step "' + step.id + '" does not declare a bounded wait',
      });
    }
    if (step.action.type === 'read') {
      // A read needs no transition. What it needs is a source that exists, which the schema and
      // the output binding already require - so this is the documented exemption, stated where
      // somebody looking for it will find it.
      continue;
    }
    if (step.expectedEffects.length === 0) {
      issues.push({
        code: 'STEP_HAS_NO_EFFECTS',
        message: 'step "' + step.id + '" changes state but proves nothing about it',
      });
    }
  }

  return issues;
}

/** "MERIDIAN Core v3.2.1" -> "MERIDIAN Core v3.2". */
function truncateVersionMarker(marker: string): string {
  const pattern = new RegExp('^(.*\\bv\\d+\\.\\d+)(?:\\.\\d+)?$');
  const match = pattern.exec(marker.trim());
  return match?.[1] ?? marker.trim();
}
