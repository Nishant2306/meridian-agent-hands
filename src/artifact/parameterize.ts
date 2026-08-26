import { foldCase, normalizeText } from '../types/normalize.js';
import type { Assertion } from '../types/assertion.js';
import type { CapabilityArtifact } from './schema.js';
import type { ValidationIssue } from './validate.js';

/**
 * ==============================================================================================
 * [MUST] PARAMETERIZATION SCOPE: FOUR CLASSES, AND ONLY ONE OF THEM FAILS.
 * ==============================================================================================
 *
 * "No invocation value may appear anywhere in the artifact" is literally impossible to satisfy.
 * `Savings` is an invocation value AND a declared member of the accountType enum. A sweep that
 * rejected it would reject every correct artifact this system can produce.
 *
 * So every literal is classified:
 *
 *   (a) CONTRACT CONSTANT        a declared enum value, a declared pattern, static application
 *                                text the contract itself names               -> ALLOWED
 *   (b) PARAMETER BINDING        { kind: param, name } - not a literal at all  -> ALLOWED
 *   (c) REVIEWED STATIC LITERAL  an expected heading, a screen name            -> ALLOWED
 *   (d) RUNTIME INVOCATION VALUE                                               -> REJECT
 *
 * Class (d) FAILS CLOSED. A literal that equals a runtime value and is not a declared constant
 * means the distiller produced a capability that only works for this one invocation, and shipping
 * that quietly is worse than refusing to ship it.
 *
 * The swept sites are ENUMERATED rather than discovered by walking the whole object, because a
 * blanket walk cannot tell class (c) from class (d): both are strings in the same kind of field.
 *
 * ==============================================================================================
 * CLASS (e): MODEL-AUTHORED PROSE. ADDED AFTER GATE 1, WHERE IT LEAKED.
 * ==============================================================================================
 *
 * GATE 1 produced an artifact that passed distillation, passed approval, and contained:
 *
 *     steps[2].intent
 *       "Click 'Open' link in the search results row for member 10001 (Avery Lin) to open the
 *        member record."
 *     steps[2].expectedEffects[0].description
 *       "Navigated from Member Search to Member Record screen for member 10001 (Avery Lin), ..."
 *
 * A runtime member id and a member's name, in an approved, content-hashed capability.
 *
 * The sweep did not miss a site it knew about. It covered every place a value can be BOUND -
 * action values, navigate segments, row keys, expected values, hints, output patterns, provenance -
 * and the guarantee held at every one of them. What nobody considered is that the model writes
 * PROSE, and a model narrates what it sees. The value was never bound anywhere; it was described.
 *
 * REFUSAL, NEVER A SCRUB. A rewritten `intent` is a step whose recorded reasoning no longer says
 * what the model meant, which quietly destroys the thing `intent` exists for - a reviewer checking
 * the stated reason against the action. So prose containing a runtime value fails the artifact and
 * the run is re-done with a prompt that tells the model the rule.
 *
 * SUBSTRING, AND DELIBERATELY BLUNT. Prose embeds values inside sentences, so this matches on
 * containment rather than equality, and it will occasionally refuse an artifact over a coincidence
 * (a member id that happens to appear inside a longer number). That direction is the correct one:
 * a false refusal costs a re-run, and a false pass ships a member's name inside a reusable
 * capability.
 *
 * NEARBY TEXT IS DIFFERENT, AND IT IS NOT A REJECTION IN THE NORMAL CASE. A hint that CONTAINS a
 * runtime value is DROPPED when the descriptor is built, not parameterized. Dynamic contextual
 * text turned into a locator hint becomes over-permissive. Anything reaching this sweep with a
 * runtime value still in a hint is a BUG in descriptor construction, so it fails closed here as a
 * backstop.
 */
export interface SweptLiteral {
  path: string;
  value: string;
}

export interface SweepInput {
  artifact: CapabilityArtifact;
  /** Values from the invocation, plus values read off the page during the run. */
  runtimeValues: readonly string[];
}

function isRuntimeValue(text: string, runtimeValues: readonly string[]): boolean {
  const needle = foldCase(normalizeText(text));
  if (needle === '') return false;
  return runtimeValues.some((value) => foldCase(normalizeText(value)) === needle);
}

function containsRuntimeValue(text: string, runtimeValues: readonly string[]): boolean {
  const haystack = foldCase(normalizeText(text));
  if (haystack === '') return false;
  return runtimeValues.some((value) => {
    const needle = foldCase(normalizeText(value));
    return needle !== '' && haystack.includes(needle);
  });
}

