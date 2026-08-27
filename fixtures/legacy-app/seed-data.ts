/**
 * Fixture seed data.
 *
 * EVERY RECORD HERE IS INVENTED. The names are fictional, the identifiers are fictional, the
 * balances are fictional, and each record carries an explicit DUMMY DATA - NOT REAL stamp that is
 * rendered on screen. Nothing in this file is, resembles, or is derived from real person data.
 */

export const DUMMY_DATA_NOTICE = 'DUMMY DATA - NOT REAL';

export interface SeedAccount {
  readonly number: string;
  readonly type: string;
  /** Money is stored in MINOR UNITS server-side and rendered as currency text. Never a float. */
  readonly balanceMinorUnits: number;
}

export interface SeedMember {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly accounts: readonly SeedAccount[];
  /**
   * PHASE 6 flags. Carried as DATA in PHASE 1 and deliberately given NO BEHAVIOUR yet: fault
   * injection and known conditions are PHASE 6, and wiring behaviour to these now would be
   * building ahead. They live here so PHASE 6 does not have to reshape the seed set.
   */
  readonly flags: {
    readonly restricted: boolean;
    readonly knownNotice: boolean;
    /**
     * PHASE 8. Servicing this member raises a blocking modal that the pinned condition profile
     * deliberately does NOT describe, and that a PERSON can clear and the automation cannot.
     *
     * It is seed data rather than an armed fault so the handoff can be driven by hand with one
     * command and no setup: `npm run replay -- --params '{"memberId":"20001",...}'`. A demo that
     * needs three terminals to reproduce is a demo nobody reproduces.
     */
    readonly attestationRequired?: boolean;
  };
  readonly notice: typeof DUMMY_DATA_NOTICE;
}

export const SEED_MEMBERS: readonly SeedMember[] = [
  {
    id: '10001',
    name: 'Avery Lin',
    status: 'Active',
    accounts: [
      { number: '10001-01', type: 'Checking', balanceMinorUnits: 412355 },
      { number: '10001-02', type: 'Savings', balanceMinorUnits: 1875000 },
    ],
    flags: { restricted: false, knownNotice: false },
    notice: DUMMY_DATA_NOTICE,
  },
  {
    id: '10002',
    name: 'Jordan Reyes',
    status: 'Active',
    accounts: [{ number: '10002-01', type: 'Checking', balanceMinorUnits: 92140 }],
    flags: { restricted: false, knownNotice: false },
    notice: DUMMY_DATA_NOTICE,
  },
  {
    id: '10003',
    name: 'Casey Morgan',
    status: 'Active',
    accounts: [{ number: '10003-01', type: 'Savings', balanceMinorUnits: 3050025 }],
    // PHASE 6: restricted member. No behaviour attached yet.
    flags: { restricted: true, knownNotice: false },
    notice: DUMMY_DATA_NOTICE,
  },
  {
    id: '10004',
    name: 'Riley Chen',
    status: 'Active',
    accounts: [{ number: '10004-01', type: 'Checking', balanceMinorUnits: 15000 }],
    // PHASE 6: member with a known notice condition - a RECOVERY the automation clears itself.
    flags: { restricted: false, knownNotice: true },
    notice: DUMMY_DATA_NOTICE,
  },
  {
    // PHASE 8: the handoff subject.
    //
    // The id deliberately does NOT contain "1000", so it stays out of the four-row partial-search
    // case that `T5_STRUCTURAL_ROW` depends on.
    id: '20001',
    name: 'Dana Whitfield',
    status: 'Active',
    accounts: [{ number: '20001-01', type: 'Checking', balanceMinorUnits: 88250 }],
    flags: { restricted: false, knownNotice: false, attestationRequired: true },
    notice: DUMMY_DATA_NOTICE,
  },
];

/**
 * 99999 is deliberately ABSENT from SEED_MEMBERS.
 *
 * It is the fixture's MEMBER_NOT_FOUND case, and it is a BUSINESS OUTCOME, not an error: the
 * automation worked perfectly and the answer is "there is no such member".
 */
export const ABSENT_MEMBER_ID = '99999';

export function findMemberById(id: string): SeedMember | undefined {
  return SEED_MEMBERS.find((member) => member.id === id);
}

/** Substring match on id or name - legacy search behaviour, and what makes a partial ID ambiguous. */
export function searchMembers(query: string): readonly SeedMember[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return SEED_MEMBERS.filter(
    (member) =>
      member.id.toLowerCase().includes(needle) || member.name.toLowerCase().includes(needle),
  );
}
