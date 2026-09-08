/**
 * `--start <phase>`: begin the timer in an arbitrary phase; with stdin
 * `--confirm` and no `--start`, a startup menu asks once instead.
 *
 * Covers the observable CLI contract via `run(argv)`, following
 * test/confirm.test.ts patterns: `vi.useFakeTimers`, spy `stdout.write`,
 * `defineProperty(process.stdout/stdin, 'isTTY')`. Never blocks on real
 * stdin — `node:readline` is stubbed per-test.
 */
import * as readline from 'node:readline';
import type * as readlineTypes from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { parseStartChoice } from '../src/display.js';
import { createTimer, parseStartPhase } from '../src/timer.js';

vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof readlineTypes>();
  return { ...actual, createInterface: vi.fn() };
});

function mockedCreateInterface(): ReturnType<typeof vi.fn> {
  return vi.mocked(readline.createInterface);
}

function stdoutText(spy: { mock: { calls: readonly unknown[][] } }): string {
  return spy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : String(call[0])))
    .join('');
}

function stderrText(spy: { mock: { calls: readonly unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.map((arg) => String(arg)).join(' ')).join('\n');
}

const originalStdoutIsTTY = (process.stdout as { isTTY?: unknown }).isTTY;
const originalStdinIsTTY = (process.stdin as { isTTY?: unknown }).isTTY;

function setStdinIsTTY(value: boolean | undefined): void {
  if (value === undefined) {
    delete (process.stdin as { isTTY?: unknown }).isTTY;
  } else {
    Object.defineProperty(process.stdin, 'isTTY', {
      value,
      configurable: true,
      writable: true,
    });
  }
}

function countBells(text: string): number {
  return text.split('\x07').length - 1;
}

function mockReadlineQueue(answers: string[]): {
  questionSpy: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
  prompts: string[];
} {
  const prompts: string[] = [];
  const queue = [...answers];
  const questionSpy = vi.fn((prompt: string, cb: (answer: string) => void) => {
    prompts.push(prompt);
    const next = queue.length > 0 ? queue.shift()! : 'y';
    queueMicrotask(() => {
      cb(next);
    });
  });
  const closeSpy = vi.fn(() => undefined);
  mockedCreateInterface().mockReturnValue({ question: questionSpy, close: closeSpy });
  return { questionSpy, closeSpy, prompts };
}

/** Manual answers: test controls exactly when each pending `question()` resolves. */
function mockReadlineManual(): {
  questionSpy: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
  prompts: string[];
  pending: ((answer: string) => void)[];
} {
  const prompts: string[] = [];
  const pending: ((answer: string) => void)[] = [];
  const questionSpy = vi.fn((prompt: string, cb: (answer: string) => void) => {
    prompts.push(prompt);
    pending.push(cb);
  });
  const closeSpy = vi.fn(() => undefined);
  mockedCreateInterface().mockReturnValue({ question: questionSpy, close: closeSpy });
  return { questionSpy, closeSpy, prompts, pending };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('--start unit', () => {
  it('parses focus/short/long plus short-break/long-break aliases', () => {
    expect(parseStartPhase('focus')).toBe('focus');
    expect(parseStartPhase('short')).toBe('shortBreak');
    expect(parseStartPhase('long')).toBe('longBreak');
    expect(parseStartPhase('short-break')).toBe('shortBreak');
    expect(parseStartPhase('long-break')).toBe('longBreak');
  });

  it('is case-insensitive and ignores separators/case variants', () => {
    expect(parseStartPhase('FOCUS')).toBe('focus');
    expect(parseStartPhase('ShortBreak')).toBe('shortBreak');
    expect(parseStartPhase('short_break')).toBe('shortBreak');
    expect(parseStartPhase('SHORT BREAK')).toBe('shortBreak');
    expect(parseStartPhase('LongBreak')).toBe('longBreak');
    expect(parseStartPhase('  long  ')).toBe('longBreak');
  });

  it.each([[''], ['bogus'], ['foc'], ['break'], ['shorts']])('rejects %p', (input) => {
    expect(() => parseStartPhase(input)).toThrow(/invalid --start/);
  });

  it('timer.start honors the initial phase deadline with focusCount 0', () => {
    const config = { focusMs: 25_000, shortBreakMs: 5_000, longBreakMs: 15_000, cycles: 4 };
    const short = createTimer(config);
    short.start(0, 'shortBreak');
    expect(short.phase).toBe('shortBreak');
    expect(short.focusCount).toBe(0);
    expect(short.endsAtMs).toBe(5_000);

    const long = createTimer(config);
    long.start(100, 'longBreak');
    expect(long.phase).toBe('longBreak');
    expect(long.focusCount).toBe(0);
    expect(long.endsAtMs).toBe(100 + 15_000);
  });

  it('timer.start defaults to focus (back-compat)', () => {
    const config = { focusMs: 25_000, shortBreakMs: 5_000, longBreakMs: 15_000, cycles: 4 };
    const timer = createTimer(config);
    timer.start(0);
    expect(timer.phase).toBe('focus');
    expect(timer.endsAtMs).toBe(25_000);
  });
});

describe('--start CLI', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockedCreateInterface().mockClear();
    vi.useRealTimers();
    if (originalStdoutIsTTY === undefined) delete (process.stdout as { isTTY?: unknown }).isTTY;
    else
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
        writable: true,
      });
    if (originalStdinIsTTY === undefined) delete (process.stdin as { isTTY?: unknown }).isTTY;
    else
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinIsTTY,
        configurable: true,
        writable: true,
      });
  });

  it('lists --start in --help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    expect(stdoutText(out)).toContain('--start');
  });

  it('defaults to focus (existing first line unchanged)', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '5m', '--short', '5m', '--long', '5m', '--quiet']);
    await advance(0);
    expect(stdoutText(out)).toContain('Focus 1/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('--start short begins in the short break', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '5m',
      '--short',
      '5m',
      '--long',
      '5m',
      '--quiet',
      '--start',
      'short',
    ]);
    await advance(0);
    const text = stdoutText(out);
    expect(text).toContain('Short break');
    expect(text).not.toContain('Focus');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('--start long begins in the long break', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '5m',
      '--short',
      '5m',
      '--long',
      '5m',
      '--quiet',
      '--start',
      'long',
    ]);
    await advance(0);
    const text = stdoutText(out);
    expect(text).toContain('Long break');
    expect(text).not.toContain('Focus');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('accepts the short-break alias', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '5m', '--short', '5m', '--quiet', '--start', 'short-break']);
    await advance(0);
    expect(stdoutText(out)).toContain('Short break');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('resolves custom names on the starting phase line', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '5m',
      '--short',
      '5m',
      '--short-name',
      'Coffee',
      '--quiet',
      '--start',
      'short',
    ]);
    await advance(0);
    expect(stdoutText(out)).toContain('Coffee');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('rejects an unknown --start value with exit 1', async () => {
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run(['--start', 'bogus'])).resolves.toBe(1);
    expect(stderrText(errOut)).toMatch(/invalid.*--start|expected one of/i);
  });

  it('auto-flow without confirm: --start short advances to Focus 1/4 on expiry', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '60s',
      '--short',
      '1s',
      '--long',
      '60s',
      '--quiet',
      '--start',
      'short',
    ]);
    await advance(0);
    await advance(1_200);
    const text = stdoutText(out);
    expect(text).toContain('Focus 1/4');
    expect(text).toContain('\x07');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    // Break -> focus does not count a focus.
    expect(stdoutText(out)).toMatch(/Completed 0 focuses/);
  });

  it('with --confirm: start short, prompt into the first focus on y', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '60s',
      '--short',
      '1s',
      '--long',
      '60s',
      '--cycles',
      '4',
      '--quiet',
      '--confirm',
      '--start',
      'short',
    ]);
    await advance(0);
    expect(stdoutText(out)).toContain('Short break');
    await advance(1_200);
    await advance(0);
    const combined = `${stdoutText(out)}\n${rl.prompts.join('\n')}`;
    expect(combined).toMatch(/Short break complete\. Start Focus\? \[y\/n\]/);
    expect(countBells(stdoutText(out))).toBe(1);
    expect(stdoutText(out)).toContain('Focus 1/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toMatch(/Completed 0 focuses/);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('with --confirm: start long, prompt into the first focus on y', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '60s',
      '--short',
      '60s',
      '--long',
      '1s',
      '--cycles',
      '4',
      '--quiet',
      '--confirm',
      '--start',
      'long',
    ]);
    await advance(0);
    expect(stdoutText(out)).toContain('Long break');
    await advance(1_200);
    await advance(0);
    const combined = `${stdoutText(out)}\n${rl.prompts.join('\n')}`;
    expect(combined).toMatch(/Long break complete\. Start Focus\? \[y\/n\]/);
    expect(stdoutText(out)).toContain('Focus 1/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });
});

