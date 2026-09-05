import { describe, expect, it, vi } from 'vitest';
import {
  createTimer,
  parseDuration,
  type PomodoroConfig,
  type PauseReason,
  type Phase,
} from '../src/timer.js';

// Intended API per docs/002-pomodoro-cli-plan.md (TDD red phase — src/timer.ts
// does not exist yet):
//   - Phase = 'focus' | 'shortBreak' | 'longBreak'
//   - PomodoroConfig = { focusMs, shortBreakMs, longBreakMs, cycles } (all required)
//   - parseDuration(input: string): number (ms, throws on invalid)
//   - createTimer(config): PomodoroTimer with
//     start(nowMs) / tick(nowMs) / pause(reason, nowMs) / resume(reason, nowMs) /
//     nextPhase(nowMs) / remainingMs(nowMs), plus readonly
//     phase / focusCount / paused / pausedReason / endsAtMs.
// Deadline math is absolute (endsAtMs = nowMs + durationMs); pause shifts endsAtMs.

const MIN = 60_000;

function defaultConfig(): PomodoroConfig {
  return { focusMs: 25 * MIN, shortBreakMs: 5 * MIN, longBreakMs: 15 * MIN, cycles: 4 };
}

function tinyConfig(cycles = 4): PomodoroConfig {
  return { focusMs: 1_000, shortBreakMs: 1_000, longBreakMs: 1_000, cycles };
}

describe('parseDuration', () => {
  it('treats a plain number as minutes', () => {
    expect(parseDuration('25')).toBe(25 * MIN);
    expect(parseDuration('5')).toBe(5 * MIN);
  });

  it('accepts s / m / h suffixes', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('25m')).toBe(25 * MIN);
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('accepts decimals such as 1.5h', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('1.5m')).toBe(90_000);
  });

  it.each(['0', '-5', 'abc', '', '0s', '0m', '-1h', '10x'])('rejects %p', (input) => {
    expect(() => parseDuration(input)).toThrow();
  });

  it('rejects non-finite values', () => {
    expect(() => parseDuration('Infinity')).toThrow();
    expect(() => parseDuration('NaN')).toThrow();
  });
});

describe('timer state machine', () => {
  it('starts in focus with an absolute deadline', () => {
    const timer = createTimer(defaultConfig());
    timer.start(0);
    expect(timer.phase).toBe('focus' satisfies Phase);
    expect(timer.focusCount).toBe(0);
    expect(timer.paused).toBe(false);
    expect(timer.endsAtMs).toBe(25 * MIN);
    expect(timer.remainingMs(0)).toBe(25 * MIN);
  });

  it('computes remaining from the absolute deadline so jitter does not accumulate', () => {
    const timer = createTimer(defaultConfig());
    timer.start(1_000);
    // Many small ticks must not drift the deadline.
    for (let now = 1_000; now < 60_000; now += 250) {
      timer.tick(now);
    }
    expect(timer.endsAtMs).toBe(1_000 + 25 * MIN);
    expect(timer.remainingMs(60_000)).toBe(1_000 + 25 * MIN - 60_000);
  });

  it('follows focus → short → … → long → focus order over 4 focuses', () => {
    const timer = createTimer(defaultConfig());
    let now = 0;
    timer.start(now);

    const seen: Phase[] = ['focus'];
    const advancePastDeadline = () => {
      now = timer.endsAtMs;
      timer.tick(now);
      seen.push(timer.phase);
    };

    // 4 focuses + 4 breaks = 8 transitions back to focus.
    for (let i = 0; i < 8; i += 1) {
      advancePastDeadline();
    }

    expect(seen).toEqual([
      'focus',
      'shortBreak',
      'focus',
      'shortBreak',
      'focus',
      'shortBreak',
      'focus',
      'longBreak',
      'focus',
    ]);
  });

  it('picks longBreak iff focusCount % cycles === 0', () => {
    const timer = createTimer(defaultConfig());
    let now = 0;
    timer.start(now);

    const breaks: Phase[] = [];
    for (let i = 0; i < 4; i += 1) {
      // Leave focus.
      now = timer.endsAtMs;
      timer.tick(now);
      breaks.push(timer.phase);
      // Leave break.
      now = timer.endsAtMs;
      timer.tick(now);
    }

    expect(breaks).toEqual(['shortBreak', 'shortBreak', 'shortBreak', 'longBreak']);
    expect(timer.focusCount).toBe(4);
  });

  it('honours custom cycles=2', () => {
    const timer = createTimer(tinyConfig(2));
    let now = 0;
    timer.start(now);

    const seen: Phase[] = ['focus'];
    for (let i = 0; i < 4; i += 1) {
      now = timer.endsAtMs;
      timer.tick(now);
      seen.push(timer.phase);
    }

    expect(seen).toEqual(['focus', 'shortBreak', 'focus', 'longBreak', 'focus']);
  });

  it('increments focusCount only when leaving focus', () => {
    const timer = createTimer(tinyConfig());
    timer.start(0);

    expect(timer.focusCount).toBe(0);
    timer.tick(1_000); // leave focus
    expect(timer.phase).toBe('shortBreak');
    expect(timer.focusCount).toBe(1);
    timer.tick(2_000); // leave break
    expect(timer.phase).toBe('focus');
    expect(timer.focusCount).toBe(1);
  });

  it('does not advance before the deadline', () => {
    const timer = createTimer(tinyConfig());
    timer.start(0);
    timer.tick(999);
    expect(timer.phase).toBe('focus');
    expect(timer.focusCount).toBe(0);
  });

  it('advances exactly once per tick even when nowMs overshoots many phases', () => {
    const timer = createTimer(tinyConfig());
    timer.start(0);

    timer.tick(10_000); // far past focus + break + more
    expect(timer.phase).toBe('shortBreak');
    expect(timer.focusCount).toBe(1);

    // A second tick with the same nowMs advances one more phase.
    timer.tick(10_000);
    expect(timer.phase).toBe('focus');
    expect(timer.focusCount).toBe(1);
  });

  it('loops with no terminal state: longBreak returns to focus', () => {
    const timer = createTimer({
      focusMs: 1_000,
      shortBreakMs: 1_000,
      longBreakMs: 1_000,
      cycles: 1,
    });
    timer.start(0);
    timer.tick(1_000); // focus -> long (cycles=1 => every focus ends in long)
    expect(timer.phase).toBe('longBreak');
    timer.tick(2_000); // long -> focus, not terminated
    expect(timer.phase).toBe('focus');
    expect(timer.focusCount).toBe(1);
  });

  it('nextPhase() advances manually and counts focuses like a deadline', () => {
    const timer = createTimer(tinyConfig(2));
    timer.start(0);

    timer.nextPhase(500); // focus -> short, counts
    expect(timer.phase).toBe('shortBreak');
    expect(timer.focusCount).toBe(1);

    timer.nextPhase(700); // break -> focus, does not count
    expect(timer.phase).toBe('focus');
    expect(timer.focusCount).toBe(1);
  });
});

