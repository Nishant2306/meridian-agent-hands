import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { conditionProfilePath, loadConditionProfile } from '../src/artifact/profiles.js';
import { CapabilityArtifactSchema, type CapabilityArtifact } from '../src/artifact/schema.js';
import { DefaultTargetResolver } from '../src/perception/resolver.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { validateInvocationParams } from '../src/artifact/params.js';
import type { LeaseToken } from '../src/types/session.js';
import type { Surface } from '../src/types/surface.js';

const REPO = new URL('..', import.meta.url);
const CONFIG_ROOT = fileURLToPath(new URL('config', REPO));
const EXAMPLE = fileURLToPath(
  new URL('examples/artifacts/prepare_subaccount_review@1.0.0.example.json', REPO),
);

function loadExample(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
}

/**
 * A surface that records whether it was touched at all.
 *
 * This is how "before the browser opens" is proven rather than asserted. The first two steps of
 * the execution order - caller parameters, then the pinned profiles - must reach a verdict without
 * observing anything, and any use of this stub is a failure.
 */
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

const TOKEN: LeaseToken = { leaseId: 'test', owner: 'AUTOMATION', expiresAt: Date.now() + 60_000 };

function engineWith(configRoot: string): ReplayEngine {
  return new ReplayEngine({
    resolver: new DefaultTargetResolver(),
    conditionProfile: loadConditionProfile(
      conditionProfilePath(CONFIG_ROOT, 'meridian-subaccount', '1.0.0'),
    ).profile,
    configRoot,
  });
}

describe('[MUST] execution order: our contract is checked before anything is opened', () => {
  it('rejects a member id of "abc" without touching the surface', async () => {
    const { surface, touched } = untouchableSurface();
    const outcome = await engineWith(CONFIG_ROOT).run({
      artifact: loadExample(),
      params: { memberId: 'abc', accountType: 'Savings', initialDeposit: '250.00' },
      surface,
      token: TOKEN,
    });

    expect(touched()).toBe(false);
    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('INPUT_VALIDATION_FAILED');
    expect(outcome.result.observed).toContain('memberId');
  });

  it('rejects a missing required parameter, and an undeclared one', async () => {
    const { surface } = untouchableSurface();
    const outcome = await engineWith(CONFIG_ROOT).run({
      artifact: loadExample(),
      params: { memberId: '10001', accountType: 'Savings', surprise: 'x' },
      surface,
      token: TOKEN,
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.observed).toContain('initialDeposit');
    expect(outcome.result.observed).toContain('surprise');
  });

  it('rejects an enum value the contract does not declare', () => {
    const validation = validateInvocationParams(loadExample().inputs, {
      memberId: '10001',
      accountType: 'Brokerage',
      initialDeposit: '250.00',
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.join(' ')).toContain('Savings, Checking');
  });

  it('accepts an omitted OPTIONAL parameter, and records that it was not supplied', () => {
    const validation = validateInvocationParams(loadExample().inputs, {
      memberId: '10001',
      accountType: 'Savings',
      initialDeposit: '250.00',
    });
    expect(validation.ok).toBe(true);
    expect(validation.supplied.has('nickname')).toBe(false);
    expect(validation.supplied.has('memberId')).toBe(true);
  });

  it('[MUST] PROFILE_INTEGRITY_FAILURE before the surface is touched', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'config-'));
    cpSync(CONFIG_ROOT, scratch, { recursive: true });

    // One added comment. Nothing semantic. The pin still has to fail.
    const profile = join(scratch, 'condition-profiles/meridian-subaccount/1.0.0.yaml');
    writeFileSync(profile, readFileSync(profile, 'utf8') + '# tampered' + String.fromCharCode(10));

    const { surface, touched } = untouchableSurface();
    const outcome = await engineWith(scratch).run({
      artifact: loadExample(),
      params: { memberId: '10001', accountType: 'Savings', initialDeposit: '250.00' },
      surface,
      token: TOKEN,
    });

    expect(touched()).toBe(false);
    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status !== 'failed') return;
    expect(outcome.result.error).toBe('PROFILE_INTEGRITY_FAILURE');
  });

  it('reports zero llm calls even on a run that failed early', async () => {
    const { surface } = untouchableSurface();
    const outcome = await engineWith(CONFIG_ROOT).run({
      artifact: loadExample(),
      params: { memberId: 'abc' },
      surface,
      token: TOKEN,
    });
    expect(outcome.result.metrics.llmCalls).toBe(0);
  });
});
