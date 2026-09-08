/**
 * 004 — macOS desktop notifications via `terminal-notifier` (Homebrew only).
 *
 * Platform-agnostic and fully injectable: the `terminal-notifier` binary is
 * reached through an `ExecFileFn` seam (default: promisified
 * `node:child_process.execFile`, argv array only — never a shell string), so
 * unit tests inject fakes and never spawn the real binary.
 *
 * Deliberately imports no `timer.ts` core (driver-only change per 004 D1;
 * enforced by test/notify.test.ts): phase durations arrive as a structural
 * `{ focusMs, shortBreakMs, longBreakMs, cycles }` config compatible with
 * `PomodoroConfig`, and labels reuse `display.ts` helpers (never hardcoded).
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { formatClock, phaseLabel, type PhaseNames } from './display.js';

export const GROUP_ID = 'screen-pomodoro';
export const SOUND = 'Bottle';
export const NO_LABEL = 'No';

const NOTIFIER_BIN = 'terminal-notifier';
const BREW_HINT = 'terminal-notifier not found: brew install terminal-notifier';
const PERMISSION_HINT =
  'terminal-notifier permission denied: allow notifications in System Settings > Notifications or run `tccutil reset UserNotification fr.julienxx.oss.terminal-notifier`';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (file: string, args: readonly string[]) => Promise<ExecResult>;

export interface NotifyPayload {
  title: string;
  message: string;
  /** terminal-notifier `-group`: defaults to GROUP_ID (shared) when omitted. */
  group?: string | undefined;
}

export interface NotifyConfirmerOptions extends NotifyPayload {
  isFinished?: (() => boolean) | undefined;
  /**
   * Unlock-resend handshake (driver-owned). The driver sets the request
   * when the screen unlocks with this prompt pending and kills the waiting
   * `terminal-notifier` child, which surfaces here as a spawn error.
   * Return-and-clear semantics: `true` consumes one request (re-send the
   * same toast instead of failing the prompt). Also consulted after a
   * successful answer so an unlock that raced the click cannot leak a
   * stale request into a later prompt.
   */
  consumeResendRequest?: (() => boolean) | undefined;
}

// Structural mirrors of the timer core's `Phase` / `PomodoroConfig` — kept
// local (not imported) so this module stays `timer.ts`-free per 004 D1.
// `PomodoroConfig` values remain assignable here.
type NotifyPhase = 'focus' | 'shortBreak' | 'longBreak';

interface NotifyConfig {
  focusMs: number;
  shortBreakMs: number;
  longBreakMs: number;
  cycles: number;
}

const execFileAsync = promisify(execFileCallback);

