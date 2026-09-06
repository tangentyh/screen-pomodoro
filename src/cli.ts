#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
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
import {
  buildNotifyConfirmMessage,
  buildNotifyConfirmTitle,
  buildNotifyMessage,
  buildNotifyTitle,
  checkNotifierAvailable,
  createNotificationConfirmer,
  GROUP_ID,
  isNotifySupported,
  sendNotification,
  type ExecFileFn,
} from './notify.js';
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
  notify: boolean;
  notifyConfirm: boolean;
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
        const iface = getInterface();
        // If the interface closes without answering (Ctrl-D/EOF, or
        // SIGINT cleanup closing readline), resolve instead of leaving the
        // pending question — and the driver's top-level await — unsettled.
        // Guarded for mocked interfaces in tests that only stub
        // question()/close().
        let onClose: (() => void) | undefined;
        const maybeOnce = (iface as unknown as { once?: unknown }).once;
        if (typeof maybeOnce === 'function') {
          onClose = (): void => {
            resolve(false);
          };
          try {
            (iface as unknown as { once(event: string, cb: () => void): void }).once(
              'close',
              onClose,
            );
          } catch {
            onClose = undefined;
          }
        }
        const removeCloseListener = (): void => {
          if (onClose === undefined) return;
          try {
            const maybeOff = (iface as unknown as { off?: unknown }).off;
            if (typeof maybeOff === 'function') {
              (iface as unknown as { off(event: string, cb: () => void): void }).off(
                'close',
                onClose,
              );
              return;
            }
            const maybeRemove = (iface as unknown as { removeListener?: unknown }).removeListener;
            if (typeof maybeRemove === 'function') {
              (
                iface as unknown as { removeListener(event: string, cb: () => void): void }
              ).removeListener('close', onClose);
            }
          } catch {
            // Ignore listener-cleanup errors; resolve() stays idempotent.
          }
        };
        iface.question(message, (answer: string) => {
          removeCloseListener();
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
    .option(
      '--cycles <n>',
      'Focuses per long break (integer >= 1). Loops forever unless --no-loop is given.',
      '4',
    )
    .option(
      '--no-loop',
      'Stop after the first long break (i.e. after --cycles focuses) instead of looping forever.',
    )
    .option('-q, --quiet', 'Log transitions only, no live countdown.')
    .option('--confirm', 'Awaits y/n on each phase transition (requires interactive stdin).')
    .option(
      '--notify',
      'Send a macOS notification on each phase transition (macOS + terminal-notifier required).',
    )
    .option(
      '--notify-confirm',
      'Answer phase transitions by clicking the notification (click = yes, No = no). Implies the confirm gate; does not require interactive stdin.',
    )
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

    const notify = raw.notify ?? false;
    const notifyConfirm = raw.notifyConfirm ?? false;

    if (notifyConfirm && raw.confirm) {
      program.error('error: --notify-confirm cannot be used with --confirm (one source only)', {
        exitCode: 1,
      });
      return;
    }

    if (notifyConfirm && notify) {
      program.error('error: --notify-confirm cannot be used with --notify (one source only)', {
        exitCode: 1,
      });
      return;
    }

    if (raw.confirm && !process.stdin.isTTY) {
      program.error('--confirm requires an interactive terminal', { exitCode: 1 });
      return;
    }

    if ((notify || notifyConfirm) && !isNotifySupported()) {
      const flag = notifyConfirm ? '--notify-confirm' : '--notify';
      program.error(`error: ${flag} requires macOS (terminal-notifier)`, { exitCode: 1 });
      return;
    }

    if (notify || notifyConfirm) {
      try {
        await checkNotifierAvailable();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        program.error(`error: ${message}`, { exitCode: 1 });
        return;
      }
    }

    const quiet = raw.quiet || !process.stdout.isTTY;
    await startDriver(program, config, {
      loop: raw.loop,
      live: !quiet,
      names,
      confirm: raw.confirm,
      notify,
      notifyConfirm,
    });
  });

  return program;
}

interface DriverFlags {
  loop: boolean;
  live: boolean;
  names: PhaseNames;
  confirm: boolean;
  notify: boolean;
  notifyConfirm: boolean;
}

