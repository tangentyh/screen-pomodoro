#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import type { ScreenMonitor } from './screen.js';
import { createProgram } from './program.js';

// Re-export display helpers from the CLI entry so `import { phaseLabel } from
// '../src/cli.js'` keeps working (and future monitors can import from either
// `cli.js` or `display.js`).
export {
  buildPausedLine,
  buildPhaseLine,
  buildResumedLine,
  buildSummaryLine,
  DEFAULT_PHASE_NAMES,
  formatClock,
  formatTimestamp,
  parsePhaseName,
  phaseLabel,
  withTimestamp,
  type PhaseNames,
} from './display.js';

// Back-compat re-exports so existing `../src/cli.js` imports keep working
// after the split (program/driver/confirmer now live in their own modules).
export { JUMP_THRESHOLD_MS, startDriver, type DriverFlags } from './driver.js';
export { createStdinConfirmer, type ConfirmFn } from './confirm-stdin.js';

export interface RunOptions {
  monitor?: ScreenMonitor;
}

/**
 * Run the CLI with user-style arguments (no `node` / script path entries).
 * Returns the process exit code instead of exiting, for easy testing.
 */
export async function run(argv: readonly string[], opts?: RunOptions): Promise<number> {
  const program = createProgram(opts?.monitor);
  // Throw CommanderError instead of process.exit() so run() can return exit codes.
  program.exitOverride();

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (err) {
    // With exitOverride(), commander has already printed usage errors / help.
    if (err instanceof CommanderError) return err.exitCode;
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2));
}

// Detect direct execution robustly: when invoked through a bin symlink (npm/npx),
// process.argv[1] keeps the symlink path while import.meta.url is already realpathed.
const isDirectInvocation = (() => {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  await main();
}
