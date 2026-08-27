import { describe, expect, it } from 'vitest';
import type { CompletionReason } from '../../src/agent/completion.js';
import {
  isIdentityReason,
  isOutputReason,
  OutstandingRefusal,
} from '../../src/agent/outstanding.js';

/**
 * The GATE 3 stall was not the refusal. The refusal was correct. The stall was that the model fixed
 * the thing it was refused for and was told nothing, so it never proposed completion again.
 *
 * These pin the two properties that matter: it SPEAKS when a named reason becomes false, and it
 * stays SILENT the rest of the time. The silence is half the design - a message on every
 * acknowledgement turns completion into polling, and polling costs a model call per round.
 */
const stale: CompletionReason = {
  code: 'IDENTITY_STALE',
  message: 'the record identity binding is STALE, not missing.',
};
const missingName: CompletionReason = {
  code: 'OUTPUT_NOT_BOUND',
  outputName: 'memberName',
  message: 'output "memberName" is required but was never bound.',
};
const missingStatus: CompletionReason = {
  code: 'OUTPUT_NOT_BOUND',
  outputName: 'reviewStatus',
  message: 'output "reviewStatus" is required but was never bound.',
};

describe('the outstanding completion refusal', () => {
  it('says nothing at all when no refusal is outstanding', () => {
    // The ordinary case, and the one that has to stay quiet: every acknowledgement in the loop
    // appends this unconditionally.
    const outstanding = new OutstandingRefusal();
    expect(outstanding.resolve(isIdentityReason)).toBe('');
    expect(outstanding.resolve(isOutputReason('memberName'))).toBe('');
  });

  it('says nothing when the action addressed something else', () => {
    const outstanding = new OutstandingRefusal();
    outstanding.set([stale], 'Review Sub-Account Request');

    // Binding an unrelated output is not progress on the identity.
    expect(outstanding.resolve(isOutputReason('memberName'))).toBe('');
    expect(outstanding.reasons).toHaveLength(1);
  });

  it('[MUST] tells the model to propose again when the LAST reason becomes false', () => {
    // This is the sentence whose absence ended the GATE 3 run.
    const outstanding = new OutstandingRefusal();
    outstanding.set([stale], 'Review Sub-Account Request');

    const said = outstanding.resolve(isIdentityReason);
    expect(said).toContain('That was the last thing blocking completion');
    expect(said).toContain('propose_goal_reached');
    expect(outstanding.reasons).toHaveLength(0);
  });

  it('lists what is still outstanding when more than one reason remains', () => {
    const outstanding = new OutstandingRefusal();
    outstanding.set([stale, missingName, missingStatus], 'Review Sub-Account Request');

    const said = outstanding.resolve(isIdentityReason);
    expect(said).toContain('Still outstanding');
    expect(said).toContain('memberName');
    expect(said).toContain('reviewStatus');
    // And it does NOT tell the model to propose completion, because it would be refused again.
    expect(said).not.toContain('propose_goal_reached');
    expect(outstanding.reasons).toHaveLength(2);
  });

  it('an output reason is matched by NAME, not by being an output', () => {
    const outstanding = new OutstandingRefusal();
    outstanding.set([missingName, missingStatus], 'Review Sub-Account Request');

    expect(outstanding.resolve(isOutputReason('accountType'))).toBe('');
    expect(outstanding.resolve(isOutputReason('memberName'))).toContain('Still outstanding');
    expect(outstanding.resolve(isOutputReason('reviewStatus'))).toContain(
      'That was the last thing blocking completion',
    );
  });

  it('speaks only ONCE for the same reason', () => {
    // Otherwise a model that binds the same output twice is told twice that it has finished, which
    // is exactly the kind of repeated non-signal the repeated-action rule exists to catch.
    const outstanding = new OutstandingRefusal();
    outstanding.set([stale], 'Review Sub-Account Request');

    expect(outstanding.resolve(isIdentityReason)).not.toBe('');
    expect(outstanding.resolve(isIdentityReason)).toBe('');
  });

  it('[MUST] a refusal does not survive a navigation', () => {
    // A refusal is about a SCREEN. Announcing "that was the last thing blocking completion" on a
    // different page would be false, and the model would propose completion into a refusal.
    const outstanding = new OutstandingRefusal();
    outstanding.set([stale], 'Review Sub-Account Request');

    outstanding.observedScreen('Review Sub-Account Request');
    expect(outstanding.reasons).toHaveLength(1);

    outstanding.observedScreen('Member Record');
    expect(outstanding.reasons).toHaveLength(0);
    expect(outstanding.resolve(isIdentityReason)).toBe('');
  });
});
