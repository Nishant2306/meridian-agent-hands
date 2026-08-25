import type { DiscoveryRunRecord, RecordedStep } from '../types/discovery.js';
import { observationById } from '../types/discovery.js';

/**
 * ==============================================================================================
 * [MUST] PATH RECONSTRUCTION IS SEGMENT-BASED. A STATE-ONLY BACKWARD WALK IS WRONG.
 * ==============================================================================================
 *
 * The tempting algorithm is "drop any action whose resulting state was already visited". It is
 * wrong, and it is wrong in a way that does not look like a distiller bug when it bites.
 *
 * Three field fills on the sub-account form all leave you on the sub-account form. A state-only
 * backward walk sees three actions with the same resulting state, calls two of them redundant, and
 * DELETES TWO OF THREE FILLS. The artifact still distils, still validates, and still looks
 * plausible. Replay then fails on Continue, because the application rejects a half-filled form -
 * and the failure surfaces as an application validation error on the LAST step, several steps away
 * from the two that were quietly removed.
 *
 * So the unit of reasoning is the SEGMENT, not the state:
 *
 *   - partition the run by screen identity: search -> results -> member -> form -> review
 *   - retain the segments on the successful path
 *   - WITHIN a retained segment, keep every action that changed something. Remove only actions
 *     explicitly RECORDED as no-ops, which is the one category the run itself measured
 *   - drop a segment only when the run explicitly navigated BACK from it and later reached success
 *     via a different branch
 *
 * A REPEATED SCREEN IDENTITY IS NOT SUFFICIENT TO CLASSIFY AN ACTION AS A LOOP. Correctness beats
 * finding the shortest action sequence: a capability with one redundant click is a nuisance, and a
 * capability missing a required field is an incident.
 */
export interface PathSegment {
  screen: string;
  steps: RecordedStep[];
}

export function toSegments(run: DiscoveryRunRecord, steps: readonly RecordedStep[]): PathSegment[] {
  const segments: PathSegment[] = [];

  for (const step of steps) {
    const before = observationById(run, step.beforeObservationId);
    const screen = before?.screenIdentity.canonicalScreenName ?? '(unknown)';
    const last = segments.at(-1);
    if (last !== undefined && last.screen === screen) last.steps.push(step);
    else segments.push({ screen, steps: [step] });
  }

  return segments;
}

/**
 * Drop only the branches the run demonstrably abandoned.
 *
 * Returning to a screen we were on earlier is the one unambiguous signal that everything done in
 * between was a detour: the run went somewhere, came back, and then reached success by another
 * route. Those in-between segments are dropped.
 *
 * The two visits to the returned-to screen are MERGED rather than deduplicated, in that order.
 * Both sets of actions are kept because leaving a screen and coming back may have reset it, and
 * re-doing a fill is harmless while skipping one is not.
 */
export function retainSegments(segments: readonly PathSegment[]): PathSegment[] {
  const kept: PathSegment[] = [];

  for (const segment of segments) {
    const priorVisit = kept.findIndex((candidate) => candidate.screen === segment.screen);
    if (priorVisit === -1) {
      kept.push({ screen: segment.screen, steps: [...segment.steps] });
      continue;
    }

    // Everything after the first visit to this screen was a detour we returned from.
    kept.length = priorVisit + 1;
    const merged = kept[priorVisit];
    if (merged !== undefined) merged.steps = [...merged.steps, ...segment.steps];
  }

  return kept;
}

/** The only deletion allowed inside a retained segment. */
export function dropRecordedNoOps(segments: readonly PathSegment[]): PathSegment[] {
  return segments
    .map((segment) => ({
      screen: segment.screen,
      steps: segment.steps.filter((step) => !step.noop),
    }))
    .filter((segment) => segment.steps.length > 0);
}

export function reconstructPath(run: DiscoveryRunRecord): PathSegment[] {
  return dropRecordedNoOps(retainSegments(toSegments(run, run.steps)));
}
