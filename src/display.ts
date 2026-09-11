import { parseStartPhase, type Phase, type PomodoroConfig, type PomodoroTimer } from './timer.js';

export interface PhaseNames {
  focus: string;
  shortBreak: string;
  longBreak: string;
}

export const DEFAULT_PHASE_NAMES: PhaseNames = {
  focus: 'Focus',
  shortBreak: 'Short break',
  longBreak: 'Long break',
};

/**
 * Validate a custom phase name. Shared by all three `--*-name` options so the
 * usage-error contract stays identical (exit 1, `/name|empty|invalid/i`).
 * Returns the trimmed name for display.
 */
export function parsePhaseName(raw: string, flag: string): string {
  if (raw.includes('\r') || raw.includes('\n') || raw.includes('\t') || raw.includes('\u0007')) {
    throw new Error(
      `invalid ${flag} ${JSON.stringify(raw)}: name must not contain control characters (\\r \\n \\t \\x07)`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`invalid ${flag} ${JSON.stringify(raw)}: name must not be empty`);
  }
  if ([...trimmed].length > 40) {
    throw new Error(`invalid ${flag} ${JSON.stringify(raw)}: name must be at most 40 characters`);
  }
  return trimmed;
}

/**
 * Parse an interactive start-menu answer into a `Phase`.
 *
 * Accepts `1`/`2`/`3`, `f`/`s`/`l`, the `--start` word forms (via
 * `parseStartPhase`), and the current custom phase labels
 * (case-insensitive) — plus empty input, which selects the default focus.
 * Returns `undefined` for anything else so the caller can re-prompt.
 * Pure (no `node:` imports). Digits/letters take precedence over custom
 * labels on the rare single-letter collision.
 */
export function parseStartChoice(
  raw: string,
  names: PhaseNames = DEFAULT_PHASE_NAMES,
): Phase | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return 'focus';
  const lowered = trimmed.toLowerCase();
  if (lowered === '1' || lowered === 'f') return 'focus';
  if (lowered === '2' || lowered === 's') return 'shortBreak';
  if (lowered === '3' || lowered === 'l') return 'longBreak';
  try {
    return parseStartPhase(trimmed);
  } catch {
    // Not a --start word: fall through to the custom-label match.
  }
  if (lowered === names.focus.toLowerCase()) return 'focus';
  if (lowered === names.shortBreak.toLowerCase()) return 'shortBreak';
  if (lowered === names.longBreak.toLowerCase()) return 'longBreak';
  return undefined;
}

/**
 * Resolve a phase to its display label. Future monitors (desktop
 * notifications, etc.) must reuse this helper, never hardcode `Focus`.
 */
export function phaseLabel(phase: Phase, names: PhaseNames = DEFAULT_PHASE_NAMES): string {
  switch (phase) {
    case 'focus':
      return names.focus;
    case 'shortBreak':
      return names.shortBreak;
    case 'longBreak':
      return names.longBreak;
  }
}

export function formatClock(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${String(minutes)}:${seconds}`;
}

/**
 * Format a wall-clock timestamp prefix (`[HH:MM:SS]`, local time) for
 * `--timestamp` log lines. Takes `nowMs` (default `Date.now()`) so tests
 * can pin the clock with fake timers.
 */
export function formatTimestamp(nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}

/**
 * Prefix a log line with the current timestamp (`[HH:MM:SS] line`).
 * Pure wrapper around {@link formatTimestamp} — the driver applies it to
 * history lines when `--timestamp` is set.
 */
export function withTimestamp(text: string, nowMs: number = Date.now()): string {
  return `${formatTimestamp(nowMs)} ${text}`;
}

/**
 * Build the countdown line for the timer's current phase. Counter (`N/M`)
 * appears on focus only. Reused by live, quiet, pause, and confirm flows.
 */
export function buildPhaseLine(
  timer: PomodoroTimer,
  config: PomodoroConfig,
  names: PhaseNames = DEFAULT_PHASE_NAMES,
  nowMs: number = Date.now(),
): string {
  const clock = formatClock(timer.remainingMs(nowMs));
  if (timer.phase === 'focus') {
    // Position within the current set so the counter cycles 1/M..M/M across
    // sets instead of sticking at M/M once an infinite loop passes the
    // first long break.
    const current = (timer.focusCount % config.cycles) + 1;
    return `${phaseLabel(timer.phase, names)} ${String(current)}/${String(config.cycles)} — ${clock} remaining`;
  }
  return `${phaseLabel(timer.phase, names)} — ${clock} remaining`;
}

/**
 * Build the persistent pause history line (006). Shared by live and quiet
 * so both modes log identical copy; the live in-place suffix stays separate.
 */
export function buildPausedLine(
  timer: PomodoroTimer,
  names: PhaseNames = DEFAULT_PHASE_NAMES,
): string {
  return `Paused ${phaseLabel(timer.phase, names)} — screen locked, timer frozen`;
}

/**
 * Build the persistent resume history line (006). Shared by live and quiet.
 */
export function buildResumedLine(
  timer: PomodoroTimer,
  names: PhaseNames = DEFAULT_PHASE_NAMES,
  nowMs: number = Date.now(),
): string {
  return `Resumed ${phaseLabel(timer.phase, names)} — ${formatClock(timer.remainingMs(nowMs))} remaining`;
}

/**
 * Build the `Completed N …` summary. Default names preserve today's
 * `focuses` / `short breaks` / `long breaks` wording; a custom name is used
 * verbatim (no inflection) in its own slot.
 */
export function buildSummaryLine(
  focusCount: number,
  names: PhaseNames = DEFAULT_PHASE_NAMES,
  shortBreakCount = 0,
  longBreakCount = 0,
): string {
  const focusPart =
    names.focus === DEFAULT_PHASE_NAMES.focus
      ? `Completed ${String(focusCount)} focuses`
      : `Completed ${String(focusCount)} ${names.focus}`;
  const shortPart =
    names.shortBreak === DEFAULT_PHASE_NAMES.shortBreak
      ? `${String(shortBreakCount)} short breaks`
      : `${String(shortBreakCount)} ${names.shortBreak}`;
  const longPart =
    names.longBreak === DEFAULT_PHASE_NAMES.longBreak
      ? `${String(longBreakCount)} long breaks`
      : `${String(longBreakCount)} ${names.longBreak}`;
  return `${focusPart}, ${shortPart}, ${longPart}`;
}
