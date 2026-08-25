/**
 * The tenant seam.
 *
 * This exists in PHASE 1, before anything uses it, on purpose. Cross-tenant support is PHASE 11,
 * and retrofitting a tenant parameter into a fixture that has hard-coded strings everywhere is a
 * rewrite, not a refactor. Every user-visible string, the field order, the branding and the version
 * marker come from this object - so a second tenant is a config file, not a code change.
 *
 * A capability discovered against tenant A must survive tenant B renaming "Continue" to "Next" and
 * reordering the form. That is the test PHASE 11 will run. The seam is what makes it possible.
 */
export type SubAccountField = 'accountType' | 'nickname' | 'initialDeposit';

export interface TenantLabels {
  readonly loginHeading: string;
  readonly usernameField: string;
  readonly passwordField: string;
  readonly loginButton: string;

  readonly navHeading: string;
  readonly navSearchLink: string;

  readonly searchHeading: string;
  readonly memberIdField: string;
  readonly searchButton: string;
  readonly resultsHeading: string;
  readonly noResultsText: string;
  readonly resultsColumnMemberId: string;
  readonly resultsColumnName: string;
  readonly resultsColumnStatus: string;
  readonly resultsColumnAction: string;
  readonly resultsOpenLink: string;

  readonly memberHeading: string;
  readonly memberIdLabel: string;
  readonly memberNameLabel: string;
  readonly memberStatusLabel: string;
  readonly accountsHeading: string;
  readonly accountsColumnNumber: string;
  readonly accountsColumnType: string;
  readonly accountsColumnBalance: string;
  readonly newSubAccountLink: string;

  readonly subAccountHeading: string;
  readonly accountTypeField: string;
  readonly accountTypePlaceholder: string;
  readonly nicknameField: string;
  readonly initialDepositField: string;
  readonly continueButton: string;

  readonly reviewHeading: string;
  readonly reviewStatusLabel: string;
  readonly reviewStatusValue: string;
  readonly backButton: string;
  readonly submitButton: string;
}

export interface TenantConfig {
  readonly id: string;
  /**
   * The port this tenant's deployment listens on.
   *
   * It lives here, not in a code constant and not in an environment variable, because PHASE 11
   * adds a second tenant on a second port. A deployment's address is part of the deployment's
   * configuration, so the tenant config owns it.
   */
  readonly port: number;
  readonly brandName: string;
  readonly productName: string;
  /** Rendered in the page footer. Perception reads it; compatibility.versionRange gates on it. */
  readonly versionMarker: string;
  readonly accountTypes: readonly string[];
  /** Tenants reorder their forms. Discovery must not depend on field order. */
  readonly subAccountFieldOrder: readonly SubAccountField[];
  readonly minimumDepositMinorUnits: number;
  readonly labels: TenantLabels;
}
