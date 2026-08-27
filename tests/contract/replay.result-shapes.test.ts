import { describe, expect, it } from 'vitest';
import { RunResultSchema, type RunResult } from '../../src/types/run.js';

/**
 * ================================================================================================
 * THE FIVE SHAPES A RUN CAN END IN, AND THE EXIT CODE EACH ONE MEANS.
 * ================================================================================================
 *
 * `RunResult` is what a caller receives. It is a contract in the strict sense: an agent invoking a
 * capability branches on `status`, and adding, removing or reshaping a case changes what every
 * caller has to handle.
 *
 * The distinctions are the whole point of the type:
 *
 *   success           the work is done. `completionMode` says whether a person was involved.
 *   business_outcome  the automation worked and the answer is negative. NOT a failure.
 *   needs_human       something is in the way that nobody described.
 *   cancelled         a person decided to stop. Not a malfunction.
 *   failed            the automation, the surface, the contract or a guardrail said no.
 *
 * A caller that collapsed `business_outcome` into `failed` would page somebody every time a member
 * id did not exist. That is the mistake this taxonomy exists to make impossible, so a test that
 * pins the five shapes and their exit codes is worth more than it looks.
 */

const METRICS = {
  steps: 8,
  durationMs: 1883,
  llmCalls: 0,
  recoveriesUsed: 0,
  locatorTierDowngrades: 0,
  humanInterventions: 0,
};

/** The mapping in `src/cli/replay.ts`. Reproduced here so a change to either side is visible. */
const EXIT_CODES: Record<RunResult['status'], number> = {
  success: 0,
  business_outcome: 10,
  needs_human: 20,
  cancelled: 25,
  failed: 30,
};

const GOLDEN: Record<RunResult['status'], unknown> = {
  success: {
    status: 'success',
    completionMode: 'automation',
    outputs: { memberName: 'Avery Lin', accountType: 'Savings', reviewStatus: 'PENDING REVIEW' },
    evidenceRef: 'runs/replay-1787722924503',
    metrics: METRICS,
  },
  business_outcome: {
    status: 'business_outcome',
    outcome: 'MEMBER_NOT_FOUND',
    detail: 'No member exists with the supplied member id.',
    evidenceRef: 'runs/replay-1787722924504',
    metrics: METRICS,
  },
  needs_human: {
    status: 'needs_human',
    interventionId: 'iv_6bd9d88ae1f349e0976b39',
    reason: 'a blocking dialog ("Compliance attestation required") is displayed',
    stepId: 'step-3-open-member',
    evidenceRef: 'runs/replay-1787722924505',
    metrics: METRICS,
  },
  cancelled: {
    status: 'cancelled',
    reason: 'OPERATOR_ABORTED',
    stepId: 'step-3-open-member',
    evidenceRef: 'runs/replay-1787722924506',
    metrics: METRICS,
  },
  failed: {
    status: 'failed',
    error: 'PERMISSION_DENIED',
    stepId: 'step-3-open-member',
    expected: 'the Member Record screen is shown',
    observed: 'The signed-on operator is not entitled to view this member.',
    attempts: 1,
    evidenceRef: 'runs/replay-1787722924507',
    metrics: METRICS,
  },
};

describe('every RunResult shape a caller must handle', () => {
  it('has exactly five, and no more appear without this test noticing', () => {
    // `z.discriminatedUnion` exposes its members, so the count comes from the schema rather than
    // from a number somebody remembered to update.
    expect(RunResultSchema.options).toHaveLength(5);
    expect(RunResultSchema.options.map((option) => option.shape.status.value).sort()).toEqual([
      'business_outcome',
      'cancelled',
      'failed',
      'needs_human',
      'success',
    ]);
  });

  it.each(Object.keys(GOLDEN) as RunResult['status'][])('%s parses', (status) => {
    expect(() => RunResultSchema.parse(GOLDEN[status])).not.toThrow();
  });

  it('gives every shape its own exit code', () => {
    // 10 is separate from 30 on purpose: "there is no such member" must not page anybody, and 25
    // says a person chose to stop rather than something breaking.
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(EXIT_CODES.business_outcome).not.toBe(EXIT_CODES.failed);
    expect(EXIT_CODES.cancelled).not.toBe(EXIT_CODES.failed);
  });

  it('the CLI maps them the same way this file does', async () => {
    // The one place the mapping actually lives. If it drifts from the table above, say so here
    // rather than at the moment somebody's alerting misfires.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../src/cli/replay.ts', import.meta.url)),
      'utf8',
    );

    for (const [status, code] of Object.entries(EXIT_CODES)) {
      expect(source, status).toContain(status + ': ' + code);
    }
  });

  it('[MUST] refuses a key nobody declared, in every shape', () => {
    // Written first as "only success can carry outputs", which was wrong twice: zod 4 passes
    // unknown keys through rather than stripping them, AND `outputs` on a business_outcome is a
    // DECLARED optional field. The branches are `strictObject` now, and the claim is the accurate
    // one - an undeclared key is refused.
    for (const status of Object.keys(GOLDEN) as RunResult['status'][]) {
      expect(
        () => RunResultSchema.parse({ ...(GOLDEN[status] as object), somethingElse: 1 }),
        status,
      ).toThrow();
    }
  });

  it('lets a business outcome carry declared outputs, on purpose', () => {
    // A run can read a declared output and THEN reach a negative answer: "the member exists and
    // here is their name, but the sub-account you asked about does not". Throwing that away would
    // make the caller ask again for something we already had.
    const parsed = RunResultSchema.parse({
      ...(GOLDEN.business_outcome as object),
      outputs: { memberName: 'Avery Lin' },
    });

    expect(parsed.status).toBe('business_outcome');
    if (parsed.status !== 'business_outcome') return;
    expect(parsed.outputs?.['memberName']).toBe('Avery Lin');
  });

  it('requires outputs on success, where the work was actually done', () => {
    const { outputs: _dropped, ...without } = GOLDEN.success as Record<string, unknown>;
    expect(() => RunResultSchema.parse(without)).toThrow();
  });

  it('[MUST] failed carries EXPECTED as well as OBSERVED', () => {
    // A failure is a disagreement, and one half of a disagreement is not a diagnosis. `expected` is
    // nullable rather than optional so a producer has to say "nothing was expected here" out loud.
    const parsed = RunResultSchema.parse(GOLDEN.failed);
    expect(parsed.status).toBe('failed');
    if (parsed.status !== 'failed') return;

    expect(parsed.expected).toBeTruthy();
    expect(parsed.observed).toBeTruthy();
    expect(() =>
      RunResultSchema.parse({ ...(GOLDEN.failed as object), expected: null }),
    ).not.toThrow();
    expect(() => {
      const { expected: _dropped, ...without } = GOLDEN.failed as Record<string, unknown>;
      RunResultSchema.parse(without);
    }).toThrow();
  });

  it('[MUST] cancelled has exactly one reason, so "why did it stop" is never ambiguous', () => {
    expect(() =>
      RunResultSchema.parse({ ...(GOLDEN.cancelled as object), reason: 'CHANGED_MY_MIND' }),
    ).toThrow();
  });

  it('every shape carries an evidence ref and metrics', () => {
    // Whatever happened, there is somewhere to go and look, and a count of what it cost.
    for (const status of Object.keys(GOLDEN) as RunResult['status'][]) {
      const parsed = RunResultSchema.parse(GOLDEN[status]);
      expect(parsed.evidenceRef, status).toBeTruthy();
      expect(parsed.metrics.llmCalls, status).toBe(0);
    }
  });
});