describe('startup menu (--confirm without --start)', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockedCreateInterface().mockClear();
    vi.useRealTimers();
    if (originalStdoutIsTTY === undefined) delete (process.stdout as { isTTY?: unknown }).isTTY;
    else
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
        writable: true,
      });
    if (originalStdinIsTTY === undefined) delete (process.stdin as { isTTY?: unknown }).isTTY;
    else
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinIsTTY,
        configurable: true,
        writable: true,
      });
  });

  it('asks once at startup and starts the chosen short break', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['2', 'y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '60s',
      '--short',
      '1s',
      '--long',
      '60s',
      '--cycles',
      '4',
      '--quiet',
      '--confirm',
    ]);
    await advance(0);
    // Menu first, then the chosen phase line — no Focus line before choosing.
    expect(rl.prompts[0]).toMatch(
      /Choose starting phase: 1\) Focus 2\) Short break 3\) Long break \[1\]/,
    );
    expect(stdoutText(out)).toContain('Short break');
    expect(stdoutText(out)).not.toContain('Focus');
    // One bell for the menu so far.
    expect(countBells(stdoutText(out))).toBe(1);
    // Expiry rings again and gates into the first focus on y.
    await advance(1_200);
    await advance(0);
    const combined = `${stdoutText(out)}\n${rl.prompts.join('\n')}`;
    expect(combined).toMatch(/Short break complete\. Start Focus\? \[y\/n\]/);
    expect(stdoutText(out)).toContain('Focus 1/4');
    expect(countBells(stdoutText(out))).toBe(2);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toMatch(/Completed 0 focuses/);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('empty answer selects the default focus', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    mockReadlineQueue(['']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '5m', '--short', '5m', '--quiet', '--confirm']);
    await advance(0);
    expect(stdoutText(out)).toContain('Focus 1/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('accepts 3 for the long break', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    mockReadlineQueue(['3']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '5m',
      '--short',
      '5m',
      '--long',
      '5m',
      '--quiet',
      '--confirm',
    ]);
    await advance(0);
    expect(stdoutText(out)).toContain('Long break');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('re-prompts silently on invalid input (one bell total)', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['bogus', 'y', '1']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '5m', '--short', '5m', '--quiet', '--confirm']);
    await advance(0);
    await advance(0);
    // 'bogus' and 'y' are not menu answers: asked three times, one bell.
    expect(rl.questionSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(rl.prompts[0]).toMatch(/Choose starting phase/);
    expect(rl.prompts[1]).toMatch(/Choose starting phase/);
    expect(countBells(stdoutText(out))).toBe(1);
    expect(stdoutText(out)).toContain('Focus 1/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('shows custom names and accepts the custom label', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['coffee']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '5m',
      '--short',
      '5m',
      '--short-name',
      'Coffee',
      '--quiet',
      '--confirm',
    ]);
    await advance(0);
    expect(rl.prompts[0]).toMatch(/2\) Coffee/);
    expect(stdoutText(out)).toContain('Coffee');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('explicit --start skips the menu (readline stays lazy until the deadline)', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '60s',
      '--short',
      '1s',
      '--long',
      '60s',
      '--quiet',
      '--confirm',
      '--start',
      'short',
    ]);
    await advance(0);
    // No menu asked: readline untouched and straight into the break.
    expect(mockedCreateInterface()).not.toHaveBeenCalled();
    expect(rl.prompts).toHaveLength(0);
    expect(stdoutText(out)).toContain('Short break');
    await advance(1_200);
    await advance(0);
    // First question is the transition prompt, not the menu.
    expect(rl.prompts[0]).toMatch(/Short break complete\. Start Focus\? \[y\/n\]/);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('SIGINT during the menu prints the summary and exits 0', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineManual();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '5m', '--short', '5m', '--quiet', '--confirm']);
    await advance(0);
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    expect(rl.prompts[0]).toMatch(/Choose starting phase/);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(rl.closeSpy).toHaveBeenCalled();
    expect(stdoutText(out)).toMatch(/Completed 0 focuses/);
    // Nothing started behind the menu: no phase line, no timers left behind.
    expect(stdoutText(out)).not.toContain('remaining');
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('stamps the menu prompt with --timestamp', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['1']);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '5m',
      '--short',
      '5m',
      '--quiet',
      '--confirm',
      '--timestamp',
    ]);
    await advance(0);
    expect(rl.prompts[0]).toMatch(/^\[\d\d:\d\d:\d\d\] Choose starting phase/);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });
});