const defaultExec: ExecFileFn = async (file, args) => {
  const result = await execFileAsync(file, [...args]);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export function isNotifySupported(platform: string = process.platform): boolean {
  return platform === 'darwin';
}

/**
 * Prefix-escape a leading `[` (and `(`, `{`, quotes per `-help`) with `\`,
 * mirroring the `terminal-notifier` contract — phase names allow them today.
 */
export function escapeNotifierMessage(s: string): string {
  if (s.length === 0) return s;
  const first = s[0];
  if (first === '[' || first === '(' || first === '{' || first === '"' || first === "'") {
    return `\\${s}`;
  }
  return s;
}

/** Nominal config lookup (same allowance as 003's helpers — no math change). */
function notifyDurationMs(config: NotifyConfig, phase: NotifyPhase): number {
  switch (phase) {
    case 'focus':
      return config.focusMs;
    case 'shortBreak':
      return config.shortBreakMs;
    case 'longBreak':
      return config.longBreakMs;
  }
}

function focusCounter(config: NotifyConfig, focusCount: number): string {
  // Same per-set position as display.ts: wraps 1/M..M/M across sets.
  const current = (focusCount % config.cycles) + 1;
  return `${String(current)}/${String(config.cycles)}`;
}

function focusSuffixedLabel(
  phase: NotifyPhase,
  config: NotifyConfig,
  names: PhaseNames,
  focusCount: number,
): string {
  const label = phaseLabel(phase, names);
  return phase === 'focus' ? `${label} ${focusCounter(config, focusCount)}` : label;
}

/**
 * Validate a custom `--notify-group` id. Shared rule so overlapping timers
 * can isolate their toasts: trimmed, non-empty, at most 64 chars, no
 * control characters (same control set as phase names).
 */
export function parseNotifyGroup(raw: string, flag = '--notify-group'): string {
  if (raw.includes('\r') || raw.includes('\n') || raw.includes('\t') || raw.includes('\u0007')) {
    throw new Error(
      `invalid ${flag} ${JSON.stringify(raw)}: group must not contain control characters (\\r \\n \\t \\x07)`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`invalid ${flag} ${JSON.stringify(raw)}: group must not be empty`);
  }
  if ([...trimmed].length > 64) {
    throw new Error(`invalid ${flag} ${JSON.stringify(raw)}: group must be at most 64 characters`);
  }
  return trimmed;
}

/** Shared `-group`/`-sound`/`-title`/`-message` argv (blocking adds `-action`). */
function baseArgv(title: string, message: string, group: string = GROUP_ID): string[] {
  return [
    '-group',
    group,
    '-sound',
    SOUND,
    '-title',
    title,
    '-message',
    escapeNotifierMessage(message),
  ];
}

export function buildNotifyTitle(
  entered: NotifyPhase,
  config: NotifyConfig,
  names: PhaseNames,
  focusCount: number,
): string {
  return focusSuffixedLabel(entered, config, names, focusCount);
}

export function buildNotifyMessage(
  leaving: NotifyPhase | undefined,
  entered: NotifyPhase,
  config: NotifyConfig,
  names: PhaseNames,
  focusCount: number,
): string {
  const upcomingMs = notifyDurationMs(config, entered);
  if (leaving === undefined) {
    return `${formatClock(upcomingMs)} remaining`;
  }
  const spent = formatClock(notifyDurationMs(config, leaving));
  const enteredTitle = buildNotifyTitle(entered, config, names, focusCount);
  return `${spent} spent on ${phaseLabel(leaving, names)}. ${enteredTitle} — ${formatClock(upcomingMs)} remaining`;
}

export function buildNotifyConfirmTitle(current: NotifyPhase, names: PhaseNames): string {
  return `${phaseLabel(current, names)} complete`;
}

export function buildNotifyConfirmMessage(
  current: NotifyPhase,
  next: NotifyPhase,
  config: NotifyConfig,
  names: PhaseNames,
  focusCount: number,
): string {
  const spent = formatClock(notifyDurationMs(config, current));
  const upcoming = formatClock(notifyDurationMs(config, next));
  const nextLabel = focusSuffixedLabel(next, config, names, focusCount);
  return `${spent} spent. Start ${nextLabel} — ${upcoming}? Click = yes, No = restart`;
}

/** Startup guard: one `terminal-notifier -version` probe, ENOENT/exit-3 mapped. */
export async function checkNotifierAvailable(exec: ExecFileFn = defaultExec): Promise<void> {
  try {
    await exec(NOTIFIER_BIN, ['-version']);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') {
      throw new Error(BREW_HINT, { cause: err });
    }
    if (code === 3) {
      throw new Error(PERMISSION_HINT, { cause: err });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/permission denied/i.test(message)) {
      throw new Error(PERMISSION_HINT, { cause: err });
    }
    throw err;
  }
}

/** Fire-and-forget delivery: resolves void, never rejects (logs one stderr line). */
export async function sendNotification(
  exec: ExecFileFn = defaultExec,
  opts: NotifyPayload,
): Promise<void> {
  try {
    await exec(NOTIFIER_BIN, baseArgv(opts.title, opts.message, opts.group ?? GROUP_ID));
  } catch (err) {
    // Non-fatal by design (004 D4): a missed toast must not kill a focus.
    process.stderr.write(
      `terminal-notifier notification failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Blocking `-action No` confirmer implementing the driver `ConfirmFn` seam.
 * Click (`@ACTIONCLICKED`) = yes, `No` = no, `@CLOSED`/`@TIMEOUT` = re-send
 * the same toast (shared `-group` replaces in place); anything else or a
 * spawn error resolves `false` with a stderr note (never spins).
 */
export function createNotificationConfirmer(
  exec: ExecFileFn = defaultExec,
  opts: NotifyConfirmerOptions,
): (message: string) => Promise<boolean> {
  const argv = [...baseArgv(opts.title, opts.message, opts.group ?? GROUP_ID), '-action', NO_LABEL];
  const isFinished = opts.isFinished;
  const consumeResendRequest = opts.consumeResendRequest;
  return async (_message: string): Promise<boolean> => {
    if (isFinished?.() === true) return false;
    for (;;) {
      if (isFinished?.() === true) return false;
      let raw: string;
      try {
        const result = await exec(NOTIFIER_BIN, argv);
        raw = result.stdout.trim();
      } catch (err) {
        if (isFinished?.() === true) return false;
        // Driver-initiated kill for unlock-resend: the prompt is still
        // owed, so re-send the same toast (same -group, replaces in
        // place) instead of resolving `false`.
        if (consumeResendRequest?.() === true) continue;
        process.stderr.write(
          `terminal-notifier confirm failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return false;
      }
      if (isFinished?.() === true) return false;
      // An answer won: drop any resend request that raced the click, so a
      // later prompt's genuine failure still resolves `false` (never spins).
      consumeResendRequest?.();
      if (raw === '@ACTIONCLICKED') return true;
      if (raw === NO_LABEL) return false;
      if (raw === '@CLOSED' || raw === '@TIMEOUT') continue;
      process.stderr.write(`unexpected terminal-notifier output: ${JSON.stringify(raw)}\n`);
      return false;
    }
  };
}
