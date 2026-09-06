import type { Phase, PomodoroConfig, PomodoroTimer } from './timer.js';

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
 * Build the `Completed N …` summary. Default focus name preserves today's
 * `focuses` wording; a custom `--focus-name` is used verbatim (no inflection).
 */
export function buildSummaryLine(
  focusCount: number,
  names: PhaseNames = DEFAULT_PHASE_NAMES,
): string {
  if (names.focus === DEFAULT_PHASE_NAMES.focus) {
    return `Completed ${String(focusCount)} focuses`;
  }
  return `Completed ${String(focusCount)} ${names.focus}`;
}
