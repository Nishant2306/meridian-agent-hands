import { foldCase, normalizeText } from '../types/normalize.js';
import type { ControlRole, TargetDescriptor } from '../types/control.js';
import type { Observation, PerceivedControl } from '../types/perception.js';
import type { TargetResolver } from '../types/surface.js';
import { bindDescriptor } from '../perception/bind.js';

/**
 * ==============================================================================================
 * TURNING A MARK INTO A DESCRIPTOR.
 * ==============================================================================================
 *
 * This is the step where the model's choice stops being a number and becomes something that has to
 * survive a restart, a re-render and a different tenant. It is also where a runtime value could
 * most easily be baked into a capability by accident, so the rules are explicit:
 *
 *   1  INTERACTIVE controls are identified by their accessible NAME. That is what a person reads
 *      and what the accessibility tree is for.
 *
 *   2  CELLS AND TEXT are identified by their NEARBY LABEL, never by their own text. The name of a
 *      cell IS the value it displays - "Avery Lin", "$250.00", "10001". Identifying the member-name
 *      cell as `role=cell name="Avery Lin"` would produce a capability that only works for Avery
 *      Lin, and would write a member's name into a stored artifact.
 *
 *   3  A control whose NAME equals a runtime value is treated as rule 2, whatever its role.
 *
 *   4  Ambiguity is resolved by the ROW KEY first. Four links named "Open" are separated by the
 *      member id in their row, and that id is PARAMETERIZED, so the descriptor says "the row for
 *      whichever member we were asked about" rather than "the row for 10001".
 *
 *   5  Only if none of that works does ordinal position get used, and it is recorded as such.
 */

const INTERACTIVE: ReadonlySet<ControlRole> = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
]);

export interface DescriptorContext {
  observation: Observation;
  resolver: TargetResolver;
  /** Every value that came from the invocation, or was read off the page during this run. */
  runtimeValues: readonly string[];
  /** Invocation parameter name -> value, for parameterizing a row key. */
  runtimeInputs: Readonly<Record<string, string>>;
}

function equalsRuntimeValue(text: string, values: readonly string[]): boolean {
  const needle = foldCase(normalizeText(text));
  if (needle === '') return false;
  return values.some((value) => foldCase(normalizeText(value)) === needle);
}

export function containsRuntimeValue(text: string, values: readonly string[]): boolean {
  const haystack = foldCase(normalizeText(text));
  if (haystack === '') return false;
  return values.some((value) => {
    const needle = foldCase(normalizeText(value));
    return needle !== '' && haystack.includes(needle);
  });
}

/** Hints that mention a runtime value are DROPPED, never parameterized. */
function safeNearbyText(control: PerceivedControl, values: readonly string[]): string[] {
  return control.nearbyText.filter((hint) => !containsRuntimeValue(hint, values));
}

function adapterHints(control: PerceivedControl): TargetDescriptor['adapterHints'] {
  const stable = control.stableAttributes['name'];
  const web: NonNullable<TargetDescriptor['adapterHints']>['web'] = {
    contextPath: [...control.contextPath],
    ...(stable === undefined || stable === '' ? {} : { stableAttribute: { name: stable } }),
  };
  return { web };
}

/**
 * Does this descriptor pick out THIS control, and only this control?
 *
 * The descriptor is BOUND to the invocation's values first. A parameterized row key is still
 * `{ kind: 'param' }` at this point, and the resolver refuses to resolve one rather than guessing -
 * so without binding, every row-keyed candidate would fail validation and be silently discarded in
 * favour of a weaker descriptor that happens to work on this one screen.
 */
function resolvesUniquely(
  descriptor: TargetDescriptor,
  control: PerceivedControl,
  context: DescriptorContext,
): boolean {
  const resolution = context.resolver.resolve(
    context.observation,
    bindDescriptor(descriptor, context.runtimeInputs),
  );
  return resolution.ok && resolution.control.markId === control.markId;
}

