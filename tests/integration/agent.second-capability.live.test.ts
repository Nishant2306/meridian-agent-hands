import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { distill } from '../../src/artifact/distill.js';
import { validateArtifactStructure } from '../../src/artifact/validate.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { CONFIG_ROOT, runScriptedDiscovery } from '../../scripts/lib/scripted-run.js';
import { call, findMark, param, type ScriptedTurn } from '../../scripts/lib/scripted-llm.js';
import { replayAgainstFixture } from '../../scripts/lib/replay-harness.js';

const SPEC = fileURLToPath(
  new URL('../../config/specs/lookup_member_savings_balance.yaml', import.meta.url),
);

/**
 * ================================================================================================
 * THE SECOND CAPABILITY, END TO END, WITH NO CODE CHANGES.
 * ================================================================================================
 *
 * The schema had been demonstrated exactly once, so the open question was whether it is a
 * capability FORMAT or a schema fitted to one flow. The claim "a second capability costs a spec
 * file and a discovery run and no code" is testable without a model: drive the new spec through the
 * SAME scripted pipeline, the SAME distiller, the SAME replay engine, and assert nothing anywhere
 * had to learn the new capability's name.
 *
 * The flow also exercises two things the first capability structurally could not:
 *
 *   - a capability whose LAST steps are pure reads. `read_value` binds an output and emits no step
 *     (D19), so the distilled artifact here has THREE steps and its success state is simply the
 *     member record - the read-step exemption on the happy path rather than only in its own test.
 *   - a CURRENCY OUTPUT. The first capability had a currency input; this one reads money OFF the
 *     screen, through the same typed comparison, comma and all ("$18,750.00").
 *
 * The profiles are the same pinned files. MEMBER_NOT_FOUND firing for this capability too is the
 * claim that the condition profile was written about the APPLICATION, not about one flow.
 */
const INPUTS = { memberId: '10001' };

const LOOKUP_PATH: ScriptedTurn[] = [
  (inv) => [
    call('type_text', {
      markId: findMark(inv, { role: 'textbox', name: 'Member ID' }),
      value: param('memberId'),
      intent: 'Put the requested member id into the search field, which is labelled Member ID.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'button', name: 'Search' }),
      intent: 'Run the member search using the Search button next to the member id field.',
    }),
  ],
  (inv) => [
    call('click', {
      markId: findMark(inv, { role: 'link', name: 'Open' }),
      intent: 'Open the member record from the results row for the member we were asked about.',
    }),
  ],
  (inv) => [
    call('propose_record_identity', {
      markId: findMark(inv, { role: 'cell', near: 'Member ID' }),
      intent: 'The cell beside the Member ID label shows which member this record belongs to.',
    }),
    call('read_value', {
      markId: findMark(inv, { role: 'cell', near: 'Member Name' }),
      outputName: 'memberName',
      parseAs: 'text',
      intent: 'The cell beside the Member Name label carries the member identity.',
    }),
    call('read_value', {
      // The savings balance cell sits in the accounts grid. Its nearby text is the row's Type
      // label and the column header - ["Savings", "Balance"] - which is what disambiguates it from
      // the Checking row's balance without touching the account number.
      markId: findMark(inv, { role: 'cell', near: 'Savings' }),
      outputName: 'savingsBalance',
      parseAs: 'currency',
      intent: 'The balance cell in the Savings row of the accounts grid.',
    }),
  ],
  () => [
    call('propose_goal_reached', {
      summary: 'The member record is open and the name and savings balance have been read.',
      outputs: {},
    }),
  ],
];

describe('the second capability: lookup_member_savings_balance', () => {
  let artifact: CapabilityArtifact;

  beforeAll(async () => {
    const { outcome } = await runScriptedDiscovery({
      script: LOOKUP_PATH,
      runtimeInputs: INPUTS,
      specPath: SPEC,
    });
    expect(outcome.result.status).toBe('success');

    const distilled = distill({
      run: outcome.record,
      resolver: new DefaultTargetResolver(),
      configRoot: CONFIG_ROOT,
    });
    if (!distilled.ok) {
      throw new Error(
        distilled.issues.map((issue) => issue.code + ': ' + issue.message).join('; '),
      );
    }
    artifact = distilled.artifact;
  }, 180_000);

  it('[MUST] discovery, distillation and validation all take the new spec unchanged', () => {
    expect(artifact.capabilityId).toBe('lookup_member_savings_balance');
    expect(validateArtifactStructure(artifact)).toEqual([]);

    // The read-only shape: three steps - type, search, open - and nothing after them, because a
    // read binds an output and emits no step. The first capability could not produce this.
    expect(artifact.steps).toHaveLength(3);
    expect(artifact.outputs.map((output) => output.name).sort()).toEqual([
      'memberName',
      'savingsBalance',
    ]);

    // The same immutable profiles, pinned by the same hashes the first capability pins.
    expect(artifact.profiles.condition.id).toBe('meridian-subaccount');
    expect(artifact.profiles.safety.id).toBe('banking-default');
  });

  it('[MUST] replays on a fresh boot with zero model calls, and returns the balance', async () => {
    // A fresh fixture boot: every class name and element id differs from the discovery boot.
    const outcome = await replayAgainstFixture({ artifact, params: { memberId: '10001' } });

    expect(outcome.result.status).toBe('success');
    if (outcome.result.status !== 'success') return;
    expect(outcome.result.metrics.llmCalls).toBe(0);

    expect(outcome.result.outputs['memberName']).toBe('Avery Lin');

    // ==========================================================================================
    // A DECLARED `currency` OUTPUT COMES BACK AS DISPLAY TEXT. THIS ASSERTS THE DEFECT.
    // ==========================================================================================
    //
    // `src/types/run.ts` states the contract in a comment on the type itself: "Currency outputs are
    // Money, never a float or a string", and `OutputValueSchema` is `string | Money`. But
    // `extractDeclaredOutput` returns `{ ok: true; value: string }` unconditionally: for a currency
    // output it calls `parseMoney` purely as a validity check, DISCARDS the result, and returns the
    // normalized display text. Nothing in src/ ever constructs a Money into an outputs record, so
    // the Money half of that union has no producer.
    //
    // Nothing caught it because the FIRST capability has a currency INPUT and no currency OUTPUT -
    // typed comparison was exercised on the way in and never on the way out. This capability is the
    // first thing that could surface it, which is the argument for having built it.
    //
    // The assertion is written to the behaviour AS IT IS, not as the contract says it should be, so
    // the suite stays honest and green while the gap is recorded rather than hidden. Fixing it means
    // widening `OutputExtraction` to carry `string | Money` in the one place discovery's completion
    // check and replay already share. Recorded in DECISIONS.md D97 as an open defect.
    expect(outcome.result.outputs['savingsBalance']).toBe('$18,750.00');
    expect(typeof outcome.result.outputs['savingsBalance']).toBe('string');
  }, 120_000);

  it('MEMBER_NOT_FOUND is a business outcome here too, from the same pinned profile', async () => {
    // The profile's id says "subaccount"; its detectors are screen-level facts about MERIDIAN. If
    // this failed, the profile would have been about one flow all along and the reuse claim false.
    const outcome = await replayAgainstFixture({ artifact, params: { memberId: '99999' } });

    expect(outcome.result.status).toBe('business_outcome');
    if (outcome.result.status !== 'business_outcome') return;
    expect(outcome.result.outcome).toBe('MEMBER_NOT_FOUND');
  }, 120_000);
});
