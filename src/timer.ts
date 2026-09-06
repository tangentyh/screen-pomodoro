export type Phase = 'focus' | 'shortBreak' | 'longBreak';

export type PauseReason = 'user' | 'screen';

export interface PomodoroConfig {
  focusMs: number;
  shortBreakMs: number;
  longBreakMs: number;
  cycles: number;
}

export interface PomodoroTimer {
  readonly phase: Phase;
  readonly focusCount: number;
  readonly paused: boolean;
  readonly pausedReason: PauseReason | undefined;
  readonly endsAtMs: number;
  start(nowMs: number): void;
  tick(nowMs: number): void;
  pause(reason: PauseReason, nowMs: number): void;
  resume(reason: PauseReason, nowMs: number): void;
  nextPhase(nowMs: number): void;
  restartCurrentPhase(nowMs: number): void;
  shiftEndsAtMs(deltaMs: number): void;
  remainingMs(nowMs: number): number;
}

/**
 * Nominal duration of a phase from config. Pure switch (no math change) —
 * the shared lookup for both the timer core and the notify builders (004 D10),
 * so spent/upcoming clocks never inflate with pause/gating/overshoot (D7).
 */
export function phaseDurationMs(config: PomodoroConfig, phase: Phase): number {
  switch (phase) {
    case 'focus':
      return config.focusMs;
    case 'shortBreak':
      return config.shortBreakMs;
    case 'longBreak':
      return config.longBreakMs;
  }
}

function durationForPhase(config: PomodoroConfig, phase: Phase): number {
  return phaseDurationMs(config, phase);
}

/**
 * Parse a CLI duration into milliseconds.
 *
 * Plain numbers mean minutes (`25` → 25 min). Suffixes `s` / `m` / `h`
 * select seconds / minutes / hours. Decimals are allowed (`1.5h`).
 * Throws on anything that is not a positive finite duration.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  const match = /^([0-9]*\.?[0-9]+)\s*([sSmMhH])?$/.exec(trimmed);
  if (match === null) {
    throw new Error(
      `invalid duration ${JSON.stringify(input)}: expected a positive number with optional s/m/h suffix (e.g. 25, 90s, 25m, 1h)`,
    );
  }
  const amount = Number(match[1]);
  const suffix = (match[2] ?? 'm').toLowerCase();
  if (!Number.isFinite(amount)) {
    throw new Error(
      `invalid duration ${JSON.stringify(input)}: duration must be a positive finite number`,
    );
  }
  let ms: number;
  switch (suffix) {
    case 's':
      ms = amount * 1000;
      break;
    case 'm':
      ms = amount * 60_000;
      break;
    case 'h':
      ms = amount * 3_600_000;
      break;
    default:
      throw new Error(
        `invalid duration ${JSON.stringify(input)}: unknown suffix ${JSON.stringify(suffix)}`,
      );
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `invalid duration ${JSON.stringify(input)}: duration must be a positive finite duration`,
    );
  }
  return ms;
}

export function createTimer(config: PomodoroConfig): PomodoroTimer {
  let phase: Phase = 'focus';
  let focusCount = 0;
  let endsAtMs = 0;
  let paused = false;
  let pausedReason: PauseReason | undefined = undefined;
  let pausedAtMs = 0;
  let frozenRemainingMs = 0;
  let started = false;

  function nextPhaseAfter(current: Phase, completedFocuses: number): Phase {
    if (current === 'focus') {
      return completedFocuses % config.cycles === 0 ? 'longBreak' : 'shortBreak';
    }
    return 'focus';
  }

  return {
    get phase(): Phase {
      return phase;
    },
    get focusCount(): number {
      return focusCount;
    },
    get paused(): boolean {
      return paused;
    },
    get pausedReason(): PauseReason | undefined {
      return pausedReason;
    },
    get endsAtMs(): number {
      return endsAtMs;
    },

    start(nowMs: number): void {
      phase = 'focus';
      focusCount = 0;
      paused = false;
      pausedReason = undefined;
      endsAtMs = nowMs + config.focusMs;
      started = true;
    },

    remainingMs(nowMs: number): number {
      if (!started) return 0;
      if (paused) return frozenRemainingMs;
      return endsAtMs - nowMs;
    },

    pause(reason: PauseReason, nowMs: number): void {
      if (!started || paused) return;
      paused = true;
      pausedReason = reason;
      pausedAtMs = nowMs;
      frozenRemainingMs = endsAtMs - nowMs;
    },

    resume(_reason: PauseReason, nowMs: number): void {
      if (!started || !paused) return;
      paused = false;
      pausedReason = undefined;
      endsAtMs += nowMs - pausedAtMs;
    },

    tick(nowMs: number): void {
      if (!started || paused) return;
      if (nowMs < endsAtMs) return;
      const leaving = phase;
      if (leaving === 'focus') {
        focusCount += 1;
      }
      const next = nextPhaseAfter(leaving, focusCount);
      phase = next;
      // Anchor the next deadline to the previous deadline so event-loop
      // jitter does not accumulate, while still advancing exactly one phase
      // per tick even when nowMs overshoots many phases.
      endsAtMs += durationForPhase(config, next);
    },

    nextPhase(nowMs: number): void {
      if (!started) return;
      const leaving = phase;
      if (leaving === 'focus') {
        focusCount += 1;
      }
      const next = nextPhaseAfter(leaving, focusCount);
      phase = next;
      const duration = durationForPhase(config, next);
      if (paused) {
        // Keep the countdown frozen on the new phase.
        endsAtMs = pausedAtMs + duration;
        frozenRemainingMs = duration;
      } else {
        endsAtMs = nowMs + duration;
      }
    },

    restartCurrentPhase(nowMs: number): void {
      if (!started) return;
      // Full restart of the current phase (`n` in --confirm): reset the
      // absolute deadline to a full duration, keep phase + focusCount.
      // Pure (no node: imports) so timer stays phase-enum-only per 003 D1.
      const duration = durationForPhase(config, phase);
      if (paused) {
        frozenRemainingMs = duration;
        endsAtMs = pausedAtMs + duration;
      } else {
        endsAtMs = nowMs + duration;
      }
    },

    shiftEndsAtMs(deltaMs: number): void {
      if (!started || !Number.isFinite(deltaMs) || deltaMs === 0) return;
      // Shift the absolute deadline (used to freeze `--confirm` gating time
      // so answering delay never eats into the next phase). Keeps frozen
      // remaining consistent while paused. Pure, no node: imports.
      endsAtMs += deltaMs;
      if (paused) {
        frozenRemainingMs += deltaMs;
      }
    },
  };
}
