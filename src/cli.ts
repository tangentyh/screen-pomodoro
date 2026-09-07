#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { realpathSync } from 'node:fs';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { Command, CommanderError } from 'commander';
import {
  buildPausedLine,
  buildPhaseLine,
  buildResumedLine,
  buildSummaryLine,
  parsePhaseName,
  phaseLabel,
  withTimestamp,
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
import { createScreenMonitor, type ScreenMonitor, type ScreenState } from './screen.js';

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

/** Wake-jump guard threshold per 005 D6: drift beyond this probes before ticking. */
export const JUMP_THRESHOLD_MS = 5000;

export interface RunOptions {
  monitor?: ScreenMonitor;
}

interface PomodoroOptions {
  focus: string;
  short: string;
  long: string;
  cycles: string;
  loop: boolean;
  quiet: boolean;
  timestamp: boolean;
  confirm: boolean;
  notify: boolean;
  notifyConfirm: boolean;
  screenPause: boolean;
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
 * can spy on `process.stdout.write`. The trailing EL (`\x1b[K`) clears to
 * end of line: rows are redrawn in place and shrink (`formatClock` narrows
 * at 10:00→9:59), so without it the tail of the previous longer row stays
 * visible (QA 2026-09-07).
 *
 * NOTE the EL order differs from `commitLiveLine` on purpose: render
 * overwrites the row head with new text and clears the leftover tail,
 * while commit clears the whole stale row *before* writing history.
 */
function render(liveLine: string): void {
  process.stdout.write(`\r${liveLine}\x1b[K`);
}

/**
 * Commit a history row over the live countdown row (tidy 006). Every live
 * `\n` history write used to scroll the in-progress `\r` frame into
 * scrollback as a stale-tick fossil (one duplicate row per event in a
 * Ghostty paste). `\r` + EL erases the frame first, so each event leaves
 * exactly one row. Live-only — quiet never owns a `\r` row, so its writes
 * stay plain. Harmless on an already-clean line (pause/resume adjacency).
 */
function commitLiveLine(text: string): void {
  process.stdout.write(`\r\x1b[K${text}\n`);
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

function createProgram(monitorOverride?: ScreenMonitor): Command {
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
    .option('--timestamp', 'Prefix history lines with the current time ([HH:MM:SS]).')
    .option('--confirm', 'Awaits y/n on each phase transition (requires interactive stdin).')
    .option(
      '--notify',
      'Send a macOS notification on each phase transition (macOS + terminal-notifier required).',
    )
    .option(
      '--notify-confirm',
      'Answer phase transitions by clicking the notification (click = yes, No = no). Implies the confirm gate; does not require interactive stdin.',
    )
    .option('--no-screen-pause', 'Do not pause when the screen locks.')
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
    await startDriver(
      program,
      config,
      {
        loop: raw.loop,
        live: !quiet,
        names,
        timestamp: raw.timestamp ?? false,
        confirm: raw.confirm,
        notify,
        notifyConfirm,
        screenPause: raw.screenPause ?? true,
      },
      monitorOverride,
    );
  });

  return program;
}

interface DriverFlags {
  loop: boolean;
  live: boolean;
  names: PhaseNames;
  timestamp: boolean;
  confirm: boolean;
  notify: boolean;
  notifyConfirm: boolean;
  screenPause: boolean;
}

export function startDriver(
  program: Command,
  config: PomodoroConfig,
  flags: DriverFlags,
  monitorOverride?: ScreenMonitor,
): Promise<void> {
  void program;
  const timer = createTimer(config);
  timer.start(Date.now());
  const names = flags.names;
  const useNotify = flags.notify;
  const useNotifyConfirm = flags.notifyConfirm;
  const gating = flags.confirm || useNotifyConfirm;

  /**
   * Prefix a history line with `[HH:MM:SS]` when `--timestamp` is set.
   * History only: the ephemeral live `\r` countdown is never stamped —
   * wall-clock seconds and remaining seconds flip on different boundaries,
   * so stamping it shows two clocks ticking out of phase.
   */
  const stamp = (line: string, nowMs: number): string =>
    flags.timestamp ? withTimestamp(line, nowMs) : line;

  const monitor: ScreenMonitor =
    monitorOverride ?? createScreenMonitor({ enabled: flags.screenPause ?? true });

  let interval: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let confirmPending = false;
  let rl: readline.Interface | undefined;
  let pendingChild: { kill?: () => void } | undefined;
  // Wake-jump guard (005 D6): wall-clock of the last live tick. Quiet drift
  // is measured per-timeout via its scheduled-at stamp (see armQuietTimeout).
  let lastLiveWallMs = Date.now();

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
    const now = Date.now();
    if (flags.live && !confirmPending) {
      // No live `\r` row while a confirm prompt owns the line — committing
      // there would erase the user's answer from the transcript.
      commitLiveLine(stamp(buildSummaryLine(timer.focusCount, names), now));
    } else if (confirmPending) {
      // Prompt owns the line; break to a fresh one first.
      process.stdout.write(`\n${stamp(buildSummaryLine(timer.focusCount, names), now)}\n`);
    } else {
      // Quiet: cursor is always clean (no `\r` rows), so no leading break.
      process.stdout.write(`${stamp(buildSummaryLine(timer.focusCount, names), now)}\n`);
    }
    finish();
  }

  const confirmFn = createStdinConfirmer(getReadline, () => finished);

  function resumeTimers(): void {
    if (finished || timer.paused) return;
    if (flags.live) {
      interval ??= setInterval(() => {
        void onLiveTick();
      }, 250);
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
        // Live commits (timers are suspended, but the last `\r` tick row is
        // still on screen); quiet appends (cursor always clean there).
        const terminalAt = Date.now();
        if (flags.live) {
          process.stdout.write(
            `\x07\r\x1b[K${stamp(buildSummaryLine(timer.focusCount, names), terminalAt)}\n`,
          );
        } else {
          process.stdout.write(
            `\x07${stamp(buildSummaryLine(timer.focusCount, names), terminalAt)}\n`,
          );
        }
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
        confirmed = await confirmFn(stamp(promptMsg, promptAt));
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
        const line = stamp(buildPhaseLine(timer, config, names, answerAt), answerAt);
        if (flags.live) {
          commitLiveLine(line);
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
      const restartedLine = stamp(buildPhaseLine(timer, config, names, restarted), restarted);
      if (flags.live) {
        commitLiveLine(restartedLine);
      } else {
        process.stdout.write(`${restartedLine}\n`);
      }
      confirmPending = false;
      resumeTimers();
      return;
    }
  }

  function onScreenState(state: ScreenState): void {
    // --no-screen-pause opts out entirely: ignore lock/unlock even if a
    // monitor (or test stub) reports locked. Default selects NoopMonitor
    // (no polling), this guard covers injected stubs in tests.
    if (!flags.screenPause) return;
    // Countdown already frozen while awaiting an answer: lock/unlock is a no-op.
    if (finished || confirmPending) return;
    const now = Date.now();
    if (state !== 'active') {
      if (timer.paused) return;
      timer.pause('screen', now);
      if (flags.live) {
        // Tidy 006: history replaces the suffix; suspend ticks while paused
        // (idle like quiet — only the 2000ms poll stays armed).
        commitLiveLine(stamp(buildPausedLine(timer, names), now));
        if (interval !== undefined) {
          clearInterval(interval);
          interval = undefined;
        }
      } else {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        process.stdout.write(`${stamp(buildPausedLine(timer, names), now)}\n`);
      }
    } else {
      if (!timer.paused) return;
      timer.resume('screen', now);
      if (flags.live) {
        // Commit framing is a harmless no-op here (pause left the cursor
        // clean) and keeps every live history write uniform.
        commitLiveLine(stamp(buildResumedLine(timer, names, now), now));
        render(buildPhaseLine(timer, config, names, now));
        resumeTimers();
      } else {
        process.stdout.write(`${stamp(buildResumedLine(timer, names, now), now)}\n`);
        armQuietTimeout();
      }
    }
  }

  async function checkWakeJump(isLive: boolean, quietScheduledAtMs: number): Promise<boolean> {
    // 005 D6: lid-close sleep freezes the process; on wake Date.now() jumps
    // and the first tick would cascade expired phases with rapid bells before
    // the next poll notices we're locked. Probe first on large drift and
    // apply a lock-freeze before any tick(). Returns true to skip ticking.
    // Fail open: probe errors resolve active and ticking proceeds.
    const now = Date.now();
    const drift = isLive ? now - lastLiveWallMs : now - quietScheduledAtMs;
    if (isLive) {
      lastLiveWallMs = now;
    }
    // Opt-out never probes: NoopMonitor is active-only, and injected stubs
    // must not freeze an opted-out timer (see --no-screen-pause test).
    if (!flags.screenPause) return false;
    if (drift <= JUMP_THRESHOLD_MS) return false;
    let probed: ScreenState;
    try {
      probed = await monitor.probeNow();
    } catch {
      probed = 'active';
    }
    if (finished || confirmPending) return true;
    onScreenState(probed);
    if (finished || confirmPending) return true;
    // Lock-freeze applied (or already paused): skip ticking this round.
    // Active + running falls through to normal tick logic.
    return timer.paused;
  }

  async function onLiveTick(): Promise<void> {
    if (finished || confirmPending) return;
    if (await checkWakeJump(true, 0)) return;
    const now = Date.now();
    // Tidy 006: no suffix redraws while paused (interval is suspended on
    // lock; this guard covers races where a tick was already queued).
    if (timer.paused) return;
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
        process.stdout.write(
          `\x07\r\x1b[K${stamp(buildSummaryLine(timer.focusCount, names), now)}\n`,
        );
        finish();
        return;
      }
      process.stdout.write(
        `\x07\r\x1b[K${stamp(buildPhaseLine(timer, config, names, now), now)}\n`,
      );
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
    const scheduledAt = Date.now();
    timeout = setTimeout(() => {
      timeout = undefined;
      void onQuietFire(scheduledAt);
    }, delay);
  }

  async function onQuietFire(scheduledAt: number): Promise<void> {
    if (finished || confirmPending) return;
    if (timer.paused) return;
    if (await checkWakeJump(false, scheduledAt)) return;
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
        // Quiet never owns a `\r` row, so no leading break (live commits).
        process.stdout.write(`\x07${stamp(buildSummaryLine(timer.focusCount, names), now)}\n`);
        finish();
        return;
      }
      process.stdout.write(`\x07${stamp(buildPhaseLine(timer, config, names, now), now)}\n`);
      notifyEntered(before, timer.phase);
      armQuietTimeout();
      return;
    }
    confirmPending = true;
    void runConfirmFlow();
  }

  const unsubscribe = monitor.subscribe(onScreenState);

  process.on('SIGINT', onSigint);

  if (flags.live) {
    // History birth line for parity: later phases each log a full-duration
    // line on entry, so the first phase must too — otherwise scrollback
    // shows only its 0:01 death fossil. No bell (startup is not a transition).
    const startedAt = Date.now();
    commitLiveLine(stamp(buildPhaseLine(timer, config, names, startedAt), startedAt));
    render(buildPhaseLine(timer, config, names, startedAt));
    notifyEntered(undefined, timer.phase);
    interval = setInterval(() => {
      void onLiveTick();
    }, 250);
  } else {
    const startedAt = Date.now();
    process.stdout.write(`${stamp(buildPhaseLine(timer, config, names, startedAt), startedAt)}\n`);
    notifyEntered(undefined, timer.phase);
    armQuietTimeout();
  }

  return done;
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
