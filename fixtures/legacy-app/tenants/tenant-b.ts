/**
 * TODO (PHASE 11) - Tenant B.
 *
 * Deliberately NOT implemented in PHASE 1. Build order is vertical: shipping a second tenant now
 * would mean building the cross-tenant story before the first capability exists, and a tenant-B
 * config written today would be guesswork about which differences actually matter.
 *
 * When PHASE 11 arrives, tenant B should differ from tenant A along the axes that a real second
 * deployment of the same vendor product differs - the ones that break brittle automation and must
 * NOT break a semantic capability:
 *
 *   - different branding and product name, same underlying product
 *   - "Continue" renamed (e.g. "Next"), "Member ID" renamed (e.g. "Member Number")
 *   - subAccountFieldOrder reordered
 *   - a different minimum deposit
 *   - a different version marker, still inside the declared compatibility range
 *
 * The semantic contract must survive all of it; only the adapter hints and the semanticKey mapping
 * are allowed to be tenant-specific.
 */
export {};
