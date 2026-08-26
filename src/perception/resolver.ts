import {
  LOCATOR_TIER_ORDER,
  type LocatorTier,
  type NameMatch,
  type TargetDescriptor,
} from '../types/control.js';
import { foldCase, normalizeText } from '../types/normalize.js';
import type { Observation, PerceivedControl } from '../types/perception.js';
import type { Conflict, Resolution, ResolutionTrace, TierAttempt } from '../types/resolution.js';
import type { TargetResolver } from '../types/surface.js';

/**
 * ==============================================================================================
 * THE ONE RESOLVER.
 * ==============================================================================================
 *
 * Discovery uses it to check a descriptor before proposing to act on it. The input path uses it to
 * turn a descriptor into a control. Replay uses it for assertions and condition detectors. There
 * is no replay-only locator implementation and no second cascade; a second one would be a defect.
 *
 * It is PURE. Given the same Observation and the same descriptor it returns the same answer, with
 * no browser, no clock and no I/O. That is what makes the tier behaviour testable against a saved
 * capture, and it is why a resolution can be re-derived from evidence after the fact.
 */

function matchName(controlName: string, expected: string, mode: NameMatch): boolean {
  switch (mode) {
    case 'exact':
      return controlName === expected;
    case 'normalized':
      return foldCase(normalizeText(controlName)) === foldCase(normalizeText(expected));
    case 'contains':
      return foldCase(normalizeText(controlName)).includes(foldCase(normalizeText(expected)));
  }
}

function normalizedEqual(a: string, b: string): boolean {
  return foldCase(normalizeText(a)) === foldCase(normalizeText(b));
}

function normalizedContains(haystack: string, needle: string): boolean {
  return foldCase(normalizeText(haystack)).includes(foldCase(normalizeText(needle)));
}

function matchesContainers(control: PerceivedControl, descriptor: TargetDescriptor): boolean {
  const hints = descriptor.semantic.containerHints ?? [];
  return hints.every((hint) =>
    control.containers.some(
      (container) =>
        container.role === hint.role &&
        (hint.name === undefined ||
          (container.name !== undefined && normalizedContains(container.name, hint.name))),
    ),
  );
}

function matchesNearbyText(control: PerceivedControl, descriptor: TargetDescriptor): boolean {
  const wanted = descriptor.semantic.nearbyText ?? [];
  return wanted.every((text) =>
    control.nearbyText.some((actual) => normalizedContains(actual, text)),
  );
}

function matchesStableAttributes(control: PerceivedControl, descriptor: TargetDescriptor): boolean {
  const wanted = descriptor.adapterHints?.web?.stableAttribute ?? {};
  const entries = Object.entries(wanted);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => control.stableAttributes[key] === value);
}

function matchesRowKey(control: PerceivedControl, expectedCellText: string): boolean {
  return (control.rowCellTexts ?? []).some((cell) => normalizedEqual(cell, expectedCellText));
}

/**
 * ==============================================================================================
 * [MUST] A ROW KEY IS A CONSTRAINT ON EVERY TIER, NOT A TIER OF ITS OWN.
 * ==============================================================================================
 *
 * A descriptor that says "the Open link in the row keyed by memberId" must NEVER be satisfiable by
 * an Open link in a different row, whichever tier located the candidate.
 *
 * The failure this prevents is quiet and specific. A search for one member returns one row, so
 * role-plus-name resolves the link uniquely at T1 - and if the application returned a DIFFERENT
 * member than the one requested, T1 would happily resolve to it, because the row key was never
 * consulted. The click lands on the wrong record.
 *
 * It is not enough to rely on a later invariant to catch that. Whether any such invariant fires
 * depends on the shape of the next step and on execution order; correctness here must not be
 * contingent on either.
 *
 * An UNBOUND row key (still `{kind:'param'}`) satisfies nothing. The resolver refuses to guess
 * which row was meant rather than falling back to a descriptor that ignores the row entirely.
 */
function satisfiesRowKey(control: PerceivedControl, descriptor: TargetDescriptor): boolean {
  const key = descriptor.semantic.rowKey?.cellText;
  if (key === undefined) return true;
  if (key.kind !== 'literal') return false;
  return matchesRowKey(control, key.value);
}

/**
 * Narrow a multi-candidate tier result using the descriptor REMAINING evidence.
 *
 * Deliberately excludes rowKey: that is T5 own primary evidence, and folding it in here would
 * report a structural-row resolution as a T1 hit, hiding the fact that the only thing that
 * identified the control was its row.
 *
 * `ordinal` is applied last and only last. It is positional, and position is the weakest thing in
 * the descriptor.
 */
