#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { Command, CommanderError } from 'commander';
import {
  buildPhaseLine,
  buildSummaryLine,
  formatClock,
  parsePhaseName,
  phaseLabel,
  type PhaseNames,
} from './display.js';
import { createTimer, parseDuration, type Phase, type PomodoroConfig } from './timer.js';
import { NoopMonitor, type ScreenMonitor, type ScreenState } from './screen.js';

// Re-export display helpers from the CLI entry so `import { phaseLabel } from
// '../src/cli.js'` keeps working (and future monitors can import from either
// `cli.js` or `display.js`).
export {
  buildPhaseLine,
  buildSummaryLine,
  DEFAULT_PHASE_NAMES,
  formatClock,
  parsePhaseName,
  phaseLabel,
  type PhaseNames,
} from './display.js';

interface PomodoroOptions {
  focus: string;
  short: string;
  long: string;
  cycles: string;
  loop: boolean;
  quiet: boolean;
  confirm: boolean;
  focusName: string;
  shortName: string;
  longName: string;
}

function parseCyclesOption(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || !Number.isFinite(value)) {
    throw new Error(`invalid cycles ${JSON.stringify(raw)}: cycles must be an integer >= 1`);
  }
  return value;
}

/**
 * Render the live one-line countdown via carriage return. Isolated so tests
 * can spy on `process.stdout.write`.
 */
function render(liveLine: string): void {
  process.stdout.write(`\r${liveLine}`);
}

/** Peek the phase a `y` answer would advance to, without mutating the timer. */
function peekNextPhase(phase: Phase, focusCount: number, cycles: number): Phase {
  if (phase === 'focus') {
    return (focusCount + 1) % cycles === 0 ? 'longBreak' : 'shortBreak';
  }
  return 'focus';
}

/**
 * Driver seam for phase-transition confirmation. The driver depends on this
 * `confirm(msg)` signature, not on `readline` directly: today it is wired to
 * {@link createStdinConfirmer}, tomorrow a notification-action confirmer can
 * implement the same interface.
 */
export type ConfirmFn = (message: string) => Promise<boolean>;

/**
 * stdin confirmer: strict `y`/`n` (trimmed, case-insensitive), Enter required
 * via `node:readline` `question()`. Anything else re-prompts with no
 * transition and no restart. Never uses raw mode.
 */
