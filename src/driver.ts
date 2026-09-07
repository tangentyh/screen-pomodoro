import { execFile as execFileCallback } from 'node:child_process';
import * as readline from 'node:readline';
import type { Command } from 'commander';
import {
  buildPausedLine,
  buildPhaseLine,
  buildResumedLine,
  buildSummaryLine,
  phaseLabel,
  withTimestamp,
  type PhaseNames,
} from './display.js';
import {
  buildNotifyConfirmMessage,
  buildNotifyConfirmTitle,
  buildNotifyMessage,
  buildNotifyTitle,
  createNotificationConfirmer,
  GROUP_ID,
  sendNotification,
  type ExecFileFn,
} from './notify.js';
import { createTimer, type Phase, type PomodoroConfig } from './timer.js';
import { createScreenMonitor, type ScreenMonitor, type ScreenState } from './screen.js';
import { createStdinConfirmer } from './confirm-stdin.js';

/** Wake-jump guard threshold per 005 D6: drift beyond this probes before ticking. */
export const JUMP_THRESHOLD_MS = 5000;

export interface DriverFlags {
  loop: boolean;
  live: boolean;
  names: PhaseNames;
  timestamp: boolean;
  confirm: boolean;
  notify: boolean;
  notifyConfirm: boolean;
  screenPause: boolean;
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
  /**
   * Raw screen edge, tracked even while a confirm prompt owns the countdown
   * (where the pause itself is a no-op). Lets an unlock re-send a pending
   * `--notify-confirm` toast that the lock may have taken off screen.
   */
  let screenLocked = false;
  /**
   * Unlock-resend handshake for the notification confirmer: one request per
   * unlock edge, consumed there (or dropped when an answer wins the race).
   */
  let confirmResendRequested = false;
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
    // Never fire a toast while the countdown is frozen on a locked screen:
    // the tick paths bail out while paused, but a transition can still win
    // the race just before the lock is noticed (or startup can land while
    // locked). A skipped toast is replaced in place by the next entry's
    // toast (shared -group), so nothing stacks and nothing shows on the
    // lock screen. The Paused history line remains the source of truth.
    if (!useNotify || finished || timer.paused) return;
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

  /**
   * Unlock-resend: kill the waiting `--notify-confirm` child so the
   * confirmer re-sends the same toast (same `-group`, replaces in place).
   * Banner toasts auto-dismiss and the lock-time `-remove` shares the
   * group, so without this the timer could wait forever behind an
   * invisible prompt. No-ops unless a notification prompt is actually
   * pending; a click that already landed keeps its answer (the kill finds
   * no child, the stale request is dropped on success).
   */
  function requestConfirmResend(): void {
    if (!useNotifyConfirm || finished || !confirmPending) return;
    if (pendingChild === undefined) return;
    confirmResendRequested = true;
    killPendingNotifier();
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
          consumeResendRequest: () => {
            const requested = confirmResendRequested;
            confirmResendRequested = false;
            return requested;
          },
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
    // Raw edge first: tracked even while a confirm prompt owns the
    // countdown, where everything below is a no-op. An unlock with a
    // `--notify-confirm` toast pending re-sends it — the lock may have
    // taken it off screen (Banner auto-dismiss, and the lock-time `-remove`
    // shares the group), and the timer must not wait behind an invisible
    // prompt. No-op for stdin `--confirm` (nothing to re-show) and whenever
    // no prompt is pending.
    if (state !== 'active') {
      screenLocked = true;
    } else {
      const wasLocked = screenLocked;
      screenLocked = false;
      if (wasLocked) requestConfirmResend();
    }
    // Countdown already frozen while awaiting an answer: lock/unlock is a no-op.
    if (finished || confirmPending) return;
    const now = Date.now();
    if (state !== 'active') {
      if (timer.paused) return;
      timer.pause('screen', now);
      // Dismiss any toast that fired in the poll gap just before the lock
      // was noticed: firing during a lock is the bug, lingering on the
      // lock screen after is worse. Best-effort; ignored on failure.
      // No-op without --notify/--notify-confirm (guarded inside).
      removeToast();
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
    // Start-while-locked: freeze immediately instead of running until the
    // first poll notices (≤ POLL_MS). Paused line follows the birth line;
    // the startup toast is skipped via the paused guard in notifyEntered,
    // so nothing fires on the lock screen. No-op when active/opted out.
    onScreenState(monitor.getInitialState());
    notifyEntered(undefined, timer.phase);
    if (!timer.paused) {
      interval = setInterval(() => {
        void onLiveTick();
      }, 250);
    }
  } else {
    const startedAt = Date.now();
    process.stdout.write(`${stamp(buildPhaseLine(timer, config, names, startedAt), startedAt)}\n`);
    // Same start-while-locked freeze as the live path (armQuietTimeout
    // already stays idle while paused).
    onScreenState(monitor.getInitialState());
    notifyEntered(undefined, timer.phase);
    armQuietTimeout();
  }

  return done;
}
