import type { Frame } from 'playwright';

/**
 * Playwright AriaRole is a large string union that is not exported from the package root. The
 * addressing recipe already restricts itself to ADDRESSABLE_ARIA_ROLES before a role ever reaches
 * getByRole, so this alias documents the narrowing rather than widening anything.
 */
export type AriaRole = Parameters<Frame['getByRole']>[0];