export function createStdinConfirmer(
  getInterface: () => readline.Interface,
  isFinished: () => boolean,
): ConfirmFn {
  return (message: string) =>
    new Promise<boolean>((resolve) => {
      const askOnce = (): void => {
        if (isFinished()) {
          resolve(false);
          return;
        }
        getInterface().question(message, (answer: string) => {
          if (isFinished()) {
            resolve(false);
            return;
          }
          const normalized = answer.trim().toLowerCase();
          if (normalized === 'y') {
            resolve(true);
          } else if (normalized === 'n') {
            resolve(false);
          } else {
            askOnce();
          }
        });
      };
      askOnce();
    });
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
    .option('-q, --quiet', 'Log transitions only, no live countdown.')
    .option('--confirm', 'Awaits y/n on each phase transition (requires interactive stdin).')
    .option('--focus-name <name>', 'Custom label for focus phases.', 'Focus')
    .option('--short-name <name>', 'Custom label for short breaks.', 'Short break')
    .option('--long-name <name>', 'Custom label for long breaks.', 'Long break');

  program.action(async (): Promise<void> => {
    const raw = program.opts<PomodoroOptions>();

    let config: PomodoroConfig;
    let names: PhaseNames;
    try {
      const focusMs = parseDuration(raw.focus);
      const shortBreakMs = parseDuration(raw.short);
      const longBreakMs = parseDuration(raw.long);
      const cycles = parseCyclesOption(raw.cycles);
      config = { focusMs, shortBreakMs, longBreakMs, cycles };
      names = {
        focus: parsePhaseName(raw.focusName, '--focus-name'),
        shortBreak: parsePhaseName(raw.shortName, '--short-name'),
        longBreak: parsePhaseName(raw.longName, '--long-name'),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      program.error(`error: ${message}`, { exitCode: 1 });
      throw err;
    }

    if (raw.confirm && !process.stdin.isTTY) {
      program.error('--confirm requires an interactive terminal', { exitCode: 1 });
      return;
    }

    const quiet = raw.quiet || !process.stdout.isTTY;
    await startDriver(program, config, {
      loop: raw.loop,
      live: !quiet,
      names,
      confirm: raw.confirm,
    });
  });

  return program;
}

interface DriverFlags {
  loop: boolean;
  live: boolean;
  names: PhaseNames;
  confirm: boolean;
}

function startDriver(program: Command, config: PomodoroConfig, flags: DriverFlags): Promise<void> {
  void program;
  const timer = createTimer(config);
  timer.start(Date.now());
  const names = flags.names;

  const monitor: ScreenMonitor = new NoopMonitor();

  let interval: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let confirmPending = false;
  let rl: readline.Interface | undefined;

  let resolveDriver: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDriver = resolve;
  });

  function getReadline(): readline.Interface {
    rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
    return rl;
  }

  function closeReadline(): void {
    if (rl !== undefined) {
      try {
        rl.close();
      } catch {
        // Ignore close errors during shutdown.
      }
      rl = undefined;
    }
  }

  function clearTimers(): void {
    // Call through unconditionally so SIGINT-while-pending still records a
    // clear (timeout already fired, interval already suspended) — the spies
    // in tests assert cleanup happened.
    clearInterval(interval);
    interval = undefined;
    clearTimeout(timeout);
    timeout = undefined;
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimers();
    closeReadline();
    process.removeListener('SIGINT', onSigint);
    unsubscribe();
    resolveDriver();
  }

  function onSigint(): void {
    process.stdout.write(`\n${buildSummaryLine(timer.focusCount, names)}\n`);
    finish();
  }

  const confirmFn = createStdinConfirmer(getReadline, () => finished);

  function resumeTimers(): void {
    if (finished || timer.paused) return;
    if (flags.live) {
      interval ??= setInterval(onLiveTick, 250);
    } else {
      armQuietTimeout();
    }
  }

  /**
   * Confirm flow for one expired deadline. Suspends timers before prompting;
   * `y` advances exactly one phase via `tick`, `n` restarts the current phase
   * with a full deadline. Re-prompts in the same phase are bell-free; a newly
   * expired phase after `y` prompts again instead of cascading.
   */
  async function runConfirmFlow(): Promise<void> {
    while (!finished) {
      if (!flags.loop && timer.phase === 'longBreak' && timer.remainingMs(Date.now()) <= 0) {
        process.stdout.write(`${buildSummaryLine(timer.focusCount, names)}\n`);
        finish();
        return;
      }
      const current = timer.phase;
      const next = peekNextPhase(current, timer.focusCount, config.cycles);
      const promptMsg = `${phaseLabel(current, names)} complete. Start ${phaseLabel(next, names)}? [y/n] `;
      const promptAt = Date.now();
      process.stdout.write('\x07');
      const confirmed = await confirmFn(promptMsg);
      if (finished) return;
      const answerAt = Date.now();
      // Freeze gating time: answering delay must not eat into the next phase.
      // tick() anchors the next deadline to the previous deadline (preserving
      // pre-prompt overshoot so a far-overshot phase re-prompts), then shift
      // forward by the gating delay.
      const gatingMs = Math.max(0, answerAt - promptAt);
      if (confirmed) {
        timer.tick(promptAt);
        timer.shiftEndsAtMs(gatingMs);
        const line = buildPhaseLine(timer, config, names, answerAt);
        if (flags.live) {
          process.stdout.write(`\n${line}\n`);
        } else {
          process.stdout.write(`${line}\n`);
        }
        if (timer.remainingMs(Date.now()) <= 0) {
          continue;
        }
        confirmPending = false;
        resumeTimers();
        return;
      }
      timer.restartCurrentPhase(answerAt);
      const restarted = Date.now();
      const line = buildPhaseLine(timer, config, names, restarted);
      if (flags.live) {
        process.stdout.write(`\n${line}\n`);
      } else {
        process.stdout.write(`${line}\n`);
      }
      confirmPending = false;
      resumeTimers();
      return;
    }
  }

  function onLiveTick(): void {
    if (finished || confirmPending) return;
    const now = Date.now();
    if (timer.paused) {
      render(`${buildPhaseLine(timer, config, names, now)} (paused — screen locked)`);
      return;
    }
    if (timer.remainingMs(now) > 0) {
      render(buildPhaseLine(timer, config, names, now));
      return;
    }
    if (!flags.confirm) {
      const before = timer.phase;
      timer.tick(now);
      process.stdout.write(`\x07\n${buildPhaseLine(timer, config, names, now)}\n`);
      if (!flags.loop && before === 'longBreak' && timer.phase === 'focus') {
        process.stdout.write(`${buildSummaryLine(timer.focusCount, names)}\n`);
        finish();
        return;
      }
      return;
    }
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
    confirmPending = true;
    void runConfirmFlow();
  }

  function armQuietTimeout(): void {
    if (finished || timer.paused || confirmPending) return;
    const delay = Math.max(0, timer.remainingMs(Date.now()));
    timeout = setTimeout(() => {
      timeout = undefined;
      if (finished || confirmPending) return;
      if (timer.paused) return;
      const now = Date.now();
      if (timer.remainingMs(now) > 0) {
        armQuietTimeout();
        return;
      }
      if (!flags.confirm) {
        const before = timer.phase;
        timer.tick(now);
        if (timer.phase === before) {
          armQuietTimeout();
          return;
        }
        process.stdout.write(`\x07\n${buildPhaseLine(timer, config, names, now)}\n`);
        if (!flags.loop && before === 'longBreak' && timer.phase === 'focus') {
          process.stdout.write(`${buildSummaryLine(timer.focusCount, names)}\n`);
          finish();
          return;
        }
        armQuietTimeout();
        return;
      }
      confirmPending = true;
      void runConfirmFlow();
    }, delay);
  }

  const unsubscribe = monitor.subscribe((state: ScreenState) => {
    // Countdown already frozen while awaiting an answer: lock/unlock is a no-op.
    if (finished || confirmPending) return;
    const now = Date.now();
    if (state !== 'active') {
      if (timer.paused) return;
      timer.pause('screen', now);
      if (flags.live) {
        render(`${buildPhaseLine(timer, config, names, now)} (paused — screen locked)`);
      } else {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        process.stdout.write(
          `Paused ${phaseLabel(timer.phase, names)} — screen locked, timer frozen\n`,
        );
      }
    } else {
      if (!timer.paused) return;
      timer.resume('screen', now);
      if (flags.live) {
        render(buildPhaseLine(timer, config, names, now));
      } else {
        process.stdout.write(
          `Resumed ${phaseLabel(timer.phase, names)} — ${formatClock(timer.remainingMs(now))} remaining\n`,
        );
        armQuietTimeout();
      }
    }
  });

  process.on('SIGINT', onSigint);

  if (flags.live) {
    render(buildPhaseLine(timer, config, names, Date.now()));
    interval = setInterval(onLiveTick, 250);
  } else {
    process.stdout.write(`${buildPhaseLine(timer, config, names, Date.now())}\n`);
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
