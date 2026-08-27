import { SESSION_TRANSITIONS, type SessionState } from '../../../src/types/session.js';

/**
 * ================================================================================================
 * A SESSION TRACE IS A CHAIN, NOT A COUNT.
 * ================================================================================================
 *
 * The first version of this check expected exactly one clean AUTOMATION -> HUMAN -> AUTOMATION and
 * reported a "gap" for anything else. That made it fail on the most interesting handoff evidence the
 * project can produce: an operator who presses Resume while the blocker is still on screen gets two
 * interventions, because the run says "that is still in the way" and hands control back rather than
 * resuming into it. A gate that rejects its own best evidence teaches people to ignore it.
 *
 * What is actually required is that the trace be a CHAIN. The run starts in AUTOMATION_RUNNING,
 * every recorded edge is legal per the state table, and each edge starts where the previous one
 * ended. Any number of interventions satisfies that.
 *
 * The contiguity rule is the part worth keeping, and it earned its place: it is what caught an event
 * the replay engine was writing with a hardcoded `from`, describing a transition that never happened
 * (D89). Loosening the count while keeping the chain means this accepts every real sequence and
 * still rejects an invented one.
 *
 * Extracted from `verify.ts` so both directions can be tested without assembling a bundle.
 */

export interface SessionChainResult {
  /** Empty when the trace is a legal, contiguous chain. */
  readonly problems: readonly string[];
  /** How many times control passed to a person. */
  readonly interventions: number;
  readonly states: readonly SessionState[];
}

export function checkSessionChain(
  transitions: readonly { from: SessionState; to: SessionState }[],
): SessionChainResult {
  let state: SessionState = 'AUTOMATION_RUNNING';
  const problems: string[] = [];

  for (const edge of transitions) {
    if (edge.from !== state) {
      problems.push(
        'recorded ' + edge.from + ' -> ' + edge.to + ' while the machine was in ' + state,
      );
    } else if (!(SESSION_TRANSITIONS[edge.from] ?? []).includes(edge.to)) {
      problems.push('illegal edge ' + edge.from + ' -> ' + edge.to);
    }
    state = edge.to;
  }

  return {
    problems,
    interventions: transitions.filter((edge) => edge.to === 'HUMAN_CONTROL').length,
    states: transitions.map((edge) => edge.to),
  };
}

/**
 * The lease must alternate, starting with AUTOMATION.
 *
 * Two HUMAN leases in a row would mean one was issued while a person already held control, which is
 * the thing lease tokens exist to make impossible. A two-intervention run reads
 * AUTOMATION -> HUMAN -> AUTOMATION -> HUMAN -> AUTOMATION; it read
 * AUTOMATION -> HUMAN -> HUMAN until `reclaim` started recording the lease it was already issuing.
 */
export function leasesAlternate(owners: readonly string[]): boolean {
  if (owners.length === 0 || owners[0] !== 'AUTOMATION') return false;
  return owners.every((owner, index) =>
    index % 2 === 0 ? owner === 'AUTOMATION' : owner === 'HUMAN',
  );
}
