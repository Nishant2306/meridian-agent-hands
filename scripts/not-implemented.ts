/**
 * Placeholder target for npm scripts whose CLI entry point has not been built yet.
 *
 * PHASE 1 mandates that the scripts exist; BUILD ORDER IS VERTICAL (Hard Rule 7) means the
 * commands behind them do not. Each script is repointed at its real `src/cli/*.ts` entry point
 * by the phase that implements it. This file exists so `npm run <script>` fails loudly and
 * honestly instead of failing with a confusing module-not-found error.
 */

const [command, phase] = process.argv.slice(2);

process.stderr.write(
  `\n  "${command ?? 'unknown'}" is not implemented yet.\n` +
    `  It is built in PHASE ${phase ?? '?'}. See CLAUDE.md section 9 for the phase checklist.\n\n`,
);

process.exit(2);
