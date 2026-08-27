/**
 * ================================================================================================
 * FAULT INJECTION - SCOPED PER SESSION, NEVER SERVER-WIDE.
 * ================================================================================================
 *
 * [MUST] A global "the app is now broken" flag would be simpler and would be wrong here. The test
 * suite runs vitest files in parallel against one fixture module, and a fault set by the session
 * that is testing SESSION_EXPIRED would be observed by the session that is testing a slow load. The
 * failures would be intermittent, would move when tests were reordered, and would look like flaky
 * infrastructure rather than a design mistake. Faults are therefore keyed by the same identity the
 * application already uses for everything else: the session.
 *
 * A fault set is addressed by either
 *   - the MERIDIAN_SESSIONID cookie, which is what a browser-driven test has, or
 *   - an `X-Fault-Session` header, which is what a plain `fetch` test has before it signs on.
 *
 * The header exists because a test may need faults ARMED BEFORE the session it will affect is
 * created - `expireSession` is the obvious case. The header is only ever read by `/__test__/faults`
 * and by the fault lookup; it is not an authentication mechanism and grants nothing.
 *
 * ALL RENDERED TEXT MUST MATCH THE PINNED CONDITION PROFILE. The profile
 * (config/condition-profiles/meridian-subaccount/1.0.0.yaml) was finalized in PHASE 3, its SHA-256
 * is pinned into every artifact, and the artifact approved at GATE 1 depends on it. The strings
 * below are therefore fixed points: if a detector does not match, the fixture is wrong.
 */

/** Every flag is optional; an absent flag means "behave normally". */
export interface FaultFlags {
  /** Delay every servicing response by this many ms. Tests a BOUNDED wait, not a failure. */
  readonly slowLoadMs?: number;
  /** Show the scheduled-maintenance notice - a RECOVERY the automation may clear itself. */
  readonly showKnownNotice?: boolean;
  /** Show a blocking modal that the condition profile deliberately does NOT describe. */
  readonly showUnknownModal?: boolean;
  /** Answer every servicing screen with the session-expired page. */
  readonly expireSession?: boolean;
  /**
   * NOTE THE NAME. The capability stops at the review screen and never submits, so a submit-time
   * error would be unreachable by anything this system can do. This fires on form -> review, which
   * is a transition the capability actually performs.
   */
  readonly validationErrorOnContinue?: boolean;
  /** Answer this exact path with the application-unavailable page. */
  readonly http500OnRoute?: string;
  /** Answer member screens with the permission-denied panel. */
  readonly denyPermission?: boolean;
  /**
   * Relabel the Continue button, keeping its legacy-stable `name=` attribute.
   *
   * This is DRIFT, not a fault: the vendor reworded a button and everything still works. It exists
   * so a real replay can be driven against a screen that resolves ONE TIER WEAKER than recorded -
   * T1_EXACT_ROLE_NAME falls to T4_STABLE_ATTRIBUTE - which is the only way to prove that
   * `downgraded` actually reaches the step result, the evidence file and
   * metrics.locatorTierDowngrades. PHASE 10 quotes that number.
   */
  readonly relabelContinueButton?: string;
}

export const FAULT_SESSION_HEADER = 'x-fault-session';

/**
 * Text the fixture must render for each detector in the pinned profile.
 *
 * Reproduced here as named constants rather than inline strings so that the fixture and the
 * contract test refer to the same thing. A test that asserted an inline copy would pass while the
 * page said something else.
 */
export const FAULT_TEXT = {
  /** profile: hardFailures/permission-denied, phrase "You do not have permission" */
  permissionDenied: 'You do not have permission to view this member.',
  /** profile: hardFailures/session-expired, phrase "Your session has expired" */
  sessionExpired: 'Your session has expired. Please sign on again.',
  /** profile: hardFailures/application-unavailable */
  applicationUnavailable: 'The application is temporarily unavailable. Please try again shortly.',
  /** profile: recoveries/DISMISS_MAINTENANCE_NOTICE, phrase "Scheduled maintenance" */
  maintenanceNotice:
    'Scheduled maintenance is in progress. Some functions may respond slowly.' +
    ' This notice can be dismissed.',
  /** profile: recoveries/DISMISS_MAINTENANCE_NOTICE, button named EXACTLY "Dismiss" */
  dismissButton: 'Dismiss',
  /**
   * DELIBERATELY ABSENT FROM THE PROFILE. This is the PHASE 8 trigger: a blocking state nobody
   * described, which must reach a human rather than be guessed past. If a detector is ever written
   * for this string, this fixture stops testing what it exists to test.
   */
  unknownModal: 'Compliance attestation required',
  /** Shown ON SCREEN in the modal. The server accepts any non-empty value; see the route. */
  attestationCode: '4417',
  unknownModalBody:
    'Compliance attestation required before this record may be serviced.' +
    ' Contact your supervisor for the attestation code.',
} as const;

/**
 * Per-session fault store.
 *
 * Deliberately a plain Map with no expiry: the fixture is a test double whose process lives for the
 * length of a test file. A TTL here would be machinery in service of nothing.
 */
export class FaultStore {
  readonly #bySession = new Map<string, FaultFlags>();

  set(sessionKey: string, flags: FaultFlags): void {
    this.#bySession.set(sessionKey, flags);
  }

  clear(sessionKey: string): void {
    this.#bySession.delete(sessionKey);
  }

  /**
   * Faults for this request. The header wins over the cookie so a test can arm faults for a
   * session it has not created yet, and so an armed header cannot be silently ignored once the
   * session exists.
   */
  for(keys: {
    readonly header?: string | undefined;
    readonly cookie?: string | undefined;
  }): FaultFlags {
    const fromHeader = keys.header === undefined ? undefined : this.#bySession.get(keys.header);
    if (fromHeader !== undefined) return fromHeader;
    const fromCookie = keys.cookie === undefined ? undefined : this.#bySession.get(keys.cookie);
    return fromCookie ?? {};
  }

  /** Test-visible size, so a test can prove isolation rather than assume it. */
  get size(): number {
    return this.#bySession.size;
  }
}

/**
 * Seeded members carry behaviour from PHASE 6 onward. Until now `restricted` and `knownNotice` were
 * DATA with nothing attached, which is what made them safe to add in PHASE 1.
 *
 * A seeded member is the more honest test subject than a flag: a caller asking about member 10003
 * gets PERMISSION_DENIED without anyone having armed anything, which is how the real system would
 * behave. The flags exist for the conditions that are not a property of one record.
 */
export function seededFaultsFor(member: {
  restricted?: boolean;
  knownNotice?: boolean;
  attestationRequired?: boolean;
}): FaultFlags {
  return {
    ...(member.restricted === true ? { denyPermission: true } : {}),
    ...(member.knownNotice === true ? { showKnownNotice: true } : {}),
    ...(member.attestationRequired === true ? { showUnknownModal: true } : {}),
  };
}

/** Faults in effect for a request, merging the session's armed flags with the member's own. */
export function mergeFaults(session: FaultFlags, seeded: FaultFlags): FaultFlags {
  return { ...seeded, ...session };
}
