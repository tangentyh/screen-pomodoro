#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { Command, CommanderError } from 'commander';

const program = new Command()
  .name('screen-pomodoro')
  .description('A pomodoro timer that pauses when your screen locks.')
  .version(pkg.version, '-V, --version', 'Print the version number.')
  .action(() => {
    console.log(
      `screen-pomodoro v${pkg.version} — a pomodoro timer that pauses when your screen locks.`,
    );
    console.log('Run "screen-pomodoro --help" for usage.');
  });

/**
 * Run the CLI with user-style arguments (no `node` / script path entries).
 * Returns the process exit code instead of exiting, for easy testing.
 */
export async function run(argv: readonly string[]): Promise<number> {
  // Throw CommanderError instead of process.exit() so run() can return exit codes.
  program.exitOverride();

  try {
    await program.parseAsync(argv, { from: 'user' });
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
