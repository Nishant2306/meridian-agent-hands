import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { modelAuthoredProse, sweepParameterization } from '../src/artifact/parameterize.js';
import { CapabilityArtifactSchema, type CapabilityArtifact } from '../src/artifact/schema.js';

/**
 * ================================================================================================
 * THE GATE 1 LEAK. REAL ARTIFACT, REAL PROVENANCE, REAL MODEL.
 * ================================================================================================
 *
 * `tests/fixtures/artifacts/gate1-leaked-prose@1.0.0.json` is the artifact GATE 1 actually
 * produced, copied verbatim before it was removed from the store. Its provenance is genuine:
 *
 *     discoveryRunId  discover-1787709809977-e0d9047b
 *     model           claude-sonnet-5
 *     promptVersion   v1
 *     status          approved          <- it got all the way through
 *
 * It passed distillation, passed validation, passed approval, and was written to the store
 * carrying a runtime member id and a member's NAME in two model-authored fields. This file exists
 * so that can never happen quietly again, and it is deliberately not a synthetic reproduction: a
 * hand-written example would be a test of what I imagined the model wrote.
 *
 * WHAT THIS TEST CANNOT DO, STATED PLAINLY. It cannot re-run `distill()` over the GATE 1 run,
 * because that run's DiscoveryRunRecord was never written to disk - only result, metrics and
 * encountered conditions were. So it asserts against the distiller's OUTPUT rather than re-driving
 * its input. `src/cli/discover.ts` now writes `run.json`, so from the next run onward the
 * re-distillation is possible directly.
 */

const LEAKED = fileURLToPath(
  new URL('fixtures/artifacts/gate1-leaked-prose@1.0.0.json', import.meta.url),
);

function leakedArtifact(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(LEAKED, 'utf8')));
}

/** What the GATE 1 invocation supplied. `Savings` is also a declared enum member. */
const GATE1_RUNTIME_VALUES = ['10001', 'Savings', 'Vacation', '250.00'];

describe('the GATE 1 artifact is refused by the sweep it slipped past', () => {
  it('is the real thing, with the real run id and the prompt version that allowed it', () => {
    const artifact = leakedArtifact();

    expect(artifact.provenance.discoveryRunId).toBe('discover-1787709809977-e0d9047b');
    expect(artifact.provenance.promptVersion).toBe('v1');
    // It reached the store approved. That is the part worth remembering.
    expect(artifact.status).toBe('approved');
  });

  it('REFUSES it, and names both offending fields', () => {
    const issues = sweepParameterization({
      artifact: leakedArtifact(),
      runtimeValues: GATE1_RUNTIME_VALUES,
    });

    const prose = issues.filter((issue) => issue.code === 'RUNTIME_VALUE_IN_PROSE');
    expect(prose.length).toBeGreaterThanOrEqual(2);

    const paths = prose.map((issue) => issue.message);
    expect(paths.some((message) => message.includes('step-3-open).intent'))).toBe(true);
    expect(
      paths.some(
        (message) =>
          message.includes('step-3-open') &&
          message.includes('.expectedEffects[') &&
          message.includes('.description'),
      ),
    ).toBe(true);
  });

  it('names the VALUE that leaked, not just the field', () => {
    const issues = sweepParameterization({
      artifact: leakedArtifact(),
      runtimeValues: GATE1_RUNTIME_VALUES,
    });

    // A reviewer reading the refusal should not have to open the artifact to see what went wrong.
    expect(issues.some((issue) => issue.message.includes('"10001"'))).toBe(true);
  });

  it('refuses rather than offering to rewrite', () => {
    const issues = sweepParameterization({
      artifact: leakedArtifact(),
      runtimeValues: GATE1_RUNTIME_VALUES,
    });
    const message = issues.find((issue) => issue.code === 'RUNTIME_VALUE_IN_PROSE')?.message ?? '';

    // An edited intent is a step whose recorded reasoning no longer says what the model meant.
    expect(message).toContain('refusal and not a rewrite');
    expect(message).toContain('Re-run discovery');
  });

  it('the member NAME travels with the id, and one catch is enough to stop both', () => {
    const artifact = leakedArtifact();
    const offending = modelAuthoredProse(artifact).filter((field) =>
      field.value.includes('Avery Lin'),
    );

    // "Avery Lin" was never an invocation value - the model read it off the screen and narrated it.
    // It is caught because it sits in the same sentence as the member id, which is the argument for
    // sweeping whole fields rather than trying to enumerate every value a model might mention.
    expect(offending.length).toBeGreaterThan(0);
    expect(offending.every((field) => field.value.includes('10001'))).toBe(true);
  });
});

describe('the sweep still accepts what it always accepted', () => {
  it('does not refuse a declared enum member appearing in prose', () => {
    const artifact = leakedArtifact();
    const withEnumProse: CapabilityArtifact = {
      ...artifact,
      steps: artifact.steps.map((step, index) =>
        index === 0
          ? { ...step, intent: 'Choose the Savings option, which accountType names.' }
          : step,
      ),
    };

    const issues = sweepParameterization({
      artifact: withEnumProse,
      runtimeValues: ['Savings'],
    });

    // "Savings" is an invocation value AND a declared enum member. Refusing it would refuse every
    // correct artifact this system can produce.
    expect(issues).toEqual([]);
  });

  it('accepts prose written the way the v2 prompt asks for', () => {
    const artifact = leakedArtifact();
    const rewritten: CapabilityArtifact = {
      ...artifact,
      steps: artifact.steps.map((step) => ({
        ...step,
        intent: 'Click Open in the row identified by memberId to open the member record.',
        expectedEffects: step.expectedEffects.map((effect) => ({
          ...effect,
          description: 'the Member Record screen for the row identified by memberId is shown',
        })),
      })),
    };

    const prose = sweepParameterization({
      artifact: rewritten,
      runtimeValues: GATE1_RUNTIME_VALUES,
    }).filter((issue) => issue.code === 'RUNTIME_VALUE_IN_PROSE');

    expect(prose).toEqual([]);
  });
});

describe('every model-authored field is swept, not just the two that leaked', () => {
  it('covers step intent, step notes, assertion descriptions and state descriptions', () => {
    const paths = modelAuthoredProse(leakedArtifact()).map((field) => field.path);

    expect(paths.some((path) => path.endsWith('.intent'))).toBe(true);
    expect(
      paths.some((path) => path.includes('.expectedEffects[') && path.endsWith('.description')),
    ).toBe(true);
    expect(
      paths.some((path) => path.includes('.invariants[') && path.endsWith('.description')),
    ).toBe(true);
    expect(paths.some((path) => path.startsWith('states['))).toBe(true);
    expect(paths.some((path) => path.startsWith('preconditions['))).toBe(true);
  });

  it('catches a leak in a field that has never leaked yet', () => {
    // step.notes is system-generated today, so nothing has ever leaked through it. That is exactly
    // why it is worth pinning: the next thing to write into it will not announce itself.
    const artifact = leakedArtifact();
    const first = artifact.steps[0];
    expect(first).toBeDefined();

    const withNotes: CapabilityArtifact = {
      ...artifact,
      steps: [{ ...first!, notes: 'Recorded against member 10001.' }, ...artifact.steps.slice(1)],
    };

    const issues = sweepParameterization({
      artifact: withNotes,
      runtimeValues: ['10001'],
    });

    expect(issues.some((issue) => issue.message.includes('.notes'))).toBe(true);
  });
});