function disambiguate(
  candidates: readonly PerceivedControl[],
  descriptor: TargetDescriptor,
): readonly PerceivedControl[] {
  let narrowed = candidates;

  if ((descriptor.semantic.containerHints ?? []).length > 0) {
    narrowed = narrowed.filter((control) => matchesContainers(control, descriptor));
  }
  if ((descriptor.semantic.nearbyText ?? []).length > 0) {
    narrowed = narrowed.filter((control) => matchesNearbyText(control, descriptor));
  }
  if (narrowed.length > 1 && descriptor.semantic.ordinal !== undefined) {
    const picked = narrowed[descriptor.semantic.ordinal];
    narrowed = picked === undefined ? [] : [picked];
  }

  return narrowed;
}

interface TierDefinition {
  tier: LocatorTier;
  /** A tier with no evidence to work from is not attempted, and does not appear in the trace. */
  applicable: (descriptor: TargetDescriptor) => boolean;
  candidates: (
    controls: readonly PerceivedControl[],
    descriptor: TargetDescriptor,
  ) => readonly PerceivedControl[];
}

const TIERS: readonly TierDefinition[] = [
  {
    tier: 'T1_EXACT_ROLE_NAME',
    applicable: (descriptor) => descriptor.semantic.name !== undefined,
    candidates: (controls, descriptor) =>
      controls.filter(
        (control) =>
          control.role === descriptor.semantic.role &&
          control.name !== '' &&
          matchName(control.name, descriptor.semantic.name ?? '', descriptor.semantic.nameMatch),
      ),
  },
  {
    tier: 'T2_NORMALIZED_IN_CONTAINER',
    applicable: (descriptor) =>
      descriptor.semantic.name !== undefined &&
      (descriptor.semantic.containerHints ?? []).length > 0,
    candidates: (controls, descriptor) =>
      controls.filter(
        (control) =>
          control.role === descriptor.semantic.role &&
          normalizedEqual(control.name, descriptor.semantic.name ?? '') &&
          matchesContainers(control, descriptor),
      ),
  },
  {
    tier: 'T3_EXTERNAL_LABEL_OR_NEARBY',
    applicable: (descriptor) => (descriptor.semantic.nearbyText ?? []).length > 0,
    candidates: (controls, descriptor) =>
      controls.filter(
        (control) =>
          control.role === descriptor.semantic.role && matchesNearbyText(control, descriptor),
      ),
  },
  {
    tier: 'T4_STABLE_ATTRIBUTE',
    applicable: (descriptor) =>
      Object.keys(descriptor.adapterHints?.web?.stableAttribute ?? {}).length > 0,
    candidates: (controls, descriptor) =>
      controls.filter(
        (control) =>
          control.role === descriptor.semantic.role && matchesStableAttributes(control, descriptor),
      ),
  },
  {
    tier: 'T5_STRUCTURAL_ROW',
    applicable: (descriptor) => descriptor.semantic.rowKey?.cellText.kind === 'literal',
    candidates: (controls, descriptor) => {
      const key = descriptor.semantic.rowKey?.cellText;
      if (key === undefined || key.kind !== 'literal') return [];
      const inRow = controls.filter(
        (control) => control.role === descriptor.semantic.role && matchesRowKey(control, key.value),
      );
      // Within the identified row, the accessible name still narrows further when we have one.
      if (descriptor.semantic.name === undefined) return inRow;
      const named = inRow.filter((control) =>
        matchName(control.name, descriptor.semantic.name ?? '', descriptor.semantic.nameMatch),
      );
      return named.length > 0 ? named : inRow;
    },
  },
];

/**
 * Stable-attribute matches IGNORING the declared role.
 *
 * Used only by the conflict check, never to resolve. The two have opposite jobs: conflict
 * detection should be as SENSITIVE as possible, because its output is "stop and tell someone",
 * while resolution should be as CONSERVATIVE as possible, because its output is "act". If the
 * attribute now points at a control of a different role than the contract declares, that is
 * precisely the disagreement worth catching, and a role filter would hide it.
 */
function attributeMatchesIgnoringRole(
  controls: readonly PerceivedControl[],
  descriptor: TargetDescriptor,
): readonly PerceivedControl[] {
  return controls.filter((control) => matchesStableAttributes(control, descriptor));
}

function tierRank(tier: LocatorTier): number {
  return LOCATOR_TIER_ORDER.indexOf(tier);
}

