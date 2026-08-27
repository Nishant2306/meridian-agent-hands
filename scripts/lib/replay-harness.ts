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
import { SessionBroker, type BrokeredSession } from '../../src/replay/session-broker.js';
import { HandoffCoordinator } from '../../src/escalation/handoff.js';
import type { Intervention } from '../../src/types/intervention.js';
import type { LeaseToken } from '../../src/types/session.js';
import type { Surface } from '../../src/types/surface.js';
import { validateInvocationParams } from '../../src/artifact/params.js';
import type { FaultFlags } from '../../fixtures/legacy-app/faults.js';

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
  /**
   * Faults to arm on the session this run signs on with, AFTER sign-on and BEFORE the first step.
   *
   * Armed against the application's own session id rather than a server-wide switch: this harness
   * boots a fresh app per call, but a global flag here would still be a global flag in the fixture,
   * and the point of keying by session is that it cannot be got wrong later.
   */
  faults?: FaultFlags;
  /**
   * Kill the browser this many ms into the run. Really closes a real Chromium, so the engine sees
   * exactly what it would see if the process died under it.
   */
  killBrowserAfterMs?: number;
  /**
   * Stand in for the operator.
   *
   * Called while the run is PAUSED and the HUMAN lease is held. Whatever it does with the surface,
   * it does as the human - the AUTOMATION token is already dead at that point. Returning 'resume'
   * hands control back and the SYSTEM decides the outcome; returning 'abort' cancels the run.
   */
  onEscalation?: (context: {
    intervention: Intervention;
    surface: Surface;
    humanToken: LeaseToken;
    coordinator: HandoffCoordinator;
  }) => Promise<'resume' | 'abort'>;
  maxInterventions?: number;
}): Promise<ReplayOutcome & { sameSession?: boolean }> {
  const validation = validateInvocationParams(options.artifact.inputs, options.params);

  const { app, faults } = createLegacyApp({ tenant: tenantA });
  const server = app.listen(0);
  const origin = await new Promise<string>((resolve) => {
    server.on('listening', () => {
      const address = server.address() as AddressInfo;
      resolve('http://127.0.0.1:' + address.port);
    });
  });

  const resolver = new DefaultTargetResolver();
  const coordinator = new HandoffCoordinator();

  /**
   * The engine does not know what a console is. It calls this, and this drives the REAL control
   * transfer: pause, release the AUTOMATION lease, issue a HUMAN one, let the operator act, then
   * take the lease back. The operator here is a callback rather than a person, and everything
   * around it - the lease, the session state, the identity evidence - is the same code the headed
   * console uses.
   */
  const escalation =
    options.onEscalation === undefined
      ? undefined
      : {
          escalate: async (request: { intervention: Intervention }) => {
            const record = await coordinator.cede({
              surface: brokeredRef.session.surface,
              lease: brokeredRef.session.lease,
              session: brokeredRef.session.session,
              ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
              interventionId: request.intervention.id,
              reason: request.intervention.stopReason,
            });

            const choice = await options.onEscalation!({
              intervention: request.intervention,
              surface: brokeredRef.session.surface,
              humanToken: record.humanToken,
              coordinator,
            });

            const reclaimed = await coordinator.reclaim({
              surface: brokeredRef.session.surface,
              lease: brokeredRef.session.lease,
              session: brokeredRef.session.session,
              ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
            });

            if (choice === 'abort') return { choice: 'abort' as const, notes: '' };
            return {
              choice: 'resume' as const,
              notes: '',
              humanEvents: reclaimed.humanEvents,
              token: reclaimed.token,
              sameSession: coordinator.sameSession(),
            };
          },
        };

  const brokeredRef: { session: BrokeredSession } = { session: undefined as never };

  const engine = new ReplayEngine({
    resolver,
    ...(escalation === undefined ? {} : { escalation }),
    conditionProfile: loadConditionProfile(
      conditionProfilePath(CONFIG_ROOT, 'meridian-subaccount', '1.0.0'),
    ).profile,
    configRoot: CONFIG_ROOT,
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    ...(options.maxInterventions === undefined
      ? {}
      : { maxInterventions: options.maxInterventions }),
  });

  const broker = new SessionBroker();
  brokeredRef.session = await broker.open({
    origin,
    secrets: fixtureCredentials(),
    params: validation.params,
    resolver,
    headless: options.headless ?? true,
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
  });

  const brokered = brokeredRef.session;

  try {
    if (options.faults !== undefined) {
      const sessionId = await brokered.applicationSessionId();
      if (sessionId === undefined) throw new Error('signed on but no session cookie to arm');
      faults.set(sessionId, options.faults);
    }

    let killer: NodeJS.Timeout | undefined;
    if (options.killBrowserAfterMs !== undefined) {
      killer = setTimeout(() => {
        void brokered.close();
      }, options.killBrowserAfterMs);
    }

    try {
      const outcome = await engine.run({
        artifact: options.artifact,
        params: options.params,
        surface: brokered.surface,
        token: brokered.token,
      });
      return {
        ...outcome,
        sameSession: coordinator.record === null ? undefined : coordinator.sameSession(),
      };
    } finally {
      if (killer !== undefined) clearTimeout(killer);
    }
  } finally {
    await brokered.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
