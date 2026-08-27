import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runDiscovery } from '../../src/agent/loop.js';
import { conditionProfilePath, loadConditionProfile } from '../../src/artifact/profiles.js';
import { loadDiscoverySpec } from '../../src/config/spec.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { LeaseManager } from '../../src/session/lease.js';
import { SessionStateMachine } from '../../src/session/state.js';
import type { LlmClient } from '../../src/agent/llm-client.js';
import type { LeaseToken } from '../../src/types/session.js';
import type { Surface } from '../../src/types/surface.js';

/**
 * ================================================================================================
 * DISCOVERY REACHES A VERDICT ON BAD ARGUMENTS BEFORE THE BROWSER OPENS OR THE MODEL IS CALLED.
 * ================================================================================================
 *
 * This is the replay property (tests/replay.test.ts, "the surface was used before it should have
 * been") applied to the other half of the system, and it is here because it was once absent.
 * A discovery run invoked with `--inputs '{}'` launched Chromium, signed on, and spent three model
 * calls before the missing parameter surfaced as EFFECT_NOT_OBSERVED - a code that describes the
 * symptom three actions downstream of the cause, on a bill that had already been paid.
 *
 * The stubs below follow the same pattern as `untouchableSurface`: plain data properties are real,
 * and every method throws. `model` is a data property on LlmClient exactly as `id` and `kind` are
 * on Surface, so reading it is not "calling the provider" - `complete()` is.
 */

const REPO = new URL('../..', import.meta.url);
const CONFIG_ROOT = fileURLToPath(new URL('config', REPO));
const SPEC = fileURLToPath(new URL('config/specs/prepare_subaccount_review.yaml', REPO));

function untouchableSurface(): { surface: Surface; touched: () => boolean } {
  let used = false;
  const refuse = (): never => {
    used = true;
    throw new Error('the surface was used before it should have been');
  };

  const surface: Surface = {
    id: 'untouchable',
    kind: 'legacy_web',
    observe: () => Promise.resolve(refuse()),
    resolveAndPerform: () => Promise.resolve(refuse()),
    waitFor: () => Promise.resolve(refuse()),
    screenIdentity: () => Promise.resolve(refuse()),
    captureEvidence: () => Promise.resolve(refuse()),
    exposeForHuman: () => Promise.resolve(refuse()),
    close: () => Promise.resolve(),
  };

  return { surface, touched: () => used };
}

function untouchableClient(): { client: LlmClient; called: () => boolean } {
  let used = false;

  const client: LlmClient = {
    model: 'untouchable-model',
    complete: () => {
      used = true;
      throw new Error('the model was called before it should have been');
    },
  };

  return { client, called: () => used };
}

const TOKEN: LeaseToken = {
  leaseId: 'test',
  owner: 'AUTOMATION',
  expiresAt: Date.now() + 60_000,
};

/**
 * Returns the outcome when the gate REJECTS, and `outcome: null` when it lets the run through and
 * the untouchable stub then throws. Both are results, not accidents: which one happened is exactly
 * what these tests are measuring.
 */
async function discoverWith(runtimeInputs: Record<string, string>): Promise<{
  outcome: Awaited<ReturnType<typeof runDiscovery>> | null;
  touched: boolean;
  called: boolean;
}> {
  const loaded = loadDiscoverySpec(SPEC);
  const { surface, touched } = untouchableSurface();
  const { client, called } = untouchableClient();

  const outcome = await runDiscoveryCatching({
    spec: loaded.spec,
    specHash: loaded.specHash,
    goal: loaded.spec.goalTemplate,
    target: '10001',
    runtimeInputs,
    surface,
    token: TOKEN,
    lease: new LeaseManager(),
    session: new SessionStateMachine(),
    resolver: new DefaultTargetResolver(),
    client,
    conditionProfile: loadConditionProfile(
      conditionProfilePath(CONFIG_ROOT, 'meridian-subaccount', '1.0.0'),
    ).profile,
  });

  return { outcome, touched: touched(), called: called() };
}

