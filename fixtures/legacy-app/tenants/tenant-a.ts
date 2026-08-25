import type { TenantConfig } from './types.js';

/** Tenant A - the deployment discovery is recorded against. */
export const tenantA: TenantConfig = {
  id: 'tenant-a',
  port: 4180,
  brandName: 'MERIDIAN',
  productName: 'MERIDIAN Core Servicing',
  versionMarker: 'MERIDIAN Core v3.2.1',
  accountTypes: ['Savings', 'Checking'],
  subAccountFieldOrder: ['accountType', 'nickname', 'initialDeposit'],
  minimumDepositMinorUnits: 2500,
  labels: {
    loginHeading: 'Core Servicing Sign On',
    usernameField: 'Operator ID',
    passwordField: 'Passcode',
    loginButton: 'Log In',

    navHeading: 'Servicing',
    navSearchLink: 'Member Search',

    searchHeading: 'Member Search',
    memberIdField: 'Member ID',
    searchButton: 'Search',
    resultsHeading: 'Search Results',
    noResultsText: 'No member found for that ID.',
    resultsColumnMemberId: 'Member ID',
    resultsColumnName: 'Name',
    resultsColumnStatus: 'Status',
    resultsColumnAction: 'Action',
    resultsOpenLink: 'Open',

    memberHeading: 'Member Record',
    memberIdLabel: 'Member ID',
    memberNameLabel: 'Member Name',
    memberStatusLabel: 'Status',
    accountsHeading: 'Accounts',
    accountsColumnNumber: 'Account Number',
    accountsColumnType: 'Type',
    accountsColumnBalance: 'Balance',
    newSubAccountLink: 'New Sub-Account',

    subAccountHeading: 'New Sub-Account',
    accountTypeField: 'Account Type',
    accountTypePlaceholder: 'Select an account type',
    nicknameField: 'Nickname (optional)',
    initialDepositField: 'Initial Deposit',
    continueButton: 'Continue',

    reviewHeading: 'Review Sub-Account Request',
    reviewStatusLabel: 'Status',
    reviewStatusValue: 'PENDING REVIEW',
    backButton: 'Back',
    submitButton: 'Submit Request',
  },
};
