import { MERIDIAN_SIGN_ON, type SignOnConfig } from '../config/sign-on.js';
import type { EvidenceWriter } from '../evidence/logger.js';
import { DefaultTargetResolver } from '../perception/resolver.js';
import { LeaseManager } from '../session/lease.js';
import { SessionStateMachine } from '../session/state.js';
import { launchDeterministicBrowser } from '../surface/playwright-web/browser.js';
import { PlaywrightWebSurface } from '../surface/playwright-web/surface.js';
import type { ValueSources } from '../surface/values.js';
import type { LeaseToken } from '../types/session.js';
import type { Surface, TargetResolver } from '../types/surface.js';

/**
 * ==============================================================================================
 * [MUST] THE SESSION BROKER. THE CAPABILITY BEGINS AT "AUTHENTICATED, ON THE ENTRY SCREEN".
 * ==============================================================================================
 *
 * Open the allowlisted origin, authenticate via SECRET REFERENCES, navigate to the canonical entry
 * point, verify the authenticated precondition, and hand the live session over.
 *
 * The same broker serves discovery and replay, which is the point: both begin from the same place,
 * so a capability recorded by one is executable by the other without either of them knowing how to
 * log in. Credentials stay out of the artifact entirely - there is no field in the schema that
 * could hold one.
 *
 * Everything here goes through the ONE input path, so the origin allowlist and the lease apply to
 * sign-on exactly as they apply to the capability.
 */
export interface BrokeredSession {
  surface: Surface;
  token: LeaseToken;
  lease: LeaseManager;
  session: SessionStateMachine;
  resolver: TargetResolver;
  origin: string;
  close(): Promise<void>;
}

export interface SessionBrokerOptions {
  /** The single origin anything in this session is permitted to touch. */
  origin: string;
  secrets: Record<string, string>;
  params?: Record<string, string>;
  signOn?: SignOnConfig;
  headless?: boolean;
  evidence?: EvidenceWriter;
  resolver?: TargetResolver;
  leaseTtlMs?: number;
  timeoutMs?: number;
}

export class AuthenticationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationFailedError';
  }
}

export class SessionBroker {
  async open(options: SessionBrokerOptions): Promise<BrokeredSession> {
    const signOn = options.signOn ?? MERIDIAN_SIGN_ON;
    const resolver = options.resolver ?? new DefaultTargetResolver();
    const browser = await launchDeterministicBrowser({ headless: options.headless ?? true });
    const lease = new LeaseManager();
    const session = new SessionStateMachine();

    const values: ValueSources = {
      ...(options.params === undefined ? {} : { params: options.params }),
      secrets: options.secrets,
    };

    const surface = new PlaywrightWebSurface({
      page: browser.page,
      context: browser.context,
      allowedOrigin: options.origin,
      lease,
      session,
      resolver,
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
      values,
    });

    const token = lease.issue('AUTOMATION', options.leaseTtlMs ?? 10 * 60 * 1000);
    const close = async (): Promise<void> => {
      await browser.close();
    };

    try {
      await surface.resolveAndPerform({ type: 'navigate', pathSegments: [] }, token);
      await surface.resolveAndPerform(
        {
          type: 'type',
          target: signOn.operator,
          value: { kind: 'secretRef', name: signOn.operatorSecretRef },
        },
        token,
      );
      await surface.resolveAndPerform(
        {
          type: 'type',
          target: signOn.passcode,
          value: { kind: 'secretRef', name: signOn.passcodeSecretRef },
        },
        token,
      );
      await surface.resolveAndPerform({ type: 'click', target: signOn.submit }, token);

      // Verify the precondition rather than assuming it. A broker that hands over an
      // unauthenticated session makes every downstream failure look like a capability defect.
      const authenticated = await surface.waitFor(
        { kind: 'text_present', text: signOn.authenticatedText },
        options.timeoutMs ?? 15_000,
      );
      if (!authenticated) {
        throw new AuthenticationFailedError(
          'signed on, but "' +
            signOn.authenticatedText +
            '" never appeared, so the session is ' +
            'not on the entry screen',
        );
      }
    } catch (error) {
      await close();
      throw error;
    }

    return { surface, token, lease, session, resolver, origin: options.origin, close };
  }
}