describe('parseStartChoice unit', () => {
  it('accepts empty (default), digits, and letters', () => {
    expect(parseStartChoice('')).toBe('focus');
    expect(parseStartChoice('   ')).toBe('focus');
    expect(parseStartChoice('1')).toBe('focus');
    expect(parseStartChoice('2')).toBe('shortBreak');
    expect(parseStartChoice('3')).toBe('longBreak');
    expect(parseStartChoice('f')).toBe('focus');
    expect(parseStartChoice('S')).toBe('shortBreak');
    expect(parseStartChoice('l')).toBe('longBreak');
  });

  it('accepts --start words and aliases', () => {
    expect(parseStartChoice('focus')).toBe('focus');
    expect(parseStartChoice('short')).toBe('shortBreak');
    expect(parseStartChoice('LONG-BREAK')).toBe('longBreak');
    expect(parseStartChoice('  short_break  ')).toBe('shortBreak');
  });

  it('accepts custom labels case-insensitively', () => {
    const names = { focus: 'Deep work', shortBreak: 'Coffee', longBreak: 'Lunch' };
    expect(parseStartChoice('coffee', names)).toBe('shortBreak');
    expect(parseStartChoice('DEEP WORK', names)).toBe('focus');
    expect(parseStartChoice('lunch', names)).toBe('longBreak');
  });

  it.each([['y'], ['n'], ['yes'], ['0'], ['4'], ['bogus'], ['focus!']])(
    'returns undefined for %p (caller re-prompts)',
    (input) => {
      expect(parseStartChoice(input)).toBeUndefined();
    },
  );
});
