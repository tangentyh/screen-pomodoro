import { describe, expect, it, vi } from 'vitest';
import { createTimer, parseDuration, type PomodoroConfig, type Phase } from '../src/timer.js';

// Intended API (TDD red phase — src/timer.ts does not exist yet):
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

  it.each(['0', '-5', 'abc', '', '0s', '0m', '-1h', '10x', 'Infinity', 'NaN'])(
    'rejects %p',
    (input) => {
      expect(() => parseDuration(input)).toThrow();
    },
  );
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
});

describe('timer pause / resume', () => {
  it('pause freezes remaining; tick while paused never advances', () => {
    const timer = createTimer(defaultConfig());
    timer.start(0);
    timer.tick(MIN);
    const frozen = timer.remainingMs(MIN);

    timer.pause('user', MIN);
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
