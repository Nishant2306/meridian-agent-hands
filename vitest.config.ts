import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The fixture smoke tests bind a real HTTP port; keep files serial so ports
    // and the per-boot obfuscation seed do not interleave across workers.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