export class DefaultTargetResolver implements TargetResolver {
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => performance.now());
  }

  resolve(observation: Observation, descriptor: TargetDescriptor): Resolution {
    const attempts: TierAttempt[] = [];
    const conflicts: Conflict[] = [];
    const controls = observation.controls;

    const finish = (tierUsed: LocatorTier | null): ResolutionTrace => ({
      observationId: observation.observationId,
      tiersAttempted: attempts,
      tierUsed,
      conflicts,
      downgraded: tierUsed !== null && tierRank(tierUsed) > tierRank(descriptor.recordedTier),
    });

    // ------------------------------------------------------------------------------------------
    // THE CONFLICT RULE, checked BEFORE the cascade.
    //
    // Role plus accessible name and the legacy `name=` attribute are INDEPENDENT signals: one comes
    // from what the screen says, the other from what the server calls the field. When both are
    // unambiguous and they disagree, we have positive evidence that one of them points at the
    // wrong control, and nothing in the data says which. Accepting the earlier tier would mean
    // acting on a control we already know might be the wrong one. In a banking application that is
    // not a trade worth making, so we stop instead.
    // ------------------------------------------------------------------------------------------
    const byRoleName = TIERS[0]?.candidates(controls, descriptor) ?? [];
    const byAttribute = attributeMatchesIgnoringRole(controls, descriptor);
    const roleNameHit = byRoleName.length === 1 ? byRoleName[0] : undefined;
    const attributeHit = byAttribute.length === 1 ? byAttribute[0] : undefined;

    if (
      roleNameHit !== undefined &&
      attributeHit !== undefined &&
      roleNameHit.markId !== attributeHit.markId
    ) {
      const detail =
        'role+name resolved to mark ' +
        roleNameHit.markId +
        ' ("' +
        roleNameHit.name +
        '") but the stable attribute resolved to mark ' +
        attributeHit.markId +
        ' ("' +
        attributeHit.name +
        '")';
      conflicts.push({
        tierA: 'T1_EXACT_ROLE_NAME',
        tierB: 'T4_STABLE_ATTRIBUTE',
        markIdA: roleNameHit.markId,
        markIdB: attributeHit.markId,
        detail,
      });
      return { ok: false, error: 'LOCATOR_CONFLICT', detail, trace: finish(null) };
    }

    let sawAmbiguity = false;

    for (const definition of TIERS) {
      if (!definition.applicable(descriptor)) continue;

      const started = this.#now();
      // The row key filters EVERY tier's candidates, before disambiguation and before any tier
      // gets to claim a unique hit. See satisfiesRowKey above.
      let candidates: readonly PerceivedControl[] = definition
        .candidates(controls, descriptor)
        .filter((control) => satisfiesRowKey(control, descriptor));
      if (candidates.length > 1) candidates = disambiguate(candidates, descriptor);
      const elapsed = this.#now() - started;

      attempts.push({
        tier: definition.tier,
        candidateCount: candidates.length,
        ms: Math.max(0, elapsed),
      });

      const only = candidates.length === 1 ? candidates[0] : undefined;
      if (only !== undefined) {
        // When a row key is in play it is PART of what identified the control, whichever predicate
        // located the candidate. Reporting T1 because role-plus-name happened to be unique on a
        // one-row screen would misdescribe what the descriptor depends on - and `recordedTier` is
        // what replay compares against to raise a drift signal, so getting it wrong makes a real
        // downgrade read as normal operation. See DECISIONS.md D26.
        const structural = descriptor.semantic.rowKey !== undefined;
        return {
          ok: true,
          control: only,
          trace: finish(structural ? 'T5_STRUCTURAL_ROW' : definition.tier),
        };
      }
      if (candidates.length > 1) sawAmbiguity = true;
    }

    if (descriptor.semantic.rowKey?.cellText.kind === 'param') {
      return {
        ok: false,
        error: 'CONTROL_NOT_FOUND',
        detail:
          'rowKey is still parameterized (' +
          descriptor.semantic.rowKey.cellText.name +
          '). Bind invocation values with bindDescriptor() before resolving.',
        trace: finish(null),
      };
    }

    if (sawAmbiguity) {
      return {
        ok: false,
        error: 'AMBIGUOUS_CONTROL',
        detail:
          'more than one control matched and the descriptor carried nothing further to separate ' +
          'them. Guessing between them is the worst available behaviour, so the action stops here.',
        trace: finish(null),
      };
    }

    return {
      ok: false,
      error: 'CONTROL_NOT_FOUND',
      detail:
        'no ' +
        descriptor.semantic.role +
        ' matched on screen "' +
        observation.screenIdentity.canonicalScreenName +
        '"',
      trace: finish(null),
    };
  }
}
