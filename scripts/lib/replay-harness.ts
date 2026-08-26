import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createLegacyApp } from '../../fixtures/legacy-app/server.js';
import { tenantA } from '../../fixtures/legacy-app/tenants/tenant-a.js';
import { conditionProfilePath, loadConditionProfile } from '../../src/artifact/profiles.js';
import type { CapabilityArtifact } from '../../src/artifact/schema.js';
import type { EvidenceWriter } from '../../src/evidence/logger.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { fixtureCredentials } from '../../src/config/sign-on.js';
import { ReplayEngine, type ReplayOutcome } from '../../src/replay/engine.js';
import { SessionBroker } from '../../src/replay/session-broker.js';
import { validateInvocationParams } from '../../src/artifact/params.js';

const REPO = new URL('../..', import.meta.url);
export const CONFIG_ROOT = fileURLToPath(new URL('config', REPO));

/**
 * Boot the fixture, broker an authenticated session, and replay an artifact against it.
 *
 * The parameter validation happens BEFORE the browser opens, which is the execution order the
 * engine mandates - so a bad parameter costs nothing, and the harness proves that by never
 * reaching `broker.open`.
 */
export async function replayAgainstFixture(options: {
  artifact: CapabilityArtifact;
  params: Record<string, unknown>;
  evidence?: EvidenceWriter;
  headless?: boolean;
}): Promise<ReplayOutcome> {
  const validation = validateInvocationParams(options.artifact.inputs, options.params);

  const { app } = createLegacyApp({ tenant: tenantA });
  const server = app.listen(0);
  const origin = await new Promise<string>((resolve) => {
    server.on('listening', () => {
      const address = server.address() as AddressInfo;
      resolve('http://127.0.0.1:' + address.port);
    });
  });

  const resolver = new DefaultTargetResolver();
  const engine = new ReplayEngine({
    resolver,
    conditionProfile: loadConditionProfile(
      conditionProfilePath(CONFIG_ROOT, 'meridian-subaccount', '1.0.0'),
    ).profile,
    configRoot: CONFIG_ROOT,
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
  });

  const broker = new SessionBroker();
  const brokered = await broker.open({
    origin,
    secrets: fixtureCredentials(),
    params: validation.params,
    resolver,
    headless: options.headless ?? true,
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
  });

  try {
    return await engine.run({
      artifact: options.artifact,
      params: options.params,
      surface: brokered.surface,
      token: brokered.token,
    });
  } finally {
    await brokered.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
