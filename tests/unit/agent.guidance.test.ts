import { describe, expect, it } from 'vitest';
import { failureFeedback, failureKey, type FailureCode } from '../../src/agent/guidance.js';

/**
 * The GATE 1 run proposed the same read four times. Each rejection said only
 *
 *     "Could not read the record identity there: the control is no longer present on the screen"
 *
 * a statement about the screen, on a screen that had not changed. These tests pin the two
 * properties that were missing: the message says what to DO, and a repeat says that it is one.
 */

const CONTROL = { markId: 15, role: 'text' as const, name: 'Member Name: Avery Lin (10001)' };

describe('failure feedback tells the model what to do next', () => {
  it('names the control it is about, so the model need not infer it', () => {
    const message = failureFeedback({
      code: 'CONTROL_NOT_FOUND',
      reason: 'the control is no longer present on the screen',
      control: CONTROL,
      attempt: 1,
    });

    expect(message).toContain('Mark 15');
    expect(message).toContain('Member Name: Avery Lin (10001)');
  });

  it('tells it to choose a DIFFERENT mark rather than restating the error', () => {
    const message = failureFeedback({
      code: 'CONTROL_NOT_FOUND',
      reason: 'the control is no longer present on the screen',
      control: CONTROL,
      attempt: 1,
    });

    expect(message).toContain('Do not re-propose the same target');
    expect(message).toContain('DIFFERENT mark');
  });

  it('escalates on a repeat instead of repeating what already did not work', () => {
    const first = failureFeedback({ code: 'CONTROL_NOT_FOUND', reason: 'gone', attempt: 1 });
    const third = failureFeedback({ code: 'CONTROL_NOT_FOUND', reason: 'gone', attempt: 3 });

    expect(first).not.toContain('3 times');
    expect(third).toContain('3 times');
    expect(third).toContain('It will keep failing');
  });

  it('gives a DIFFERENT next move for each code, because that is why they are different codes', () => {
    const codes: FailureCode[] = [
      'CONTROL_NOT_FOUND',
      'AMBIGUOUS_CONTROL',
      'UNDESCRIBABLE_CONTROL',
      'UNKNOWN_MARK',
      'STALE_OBSERVATION_CONTEXT',
      'POLICY_BLOCKED',
      'EFFECT_NOT_OBSERVED',
    ];

    const moves = codes.map((code) =>
      failureFeedback({ code, reason: 'r', attempt: 1 }).split(String.fromCharCode(10)).pop(),
    );

    // If two codes produced the same advice, one of them is not carrying its weight.
    expect(new Set(moves).size).toBe(codes.length);
  });

  it('does not tell the model to retry something that is permanently off limits', () => {
    const message = failureFeedback({ code: 'POLICY_BLOCKED', reason: 'irreversible', attempt: 1 });

    expect(message).toContain('will not become available');
    expect(message).not.toContain('choose again from what is there now');
  });

  it('points an undescribable control at the inventory rather than at another action', () => {
    // The nuance that matters for reads: the VALUE the model wanted is already in front of it.
    const message = failureFeedback({
      code: 'UNDESCRIBABLE_CONTROL',
      reason: 'no identifying evidence',
      control: CONTROL,
      attempt: 1,
    });

    expect(message).toContain('already in the inventory');
  });
});

describe('failure keys separate distinct problems', () => {
  it('counts the same code on the same mark as one repeated problem', () => {
    expect(failureKey('CONTROL_NOT_FOUND', 15)).toBe(failureKey('CONTROL_NOT_FOUND', 15));
  });

  it('treats a different code on the same mark as new information', () => {
    // A mark that first could not be found and then was ambiguous has told the model two things.
    expect(failureKey('CONTROL_NOT_FOUND', 15)).not.toBe(failureKey('AMBIGUOUS_CONTROL', 15));
  });

  it('treats the same code on a different mark as a separate problem', () => {
    expect(failureKey('CONTROL_NOT_FOUND', 15)).not.toBe(failureKey('CONTROL_NOT_FOUND', 16));
  });
});
