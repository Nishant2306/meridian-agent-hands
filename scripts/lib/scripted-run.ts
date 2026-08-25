import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createLegacyApp } from '../../fixtures/legacy-app/server.js';
import { tenantA } from '../../fixtures/legacy-app/tenants/tenant-a.js';
import { runDiscovery, type DiscoveryOutcome, type DiscoveryLimits } from '../../src/agent/loop.js';
import { conditionProfilePath, loadConditionProfile } from '../../src/artifact/profiles.js';
import { loadDiscoverySpec } from '../../src/config/spec.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { LeaseManager } from '../../src/session/lease.js';
import { SessionStateMachine } from '../../src/session/state.js';
import { launchDeterministicBrowser } from '../../src/surface/playwright-web/browser.js';
import { PlaywrightWebSurface } from '../../src/surface/playwright-web/surface.js';
import type { TargetDescriptor } from '../../src/types/control.js';
import type { EvidenceWriter } from '../../src/evidence/logger.js';
import type { ScriptedTurn } from './scripted-llm.js';
import { ScriptedLlmClient } from './scripted-llm.js';

const REPO = new URL('../..', import.meta.url);
export const SPEC_PATH = fileURLToPath(
  new URL('config/specs/prepare_subaccount_review.yaml', REPO),
);
export const CONFIG_ROOT = fileURLToPath(new URL('config', REPO));

const descriptor = (
  semantic: TargetDescriptor['semantic'],
  recordedTier: TargetDescriptor['recordedTier'],
): TargetDescriptor => ({ semantic, recordedTier });

const SIGN_ON = {
  operator: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Operator ID'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  passcode: descriptor(
    { role: 'textbox', nameMatch: 'normalized', nearbyText: ['Passcode'] },
    'T3_EXTERNAL_LABEL_OR_NEARBY',
  ),
  logIn: descriptor({ role: 'button', name: 'Log In', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME'),
};

export interface DiscoveryHarness {
  outcome: DiscoveryOutcome;
  client: ScriptedLlmClient;
}

/**
 * Boot the real fixture, drive the real browser, and run the real discovery loop with a SCRIPTED
 * client in place of a model.
 *
 * Everything except the model is genuine: a real accessibility tree, the real input path, the real
 * resolver, the real guardrails. That is the point - the parts worth testing are the ones between
 * the model and the screen.
 */
export interface ScriptedRunOptions {
  script: readonly ScriptedTurn[];
  runtimeInputs: Record<string, string>;
  limits?: Partial<DiscoveryLimits>;
  /** Supply one to write real run evidence. Tests leave it off; the dev command turns it on. */
  evidence?: EvidenceWriter;
  headless?: boolean;
}

export async function runScriptedDiscovery(options: ScriptedRunOptions): Promise<DiscoveryHarness> {
  const { app } = createLegacyApp({ tenant: tenantA });
  const server = app.listen(0);
  const origin = await new Promise<string>((resolve) => {
    server.on('listening', () => {
      const address = server.address() as AddressInfo;
      resolve('http://127.0.0.1:' + address.port);
    });
  });

  const browser = await launchDeterministicBrowser({ headless: options.headless ?? true });
  const lease = new LeaseManager();
  const session = new SessionStateMachine();
  const resolver = new DefaultTargetResolver();
  const loaded = loadDiscoverySpec(SPEC_PATH);

  const surface = new PlaywrightWebSurface({
    page: browser.page,
    context: browser.context,
    allowedOrigin: origin,
    lease,
    session,
    resolver,
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    values: {
      params: options.runtimeInputs,
      secrets: { operatorId: 'fixture-operator', operatorPasscode: 'fixture-passcode' },
    },
  });

  const token = lease.issue('AUTOMATION', 10 * 60 * 1000);
  const client = new ScriptedLlmClient(options.script);

  try {
    // Sign-on is a PRECONDITION, not part of the capability. See src/cli/discover.ts.
    await surface.resolveAndPerform({ type: 'navigate', pathSegments: [] }, token);
    await surface.resolveAndPerform(
      { type: 'type', target: SIGN_ON.operator, value: { kind: 'secretRef', name: 'operatorId' } },
      token,
    );
    await surface.resolveAndPerform(
      {
        type: 'type',
        target: SIGN_ON.passcode,
        value: { kind: 'secretRef', name: 'operatorPasscode' },
      },
      token,
    );
    await surface.resolveAndPerform({ type: 'click', target: SIGN_ON.logIn }, token);
    await surface.waitFor({ kind: 'text_present', text: 'Member Search' }, 15_000);

    const outcome = await runDiscovery({
      spec: loaded.spec,
      specHash: loaded.specHash,
      goal:
        'Find the member identified by parameter memberId, prepare the requested sub-account, and ' +
        'reach the review screen without submitting.',
      target: 'tenant-a',
      runtimeInputs: options.runtimeInputs,
      surface,
      token,
      lease,
      session,
      resolver,
      client,
      conditionProfile: loadConditionProfile(
        conditionProfilePath(CONFIG_ROOT, 'meridian-subaccount', '1.0.0'),
      ).profile,
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });

    return { outcome, client };
  } finally {
    await browser.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
