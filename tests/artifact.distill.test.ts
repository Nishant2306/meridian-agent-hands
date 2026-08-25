import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dropRecordedNoOps, retainSegments, type PathSegment } from '../src/artifact/path.js';
import { sweepParameterization } from '../src/artifact/parameterize.js';
import { reviewabilityLint } from '../src/artifact/distill.js';
import { CapabilityArtifactSchema, type CapabilityArtifact } from '../src/artifact/schema.js';
import type { RecordedStep } from '../src/types/discovery.js';

const EXAMPLE = fileURLToPath(
  new URL('../examples/artifacts/prepare_subaccount_review@1.0.0.example.json', import.meta.url),
);

function loadExample(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
}

let counter = 0;
function fakeStep(overrides: Partial<RecordedStep> = {}): RecordedStep {
  counter += 1;
  return {
    index: counter,
    intent: 'a step that does something worth describing',
    action: {
      type: 'click',
      target: {
        semantic: { role: 'button', name: 'Button ' + counter, nameMatch: 'exact' },
        recordedTier: 'T1_EXACT_ROLE_NAME',
      },
    },
    sourceObservationId: 'obs-' + counter,
    beforeObservationId: 'obs-' + counter,
    afterObservationId: 'obs-' + counter,
    trace: {
      observationId: 'obs-' + counter,
      tiersAttempted: [],
      tierUsed: null,
      conflicts: [],
      downgraded: false,
    },
    noop: false,
    changedScreen: false,
    changedTargetValue: true,
    changedInventory: false,
    resolvedControlName: 'Button ' + counter,
    resolvedControlRole: 'button',
    descriptorRationale: 'accessible name, recorded at T1_EXACT_ROLE_NAME',
    proposedEffects: [],
    ...overrides,
  };
}

const segment = (screen: string, steps: RecordedStep[]): PathSegment => ({ screen, steps });

describe('[MUST] segment-based path reconstruction', () => {
  it('keeps THREE fills that all happened on the same screen', () => {
    // The regression this algorithm exists for. A state-only backward walk sees three actions with
    // the same resulting state, calls two of them redundant, and deletes two of three fills.
    const fills = [fakeStep(), fakeStep(), fakeStep()];
    const kept = dropRecordedNoOps(retainSegments([segment('New Sub-Account', fills)]));

    expect(kept).toHaveLength(1);
    expect(kept[0]?.steps).toHaveLength(3);
  });

  it('leaves a straight path alone', () => {
    const path = [
      segment('Member Search', [fakeStep()]),
      segment('Member Record', [fakeStep()]),
      segment('New Sub-Account', [fakeStep()]),
    ];
    expect(retainSegments(path).map((entry) => entry.screen)).toEqual([
      'Member Search',
      'Member Record',
      'New Sub-Account',
    ]);
  });

  it('drops a branch the run demonstrably backed out of', () => {
    const first = fakeStep();
    const detour = fakeStep();
    const second = fakeStep();
    const onward = fakeStep();

    const kept = retainSegments([
      segment('Member Search', [first]),
      segment('Some Other Screen', [detour]),
      segment('Member Search', [second]),
      segment('Member Record', [onward]),
    ]);

    expect(kept.map((entry) => entry.screen)).toEqual(['Member Search', 'Member Record']);
    // Both visits to the returned-to screen are MERGED, not deduplicated: leaving and coming back
    // may have reset it, and re-doing a fill is harmless while skipping one is not.
    expect(kept[0]?.steps).toHaveLength(2);
  });

  it('removes only actions the run itself recorded as no-ops', () => {
    const real = fakeStep();
    const nothing = fakeStep({ noop: true, changedTargetValue: false });
    const kept = dropRecordedNoOps([segment('Member Search', [real, nothing])]);
    expect(kept[0]?.steps).toEqual([real]);
  });
});