describe('timer pause / resume', () => {
  it('pause freezes remaining; tick while paused never advances', () => {
    const timer = createTimer(defaultConfig());
    timer.start(0);
    timer.tick(MIN);
    const frozen = timer.remainingMs(MIN);

    timer.pause('user' satisfies PauseReason, MIN);
    expect(timer.paused).toBe(true);

    timer.tick(MIN + 10 * MIN);
    expect(timer.phase).toBe('focus');
    expect(timer.remainingMs(MIN + 10 * MIN)).toBe(frozen);
  });

  it('resume shifts endsAtMs forward by the paused duration', () => {
    const timer = createTimer(defaultConfig());
    timer.start(0);
    timer.pause('user', MIN);
    const frozen = timer.remainingMs(MIN);

    timer.resume('user', MIN + 9 * MIN);
    expect(timer.paused).toBe(false);
    expect(timer.remainingMs(MIN + 9 * MIN)).toBe(frozen);
    expect(timer.endsAtMs).toBe(MIN + 9 * MIN + frozen);
  });

  it('resume continues the same phase', () => {
    const timer = createTimer(tinyConfig());
    timer.start(0);
    timer.pause('screen', 400);
    timer.resume('screen', 5_000);
    expect(timer.phase).toBe('focus');
    expect(timer.remainingMs(5_000)).toBe(600);
  });

  it('pause reasons are orthogonal: user and screen both freeze the same phase', () => {
    for (const reason of ['user', 'screen'] as const satisfies readonly PauseReason[]) {
      const timer = createTimer(tinyConfig());
      timer.start(0);
      timer.pause(reason, 100);
      expect(timer.paused).toBe(true);
      expect(timer.pausedReason).toBe(reason);
      expect(timer.remainingMs(900)).toBe(900);
      timer.resume(reason, 900);
      expect(timer.paused).toBe(false);
      expect(timer.phase).toBe('focus');
    }
  });

  it('duplicate pause is a no-op and keeps the first deadline', () => {
    const timer = createTimer(tinyConfig());
    timer.start(0);
    timer.pause('screen', 100);
    const endsAt = timer.endsAtMs;
    timer.pause('screen', 200); // no-op
    expect(timer.endsAtMs).toBe(endsAt);
    timer.resume('screen', 500);
    expect(timer.remainingMs(500)).toBe(900);
  });

  it('duplicate resume while running is a no-op', () => {
    const timer = createTimer(tinyConfig());
    timer.start(0);
    const endsAt = timer.endsAtMs;
    timer.resume('screen', 100); // no-op: never paused
    expect(timer.endsAtMs).toBe(endsAt);
    expect(timer.paused).toBe(false);
  });

  it('tick past a deadline while paused does not queue a transition', () => {
    const timer = createTimer(tinyConfig());
    timer.start(0);
    timer.pause('user', 100);
    timer.tick(5_000); // well past endsAtMs, but paused
    expect(timer.phase).toBe('focus');
    timer.resume('user', 5_000);
    expect(timer.phase).toBe('focus');
    timer.tick(5_000 + 900);
    expect(timer.phase).toBe('shortBreak');
  });
});

describe('timer purity (no node: imports)', () => {
  it('imports nothing from node:', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../src/timer.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/require\(\s*['"]node:/);
    vi.restoreAllMocks();
  });
});
