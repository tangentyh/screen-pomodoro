#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { Command, CommanderError } from 'commander';
import { createTimer, parseDuration, type PomodoroConfig } from './timer.js';
import { NoopMonitor, type ScreenMonitor, type ScreenState } from './screen.js';

interface PomodoroOptions {
  focus: string;
  short: string;
  long: string;
  cycles: string;
  loop: boolean;
  quiet: boolean;
}

function parseCyclesOption(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || !Number.isFinite(value)) {
    throw new Error(`invalid cycles ${JSON.stringify(raw)}: cycles must be an integer >= 1`);
  }
  return value;
}

function phaseLabel(phase: 'focus' | 'shortBreak' | 'longBreak'): string {
  switch (phase) {
    case 'focus':
      return 'Focus';
    case 'shortBreak':
      return 'Short break';
    case 'longBreak':
      return 'Long break';
  }
}

function formatClock(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${String(minutes)}:${seconds}`;
}

/**
 * Render the live one-line countdown via carriage return. Isolated so tests
 * can spy on `process.stdout.write`.
 */
function render(liveLine: string): void {
  process.stdout.write(`\r${liveLine}`);
}

function buildPhaseLine(
  timer: ReturnType<typeof createTimer>,
  config: PomodoroConfig,
  nowMs: number,
): string {
  const clock = formatClock(timer.remainingMs(nowMs));
  if (timer.phase === 'focus') {
    const current = Math.min(timer.focusCount + 1, config.cycles);
    return `${phaseLabel(timer.phase)} ${String(current)}/${String(config.cycles)} — ${clock} remaining`;
  }
  return `${phaseLabel(timer.phase)} — ${clock} remaining`;
}

function createProgram(): Command {
  const program = new Command()
    .name('screen-pomodoro')
    .description('A pomodoro timer that pauses when your screen locks.')
    .version(pkg.version, '-V, --version', 'Print the version number.')
    .option('--focus <duration>', 'Focus duration (minutes or with s/m/h suffix).', '25')
    .option('--short <duration>', 'Short break duration (minutes or with s/m/h suffix).', '5')
    .option('--long <duration>', 'Long break duration (minutes or with s/m/h suffix).', '15')
    .option('--cycles <n>', 'Focuses per long break (integer >= 1).', '4')
    .option('--no-loop', 'Stop after the first long break instead of looping forever.')
    .option('-q, --quiet', 'Log transitions only, no live countdown.');

  program.action(async (): Promise<void> => {
    const raw = program.opts<PomodoroOptions>();

    let config: PomodoroConfig;
    try {
      const focusMs = parseDuration(raw.focus);
      const shortBreakMs = parseDuration(raw.short);
      const longBreakMs = parseDuration(raw.long);
      const cycles = parseCyclesOption(raw.cycles);
      config = { focusMs, shortBreakMs, longBreakMs, cycles };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      program.error(`error: ${message}`, { exitCode: 1 });
      throw err;
    }

    const quiet = raw.quiet || !process.stdout.isTTY;
    await startDriver(program, config, { loop: raw.loop, live: !quiet });
  });

  return program;
}

interface DriverFlags {
  loop: boolean;
  live: boolean;
}

function startDriver(program: Command, config: PomodoroConfig, flags: DriverFlags): Promise<void> {
  void program;
  const timer = createTimer(config);
  timer.start(Date.now());

  const monitor: ScreenMonitor = new NoopMonitor();

  let interval: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  let resolveDriver: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDriver = resolve;
  });

  function clearTimers(): void {
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimers();
    process.removeListener('SIGINT', onSigint);
    unsubscribe();
    resolveDriver();
  }

  function onSigint(): void {
    process.stdout.write(`\nCompleted ${String(timer.focusCount)} focuses\n`);
    finish();
  }

  function armQuietTimeout(): void {
    if (finished || timer.paused) return;
    const delay = Math.max(0, timer.remainingMs(Date.now()));
    timeout = setTimeout(() => {
      timeout = undefined;
      const now = Date.now();
      const before = timer.phase;
      timer.tick(now);
      if (timer.phase === before) {
        armQuietTimeout();
        return;
      }
      process.stdout.write(`\x07\n${buildPhaseLine(timer, config, now)}\n`);
      if (!flags.loop && before === 'longBreak' && timer.phase === 'focus') {
        process.stdout.write(`Completed ${String(timer.focusCount)} focuses\n`);
        finish();
        return;
      }
      armQuietTimeout();
    }, delay);
  }

  const unsubscribe = monitor.subscribe((state: ScreenState) => {
    const now = Date.now();
    if (state !== 'active') {
      if (timer.paused) return;
      timer.pause('screen', now);
      if (flags.live) {
        render(`${buildPhaseLine(timer, config, now)} (paused — screen locked)`);
      } else {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        process.stdout.write('Paused — screen locked, timer frozen\n');
      }
    } else {
      if (!timer.paused) return;
      timer.resume('screen', now);
      if (flags.live) {
        render(buildPhaseLine(timer, config, now));
      } else {
        process.stdout.write(`Resumed — ${formatClock(timer.remainingMs(now))} remaining\n`);
        armQuietTimeout();
      }
    }
  });

  process.on('SIGINT', onSigint);

  if (flags.live) {
    render(buildPhaseLine(timer, config, Date.now()));
    interval = setInterval(() => {
      const now = Date.now();
      const before = timer.phase;
      timer.tick(now);
      if (timer.phase !== before) {
        process.stdout.write(`\x07\n${buildPhaseLine(timer, config, now)}\n`);
        if (!flags.loop && before === 'longBreak' && timer.phase === 'focus') {
          process.stdout.write(`Completed ${String(timer.focusCount)} focuses\n`);
          finish();
          return;
        }
      } else {
        if (timer.paused) {
          render(`${buildPhaseLine(timer, config, now)} (paused — screen locked)`);
        } else {
          render(buildPhaseLine(timer, config, now));
        }
      }
    }, 250);
  } else {
    process.stdout.write(`${buildPhaseLine(timer, config, Date.now())}\n`);
    armQuietTimeout();
  }

  return done;
}

/**
 * Run the CLI with user-style arguments (no `node` / script path entries).
 * Returns the process exit code instead of exiting, for easy testing.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const program = createProgram();
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