describe('[MUST] parameterization scope', () => {
  const artifact = loadExample();

  it('ACCEPTS a declared enum value even though it is also an invocation value', () => {
    // "Savings" is both. A sweep that rejected it would reject every correct artifact this system
    // can produce.
    const issues = sweepParameterization({
      artifact,
      runtimeValues: ['10001', 'Savings', 'Vacation', '250.00', 'Avery Lin'],
    });
    expect(issues).toEqual([]);
  });

  it('REJECTS a member id baked into a row key', () => {
    const baked: CapabilityArtifact = {
      ...artifact,
      steps: artifact.steps.map((step) => {
        if (step.action.type === 'navigate') return step;
        const rowKey = step.action.target.semantic.rowKey;
        if (rowKey === undefined) return step;
        return {
          ...step,
          action: {
            ...step.action,
            target: {
              ...step.action.target,
              semantic: {
                ...step.action.target.semantic,
                rowKey: { cellText: { kind: 'literal' as const, value: '10001' } },
              },
            },
          },
        };
      }),
    };

    const issues = sweepParameterization({ artifact: baked, runtimeValues: ['10001'] });
    expect(issues.map((issue) => issue.code)).toContain('RUNTIME_VALUE_IN_ARTIFACT');
    expect(issues[0]?.message).toContain('rowKey');
  });

  it('REJECTS a runtime value that survived into a locator hint', () => {
    // Hints mentioning runtime values are DROPPED when the descriptor is built, never
    // parameterized: dynamic contextual text in a locator becomes over-permissive. Anything
    // reaching the sweep with one still in place is a bug, and it fails closed here.
    const leaked: CapabilityArtifact = {
      ...artifact,
      recordIdentity: {
        ...artifact.recordIdentity,
        target: {
          ...artifact.recordIdentity.target,
          semantic: {
            ...artifact.recordIdentity.target.semantic,
            nearbyText: ['Member Name: Avery Lin (10001)'],
          },
        },
      },
    };

    const issues = sweepParameterization({ artifact: leaked, runtimeValues: ['10001'] });
    expect(issues.map((issue) => issue.code)).toContain('RUNTIME_VALUE_IN_LOCATOR_HINT');
  });

  it('REJECTS an invocation value that reached an assertion', () => {
    const first = artifact.states[0];
    if (first === undefined) throw new Error('example artifact has no states');

    const leaked: CapabilityArtifact = {
      ...artifact,
      states: [
        {
          ...first,
          screenAssertions: [
            {
              id: 'leaky',
              kind: 'text_present',
              expected: { kind: 'literal', value: 'Avery Lin' },
              description: 'the member name is on screen',
            },
          ],
        },
        ...artifact.states.slice(1),
      ],
    };

    const issues = sweepParameterization({ artifact: leaked, runtimeValues: ['Avery Lin'] });
    expect(issues.map((issue) => issue.code)).toContain('RUNTIME_VALUE_IN_ARTIFACT');
  });
});

describe('reviewability lint', () => {
  const artifact = loadExample();

  it('passes the example artifact', () => {
    expect(reviewabilityLint(artifact)).toEqual([]);
  });

  it('[MUST] ACCEPTS a read step that has no expected effects', () => {
    // A read needs no transition. What it needs is a source that exists and a value that parses,
    // and both are the output binding's job. This is the documented exemption.
    const withRead: CapabilityArtifact = {
      ...artifact,
      steps: [
        ...artifact.steps,
        {
          id: 'step-read-status',
          intent: 'Read the status the application reports for the prepared request.',
          action: { type: 'read', target: artifact.recordIdentity.target },
          expectedEffects: [],
          invariants: [],
          wait: { timeoutMs: 10000, pollMs: 100 },
          risk: 'SAFE_REVERSIBLE',
          onFailure: 'fail',
          retries: { max: 0, backoffMs: [] },
        },
      ],
    };

    expect(reviewabilityLint(withRead)).toEqual([]);
  });

  it('[MUST] REJECTS a mutating step that proves nothing about what it did', () => {
    const blind: CapabilityArtifact = {
      ...artifact,
      steps: artifact.steps.map((step, index) =>
        index === 0 ? { ...step, expectedEffects: [] } : step,
      ),
    };
    expect(reviewabilityLint(blind).map((issue) => issue.code)).toContain('STEP_HAS_NO_EFFECTS');
  });

  it('REJECTS a step a reviewer could not check', () => {
    const thin: CapabilityArtifact = {
      ...artifact,
      steps: artifact.steps.map((step, index) =>
        index === 0 ? { ...step, intent: 'click' } : step,
      ),
    };
    expect(reviewabilityLint(thin).map((issue) => issue.code)).toContain('STEP_INTENT_TOO_THIN');
  });
});