/** Which runtime values appear inside this text. Empty when none do. */
function runtimeValuesInside(text: string, runtimeValues: readonly string[]): string[] {
  const haystack = foldCase(normalizeText(text));
  if (haystack === '') return [];
  const found = new Set<string>();
  for (const value of runtimeValues) {
    const needle = foldCase(normalizeText(value));
    if (needle !== '' && haystack.includes(needle)) found.add(value);
  }
  return [...found];
}

/** Class (a): every value the DECLARED CONTRACT itself names. */
export function contractConstants(artifact: CapabilityArtifact): Set<string> {
  const allowed = new Set<string>();
  for (const input of artifact.inputs) {
    for (const value of input.values ?? []) allowed.add(foldCase(normalizeText(value)));
  }
  for (const output of artifact.outputs) {
    for (const value of output.values ?? []) allowed.add(foldCase(normalizeText(value)));
  }
  return allowed;
}

function assertionLiterals(assertions: readonly Assertion[], path: string): SweptLiteral[] {
  const found: SweptLiteral[] = [];
  assertions.forEach((assertion, index) => {
    const expected = assertion.expected;
    if (expected !== undefined && expected.kind === 'literal') {
      found.push({ path: path + '[' + index + '].expected', value: expected.value });
    }
    const rowKey = assertion.target?.semantic.rowKey?.cellText;
    if (rowKey !== undefined && rowKey.kind === 'literal') {
      found.push({ path: path + '[' + index + '].target.rowKey', value: rowKey.value });
    }
  });
  return found;
}

function assertionHints(assertions: readonly Assertion[], path: string): SweptLiteral[] {
  const found: SweptLiteral[] = [];
  assertions.forEach((assertion, index) => {
    for (const hint of assertion.target?.semantic.nearbyText ?? []) {
      found.push({ path: path + '[' + index + '].target.nearbyText', value: hint });
    }
  });
  return found;
}

/**
 * Every free-text field written by the MODEL or derived from what it said.
 *
 * Enumerated, like the rest of the sweep, rather than found by walking every string in the object.
 * A blanket walk would also pick up the capability name and description, the input and output
 * descriptions, and the condition labels - all of which come from the human-authored DiscoverySpec
 * and are reviewed before a run ever happens. Sweeping those would report a spec author's own
 * wording back at them as a leak.
 */
export function modelAuthoredProse(artifact: CapabilityArtifact): SweptLiteral[] {
  const found: SweptLiteral[] = [];

  const fromAssertions = (assertions: readonly Assertion[], path: string): void => {
    assertions.forEach((assertion, index) => {
      found.push({ path: path + '[' + index + '].description', value: assertion.description });
    });
  };

  artifact.steps.forEach((step, index) => {
    const base = 'steps[' + index + '](' + step.id + ')';
    found.push({ path: base + '.intent', value: step.intent });
    if (step.notes !== undefined) found.push({ path: base + '.notes', value: step.notes });
    fromAssertions(step.expectedEffects, base + '.expectedEffects');
    fromAssertions(step.invariants, base + '.invariants');
  });

  artifact.states.forEach((state, index) => {
    const base = 'states[' + index + '](' + state.id + ')';
    if (state.description !== undefined) {
      found.push({ path: base + '.description', value: state.description });
    }
    fromAssertions(state.screenAssertions, base + '.screenAssertions');
    fromAssertions(state.qualifiers, base + '.qualifiers');
    fromAssertions(state.invariants, base + '.invariants');
  });

  artifact.preconditions.forEach((precondition, index) => {
    const base = 'preconditions[' + index + ']';
    found.push({ path: base + '.description', value: precondition.description });
    fromAssertions([precondition.check], base + '.check');
  });

  return found;
}