/** The row cell that identifies this row AND corresponds to an invocation parameter, if any. */
function parameterizableRowKey(
  control: PerceivedControl,
  context: DescriptorContext,
): { param: string } | null {
  for (const cell of control.rowCellTexts ?? []) {
    for (const [param, value] of Object.entries(context.runtimeInputs)) {
      if (foldCase(normalizeText(cell)) === foldCase(normalizeText(value))) return { param };
    }
  }
  return null;
}

/**
 * ================================================================================================
 * [MUST] THE SYNTHESIS INVARIANT.
 * ================================================================================================
 *
 * A descriptor synthesized from a perceived control MUST resolve back to THAT control, against the
 * observation it was synthesized from. If it does not, the bug is in synthesis, and it must say so.
 *
 * Why this is a throw and not a rejection. A synthesized descriptor that cannot find its own
 * control is not a fact about the screen, it is a fact about this code. Handing it onward as
 * CONTROL_NOT_FOUND tells the model the control vanished, which sends it hunting for a screen
 * problem that does not exist - and, at GATE 1, it did exactly that: four identical retries
 * against an unchanged screen before the repeated-action rule stopped the run.
 *
 * `buildDescriptor` only ever returns an attempt it has already validated, so this cannot fire
 * today. That is the point: it is a guard against a future edit that adds an attempt and forgets
 * to validate it, and it fails at the place with enough context to name the control AND the
 * descriptor.
 */
export class DescriptorSynthesisError extends Error {
  readonly control: PerceivedControl;
  readonly descriptor: TargetDescriptor;

  constructor(control: PerceivedControl, descriptor: TargetDescriptor, detail: string) {
    super(
      'SYNTHESIS BUG: the descriptor built for mark ' +
        control.markId +
        ' (' +
        control.role +
        ' "' +
        control.name +
        '") does not resolve back to it in the observation it was built from. ' +
        detail +
        String.fromCharCode(10) +
        '  control:    ' +
        JSON.stringify({
          markId: control.markId,
          role: control.role,
          name: control.name,
          nearbyText: control.nearbyText,
        }) +
        String.fromCharCode(10) +
        '  descriptor: ' +
        JSON.stringify(descriptor.semantic),
    );
    this.name = 'DescriptorSynthesisError';
    this.control = control;
    this.descriptor = descriptor;
  }
}

export interface BuiltDescriptor {
  descriptor: TargetDescriptor;
  /** Why the descriptor looks the way it does. Recorded in the transcript, not in the artifact. */
  rationale: string;
}