function startDriver(program: Command, config: PomodoroConfig, flags: DriverFlags): Promise<void> {
  void program;
  const timer = createTimer(config);
  timer.start(Date.now());
  const names = flags.names;
  const useNotify = flags.notify;
  const useNotifyConfirm = flags.notifyConfirm;
  const gating = flags.confirm || useNotifyConfirm;

  const monitor: ScreenMonitor = new NoopMonitor();

  let interval: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let confirmPending = false;
  let rl: readline.Interface | undefined;
  let pendingChild: { kill?: () => void } | undefined;

  const notifyExec: ExecFileFn = (file, args) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let child: unknown;
      try {
        child = execFileCallback(file, [...args], (err, stdout, stderr) => {
          if (pendingChild !== undefined && pendingChild === child) {
            pendingChild = undefined;
          }
          if (err) {
            reject(err instanceof Error ? err : new Error('terminal-notifier exec failed'));
          } else {
            resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error('terminal-notifier exec failed'));
        return;
      }
      if (args.includes('-action')) {
        pendingChild = child as { kill?: () => void };
      }
    });

  function notifyEntered(before: Phase | undefined, entered: Phase): void {
    if (!useNotify || finished) return;
    const title = buildNotifyTitle(entered, config, names, timer.focusCount);
    const message = buildNotifyMessage(before, entered, config, names, timer.focusCount);
    void sendNotification(notifyExec, { title, message });
  }

  function killPendingNotifier(): void {
    const child = pendingChild;
    pendingChild = undefined;
    if (child !== undefined) {
      try {
        const maybeKill = (child as { kill?: unknown }).kill;
        if (typeof maybeKill === 'function') {
          (child as { kill: () => void }).kill();
        }
      } catch {
        // Best-effort: a dead prompt must never block exit.
      }
    }
  }

  function removeToast(): void {
    if (!useNotify && !useNotifyConfirm) return;
    try {
      execFileCallback('terminal-notifier', ['-remove', GROUP_ID], () => undefined);
    } catch {
      // Best-effort cleanup: ignore delivery/removal failures on exit.
    }
  }

  let resolveDriver: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDriver = resolve;
  });

  function getReadline(): readline.Interface {
    if (rl === undefined) {
      const created = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl = created;
      // ^C while prompting arrives as a readline 'SIGINT' event (stdin is in
      // raw mode during question()), not as a process SIGINT — without this
      // the prompt never resolves and the top-level await stays unsettled
      // (Node warns + exits 13). Ctrl-D/EOF closes the interface instead.
      // Route both to the existing SIGINT path (summary + exit 0).
      // Guarded: tests stub createInterface with question()/close() only.
      try {
        const maybeOn = (created as unknown as { on?: unknown }).on;
        if (typeof maybeOn === 'function') {
          const emitter = created as unknown as { on(event: string, cb: () => void): void };
          emitter.on('SIGINT', onSigint);
          emitter.on('close', () => {
            if (!finished) onSigint();
          });
        }
      } catch {
        // Ignore listener-setup errors; process SIGINT path still applies.
      }
    }
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
    killPendingNotifier();
    clearTimers();
    closeReadline();
    process.removeListener('SIGINT', onSigint);
    unsubscribe();
    removeToast();
    resolveDriver();
  }

  function onSigint(): void {
    if (finished) return;
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
        // Terminal long break: ring (phase-change parity) + summary only.
        // No trailing prompt and no next-focus line — the timer exits.
        process.stdout.write(`\x07${buildSummaryLine(timer.focusCount, names)}\n`);
        finish();
        return;
      }
      const current = timer.phase;
      const next = peekNextPhase(current, timer.focusCount, config.cycles);
      const promptAt = Date.now();
      let confirmed: boolean;
      if (useNotifyConfirm) {
        const title = buildNotifyConfirmTitle(current, names);
        const message = buildNotifyConfirmMessage(current, next, config, names, timer.focusCount);
        process.stdout.write('\x07');
        const confirmer = createNotificationConfirmer(notifyExec, {
          title,
          message,
          isFinished: () => finished,
        });
        confirmed = await confirmer(message);
      } else {
        const promptMsg = `${phaseLabel(current, names)} complete. Start ${phaseLabel(next, names)}? [y/n] `;
        process.stdout.write('\x07');
        confirmed = await confirmFn(promptMsg);
      }
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
        notifyEntered(current, timer.phase);
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
    if (!gating) {
      const before = timer.phase;
      timer.tick(now);
      if (!flags.loop && before === 'longBreak' && timer.phase === 'focus') {
        // Terminal long break: ring + summary only. Do not start (or notify)
        // the next focus — the timer exits instead of looping.
        process.stdout.write(`\x07\n${buildSummaryLine(timer.focusCount, names)}\n`);
        finish();
        return;
      }
      process.stdout.write(`\x07\n${buildPhaseLine(timer, config, names, now)}\n`);
      notifyEntered(before, timer.phase);
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
      if (!gating) {
        const before = timer.phase;
        timer.tick(now);
        if (timer.phase === before) {
          armQuietTimeout();
          return;
        }
        if (!flags.loop && before === 'longBreak' && timer.phase === 'focus') {
          // Terminal long break: ring + summary only (no next-focus line).
          process.stdout.write(`\x07\n${buildSummaryLine(timer.focusCount, names)}\n`);
          finish();
          return;
        }
        process.stdout.write(`\x07\n${buildPhaseLine(timer, config, names, now)}\n`);
        notifyEntered(before, timer.phase);
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
    notifyEntered(undefined, timer.phase);
    interval = setInterval(onLiveTick, 250);
  } else {
    process.stdout.write(`${buildPhaseLine(timer, config, names, Date.now())}\n`);
    notifyEntered(undefined, timer.phase);
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