/** Every site a runtime value could hide in, named explicitly. */
export function sweptLiterals(artifact: CapabilityArtifact): {
  strict: SweptLiteral[];
  hints: SweptLiteral[];
} {
  const strict: SweptLiteral[] = [];
  const hints: SweptLiteral[] = [];

  const collectTarget = (
    target: CapabilityArtifact['recordIdentity']['target'],
    path: string,
  ): void => {
    for (const hint of target.semantic.nearbyText ?? []) {
      hints.push({ path: path + '.nearbyText', value: hint });
    }
    if (target.semantic.name !== undefined) {
      strict.push({ path: path + '.name', value: target.semantic.name });
    }
    const rowKey = target.semantic.rowKey?.cellText;
    if (rowKey !== undefined && rowKey.kind === 'literal') {
      strict.push({ path: path + '.rowKey', value: rowKey.value });
    }
  };

  artifact.steps.forEach((step, index) => {
    const base = 'steps[' + index + ']';
    if (step.action.type === 'navigate') {
      step.action.pathSegments.forEach((segment, position) => {
        if (segment.kind === 'literal') {
          strict.push({ path: base + '.pathSegments[' + position + ']', value: segment.value });
        }
      });
    } else {
      collectTarget(step.action.target, base + '.action.target');
      if ('value' in step.action && step.action.value.kind === 'literal') {
        strict.push({ path: base + '.action.value', value: step.action.value.value });
      }
    }
    strict.push(...assertionLiterals(step.expectedEffects, base + '.expectedEffects'));
    strict.push(...assertionLiterals(step.invariants, base + '.invariants'));
    hints.push(...assertionHints(step.expectedEffects, base + '.expectedEffects'));
    hints.push(...assertionHints(step.invariants, base + '.invariants'));
  });

  artifact.states.forEach((state, index) => {
    const base = 'states[' + index + '](' + state.id + ')';
    for (const [group, name] of [
      [state.screenAssertions, '.screenAssertions'],
      [state.qualifiers, '.qualifiers'],
      [state.invariants, '.invariants'],
    ] as const) {
      strict.push(...assertionLiterals(group, base + name));
      hints.push(...assertionHints(group, base + name));
    }
  });

  artifact.preconditions.forEach((precondition, index) => {
    strict.push(...assertionLiterals([precondition.check], 'preconditions[' + index + ']'));
    hints.push(...assertionHints([precondition.check], 'preconditions[' + index + ']'));
  });

  artifact.outputs.forEach((output, index) => {
    const base = 'outputs[' + index + '](' + output.name + ')';
    collectTarget(output.source.target, base + '.source.target');
    if (output.source.pattern !== undefined) {
      strict.push({ path: base + '.source.pattern', value: output.source.pattern });
    }
  });

  collectTarget(artifact.recordIdentity.target, 'recordIdentity.target');

  strict.push({ path: 'provenance.goalTemplate', value: artifact.provenance.goalTemplate });
  strict.push({ path: 'target.entryPoint', value: artifact.target.entryPoint });
  for (const fingerprint of artifact.target.fingerprint) {
    strict.push({ path: 'target.fingerprint', value: fingerprint.expected });
  }

  return { strict, hints };
}

export function sweepParameterization(input: SweepInput): ValidationIssue[] {
  const allowed = contractConstants(input.artifact);
  const { strict, hints } = sweptLiterals(input.artifact);
  const issues: ValidationIssue[] = [];

  for (const literal of strict) {
    if (!isRuntimeValue(literal.value, input.runtimeValues)) continue;
    if (allowed.has(foldCase(normalizeText(literal.value)))) continue;
    issues.push({
      code: 'RUNTIME_VALUE_IN_ARTIFACT',
      message:
        literal.path +
        ' is the literal "' +
        literal.value +
        '", which is a value from THIS ' +
        'invocation and is not a declared contract constant. The capability would only work for ' +
        'this one input.',
    });
  }

  for (const prose of modelAuthoredProse(input.artifact)) {
    for (const value of runtimeValuesInside(prose.value, input.runtimeValues)) {
      // "of type Savings" is prose containing a runtime value that is ALSO a declared enum member.
      // Refusing that would refuse every correct artifact this system can produce.
      if (allowed.has(foldCase(normalizeText(value)))) continue;
      issues.push({
        code: 'RUNTIME_VALUE_IN_PROSE',
        message:
          prose.path +
          ' contains the runtime value "' +
          value +
          '". Model-authored text is stored in the artifact and must describe the step by ' +
          'PARAMETER NAME, not by the values of one invocation. This is a refusal and not a ' +
          'rewrite: an edited intent no longer records what the model meant. Re-run discovery.',
      });
    }
  }

  for (const hint of hints) {
    if (!containsRuntimeValue(hint.value, input.runtimeValues)) continue;
    issues.push({
      code: 'RUNTIME_VALUE_IN_LOCATOR_HINT',
      message:
        hint.path +
        ' contains the runtime value "' +
        hint.value +
        '". Hints that mention runtime ' +
        'values must be DROPPED when the descriptor is built, never parameterized.',
    });
  }

  return issues;
}