export function buildDescriptor(
  control: PerceivedControl,
  context: DescriptorContext,
): BuiltDescriptor | { error: string } {
  const nearby = safeNearbyText(control, context.runtimeValues);
  const nameIsAValue = equalsRuntimeValue(control.name, context.runtimeValues);
  const useName = INTERACTIVE.has(control.role) && control.name !== '' && !nameIsAValue;

  const hints = adapterHints(control);
  const attempts: { descriptor: TargetDescriptor; rationale: string }[] = [];

  if (useName) {
    // THE ROW KEY COMES FIRST when there is one, even though the name alone may resolve uniquely
    // on THIS screen. A search for one member returns one row, so "the link named Open" is
    // unambiguous today and wrong on the next invocation that returns four. The descriptor has to
    // say WHICH ROW, and say it as a parameter rather than as this member's id.
    const rowKey = parameterizableRowKey(control, context);
    if (rowKey !== null) {
      attempts.push({
        descriptor: {
          semantic: {
            role: control.role,
            name: control.name,
            nameMatch: 'exact',
            rowKey: { cellText: { kind: 'param', name: rowKey.param } },
          },
          adapterHints: hints,
          recordedTier: 'T5_STRUCTURAL_ROW',
        },
        rationale:
          'accessible name "' +
          control.name +
          '" within the row identified by {{' +
          rowKey.param +
          '}}',
      });
    }

    attempts.push({
      descriptor: {
        semantic: { role: control.role, name: control.name, nameMatch: 'exact' },
        adapterHints: hints,
        recordedTier: 'T1_EXACT_ROLE_NAME',
      },
      rationale: 'accessible name "' + control.name + '"',
    });

    if (nearby.length > 0) {
      attempts.push({
        descriptor: {
          semantic: {
            role: control.role,
            name: control.name,
            nameMatch: 'exact',
            nearbyText: nearby.slice(0, 2),
          },
          adapterHints: hints,
          recordedTier: 'T3_EXTERNAL_LABEL_OR_NEARBY',
        },
        rationale: 'accessible name plus nearby label',
      });
    }
  }

  // The label to the left. For a cell this is the ONLY safe identification; for an unnamed input
  // it is the only identification at all.
  for (let depth = 1; depth <= Math.min(nearby.length, 2); depth += 1) {
    attempts.push({
      descriptor: {
        semantic: {
          role: control.role,
          nameMatch: 'normalized',
          nearbyText: nearby.slice(0, depth),
        },
        adapterHints: hints,
        recordedTier: 'T3_EXTERNAL_LABEL_OR_NEARBY',
      },
      rationale:
        'nearby label ' +
        nearby
          .slice(0, depth)
          .map((hint) => '"' + hint + '"')
          .join(' + '),
    });
  }

  const stable = control.stableAttributes['name'];
  if (stable !== undefined && stable !== '') {
    attempts.push({
      descriptor: {
        semantic: { role: control.role, nameMatch: 'normalized' },
        adapterHints: hints,
        recordedTier: 'T4_STABLE_ATTRIBUTE',
      },
      rationale: 'legacy-stable name attribute "' + stable + '"',
    });
  }

  for (const attempt of attempts) {
    if (!resolvesUniquely(attempt.descriptor, control, context)) continue;

    const resolution = context.resolver.resolve(
      context.observation,
      bindDescriptor(attempt.descriptor, context.runtimeInputs),
    );

    // The tier that ACTUALLY resolved it is what gets recorded, not the tier we hoped for. That
    // is what makes a later downgrade a meaningful drift signal rather than noise.
    //
    // A descriptor carrying a row key always comes back as T5_STRUCTURAL_ROW, because the resolver
    // applies the row key as a constraint on every tier and reports the structural tier whenever
    // one is in play. That is deliberate: on a screen where the search returned a single row,
    // role-plus-name alone would be unique, and recording T1 would misdescribe what the descriptor
    // depends on. See DECISIONS.md D26.
    const recordedTier =
      resolution.ok && resolution.trace.tierUsed !== null
        ? resolution.trace.tierUsed
        : attempt.descriptor.recordedTier;

    const descriptor = { ...attempt.descriptor, recordedTier };

    // The invariant, checked on the object that is actually RETURNED. The validated attempt and
    // the returned descriptor are not the same object: `recordedTier` is rewritten above, and a
    // future field could matter to resolution in a way `recordedTier` does not.
    const back = context.resolver.resolve(
      context.observation,
      bindDescriptor(descriptor, context.runtimeInputs),
    );
    if (!back.ok) {
      throw new DescriptorSynthesisError(control, descriptor, 'Resolution failed: ' + back.detail);
    }
    if (back.control.markId !== control.markId) {
      throw new DescriptorSynthesisError(
        control,
        descriptor,
        'It resolved to mark ' + back.control.markId + ' instead.',
      );
    }

    return {
      descriptor,
      rationale: attempt.rationale + ', recorded at ' + recordedTier,
    };
  }

  // No ordinal fallback. Position is the weakest thing a descriptor can carry, and a capability
  // that depends on it is one row-order change away from operating on the wrong record. If nothing
  // above identified the control, the honest answer is that this control is not addressable.
  return {
    error:
      'could not build a descriptor for the ' +
      control.role +
      ' "' +
      control.name +
      '" that ' +
      'resolves to it uniquely. Nearby labels: ' +
      (nearby.length > 0 ? nearby.join(' | ') : '(none)'),
  };
}
