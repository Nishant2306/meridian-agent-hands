import pino from 'pino';
import { createLegacyApp } from './server.js';
import { tenantA } from './tenants/tenant-a.js';

/**
 * Entry point for `npm run dev:app-a`.
 *
 * The port comes from the TENANT CONFIG, not from an environment variable and not from a constant
 * in this file. PHASE 11 adds a second tenant on a second port, and a deployment's address belongs
 * to that deployment's configuration.
 *
 * Environment:
 *   FIXTURE_SEED  fixes the per-boot obfuscation seed, so a boot can be reproduced exactly.
 *   LOG_LEVEL     pino level (default info).
 */

const seedFromEnv = process.env['FIXTURE_SEED'];
const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

const { app, tenant, seed } = createLegacyApp(
  seedFromEnv === undefined ? { tenant: tenantA } : { tenant: tenantA, seed: Number(seedFromEnv) },
);

app.listen(tenant.port, () => {
  logger.info(
    {
      tenant: tenant.id,
      product: tenant.productName,
      version: tenant.versionMarker,
      seed,
      port: tenant.port,
    },
    // The seed is logged on every boot. Restart the app and this number changes, and with it every
    // CSS class name and element id in the application, while every role, accessible name and
    // legacy `name=` attribute stays exactly where it was.
    `${tenant.productName} listening on http://localhost:${tenant.port} (obfuscation seed ${seed})`,
  );
});
