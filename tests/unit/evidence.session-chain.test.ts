import { describe, expect, it } from 'vitest';
import { checkSessionChain, leasesAlternate } from '../../scripts/evidence/lib/session-chain.js';
import type { SessionState } from '../../src/types/session.js';

const edge = (from: SessionState, to: SessionState) => ({ from, to });

/**
 * ================================================================================================
 * THE TRACE FROM THE REAL HANDOFF RUN, BOTH AS IT WAS AND AS IT SHOULD HAVE BEEN.
 * ================================================================================================
 *
 * The operator pressed Resume while the compliance modal was still on screen. The run said "that is
 * still in the way" and handed control back rather than resuming into it - the D62 path - so the
 * bundle contains TWO interventions. The verifier called that a failure, which is a gate rejecting
 * the most interesting evidence the project can produce.
 *
 * It also contained events the replay ENGINE wrote with a hardcoded `from`, describing a transition
 * the state machine never made. Both are pinned here, because loosening the count without keeping
 * the contiguity rule would have accepted the fabrication too.
 */

/** What the coordinator actually performed. Every edge is legal; `transitionTo` throws otherwise. */
const TWO_INTERVENTIONS = [
  edge('AUTOMATION_RUNNING', 'PAUSING'),
  edge('PAUSING', 'HUMAN_CONTROL'),
  edge('HUMAN_CONTROL', 'RESUME_VALIDATION'),
  // Straight back to the person, with no PAUSING: the system has already stopped, it has just
  // finished deciding it does not know where it is. Routing through PAUSING would be illegal.
  edge('RESUME_VALIDATION', 'HUMAN_CONTROL'),
  edge('HUMAN_CONTROL', 'RESUME_VALIDATION'),
];

describe('a session trace is a chain, not a count', () => {
  it('[MUST] accepts the two-intervention handoff that the old check rejected', () => {
    const result = checkSessionChain(TWO_INTERVENTIONS);

    expect(result.problems).toEqual([]);
    expect(result.interventions).toBe(2);
  });

  it('accepts one intervention, and none at all', () => {
    expect(
      checkSessionChain([
        edge('AUTOMATION_RUNNING', 'PAUSING'),
        edge('PAUSING', 'HUMAN_CONTROL'),
        edge('HUMAN_CONTROL', 'RESUME_VALIDATION'),
        edge('RESUME_VALIDATION', 'COMPLETED'),
      ]).problems,
    ).toEqual([]);

    // A replay that never hands off records no transition and never leaves the initial state.
    expect(checkSessionChain([]).problems).toEqual([]);
    expect(checkSessionChain([]).interventions).toBe(0);
  });

  it('[MUST] rejects the fabricated transition the engine used to write', () => {
    // The engine had no reference to the state machine and hardcoded from: AUTOMATION_RUNNING. On
    // the second intervention the machine was in RESUME_VALIDATION, so this event described
    // something that never happened. This is the assertion that caught it, and the reason the
    // contiguity rule was kept while the count was dropped.
    const withFabrication = [
      ...TWO_INTERVENTIONS.slice(0, 3),
      edge('AUTOMATION_RUNNING', 'PAUSING'),
      ...TWO_INTERVENTIONS.slice(3),
    ];

    const result = checkSessionChain(withFabrication);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toContain('while the machine was in RESUME_VALIDATION');
  });

  it('rejects an edge the state table does not allow', () => {
    const result = checkSessionChain([
      edge('AUTOMATION_RUNNING', 'PAUSING'),
      // PAUSING has exactly one exit, on purpose: a pause either completes into HUMAN_CONTROL or
      // the session is stuck, and "stuck" should be visible rather than laundered into FAILED.
      edge('PAUSING', 'COMPLETED'),
    ]);

    expect(result.problems).toEqual(['illegal edge PAUSING -> COMPLETED']);
  });

  it('[MUST] the lease alternates, starting and ending with AUTOMATION', () => {
    expect(leasesAlternate(['AUTOMATION'])).toBe(true);
    expect(leasesAlternate(['AUTOMATION', 'HUMAN', 'AUTOMATION'])).toBe(true);
    expect(leasesAlternate(['AUTOMATION', 'HUMAN', 'AUTOMATION', 'HUMAN', 'AUTOMATION'])).toBe(
      true,
    );

    // What the bundle actually recorded before `reclaim` started writing down the lease it was
    // already issuing. Two HUMAN leases in a row would mean one was issued while a person already
    // held control, which is the thing lease tokens exist to make impossible.
    expect(leasesAlternate(['AUTOMATION', 'HUMAN', 'HUMAN'])).toBe(false);
    expect(leasesAlternate(['HUMAN', 'AUTOMATION'])).toBe(false);
    expect(leasesAlternate([])).toBe(false);
  });
});