/** The stubs throw by design once they are reached. A throw here is data, not a test failure. */
async function runDiscoveryCatching(
  options: Parameters<typeof runDiscovery>[0],
): Promise<Awaited<ReturnType<typeof runDiscovery>> | null> {
  try {
    return await runDiscovery(options);
  } catch {
    return null;
  }
}

describe('runDiscovery validates arguments before touching anything', () => {
  it('rejects empty inputs without observing the screen or calling the model', async () => {
    // The exact invocation that cost three model calls.
    const { outcome, touched, called } = await discoverWith({});

    expect(outcome).not.toBeNull();
    expect(outcome?.result.status).toBe('failed');
    expect(outcome?.result.status === 'failed' && outcome.result.error).toBe(
      'INPUT_VALIDATION_FAILED',
    );
    expect(touched).toBe(false);
    expect(called).toBe(false);
    expect(outcome?.result.metrics.llmCalls).toBe(0);
    expect(outcome?.result.metrics.steps).toBe(0);
  });

  it('names the missing required parameter rather than the symptom', async () => {
    const { outcome } = await discoverWith({});

    const observed = outcome?.result.status === 'failed' ? outcome.result.observed : '';
    expect(observed).toContain('"memberId" is required');
    // The old failure mode. EFFECT_NOT_OBSERVED is true and useless here: the effect was not
    // observed BECAUSE the parameter was never supplied, three actions earlier.
    expect(outcome?.result.status === 'failed' && outcome.result.error).not.toBe(
      'EFFECT_NOT_OBSERVED',
    );
  });

  it('rejects a value that violates its declared pattern', async () => {
    const { outcome, touched, called } = await discoverWith({
      memberId: 'abc',
      accountType: 'Savings',
      initialDeposit: '250.00',
    });

    const observed = outcome?.result.status === 'failed' ? outcome.result.observed : '';
    expect(observed).toContain('"memberId" must match');
    expect(touched).toBe(false);
    expect(called).toBe(false);
  });

  it('rejects a value outside a declared enum', async () => {
    const { outcome } = await discoverWith({
      memberId: '10001',
      accountType: 'Brokerage',
      initialDeposit: '250.00',
    });

    const observed = outcome?.result.status === 'failed' ? outcome.result.observed : '';
    expect(observed).toContain('"accountType" must be one of');
  });

  it('rejects an undeclared parameter instead of silently ignoring it', async () => {
    const { outcome } = await discoverWith({
      memberId: '10001',
      accountType: 'Savings',
      initialDeposit: '250.00',
      overdraftLimit: '500.00',
    });

    // Silently dropping it would let a caller believe a value was used when it never was.
    const observed = outcome?.result.status === 'failed' ? outcome.result.observed : '';
    expect(observed).toContain('"overdraftLimit" is not a declared input');
  });

  it('still records a run: a rejected invocation produces evidence, not an exception', async () => {
    const { outcome } = await discoverWith({});

    // The record is what a reviewer reads. A run that failed validation must still say what it was
    // asked to do and against which spec.
    expect(outcome?.record.specHash).toHaveLength(64);
    expect(outcome?.record.target).toBe('10001');
    expect(outcome?.record.observations).toHaveLength(0);
    expect(outcome?.record.steps).toHaveLength(0);
    expect(outcome?.record.successObservationId).toBeNull();
  });

  it('lets a fully valid invocation past the gate and on to the surface', async () => {
    // The negative control. Without it, a gate that rejected EVERYTHING would pass every test
    // above - the one way this file could lie.
    const { touched, called } = await discoverWith({
      memberId: '10001',
      accountType: 'Savings',
      nickname: 'Vacation',
      initialDeposit: '250.00',
    });

    // Valid arguments get past validation and the loop reaches for the screen, which is the very
    // next thing it does. The untouchable surface then throws, and that throw IS the proof: the
    // gate is discriminating between argument lists rather than refusing everything.
    expect(touched).toBe(true);
    expect(called).toBe(false);
  });
});
