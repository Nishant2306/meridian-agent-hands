import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // ==========================================================================================
    // WHY FILES RUN SERIALLY, MEASURED RATHER THAN ASSUMED.
    // ==========================================================================================
    //
    // The original comment here said the fixture binds a real HTTP port and that ports would
    // collide across workers. That was never true: every fixture boot in tests and scripts uses
    // `app.listen(0)` - an ephemeral port - and has since the first commit. The obfuscation seed
    // is per `createLegacyApp` call, not module state.
    //
    // The real reason to keep it, as of PHASE 6: parallelism buys about 17% (119s serial ->
    // 98s parallel on this machine) and not the 3-4x it looks like it should, because the suite is
    // CPU-bound on real Chromium and accessibility-tree walks rather than waiting on IO. Under
    // contention, timing-sensitive tests get closer to their edges - the browser-death test found a
    // genuine gap in surface-death detection that way, which was worth having, but it is a poor
    // trade to run every future phase against that noise for 20 seconds.
    //
    // Flip it to `true` if the suite outgrows the wait. It passes.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
