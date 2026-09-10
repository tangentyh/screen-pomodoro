/**
 * TDD red phase for docs/003-confirm-and-names.md — part 2: confirm gate.
 *
 * Covers the observable CLI contract only (via `run(argv)`), following
 * test/cli.test.ts patterns: `vi.useFakeTimers`, spy `stdout.write`,
 * `defineProperty(process.stdout/stdin, 'isTTY')`, assert SIGINT cleanup.
 * Never blocks on real stdin — `node:readline` is stubbed per-test.
 *
 * All confirm tests are expected to FAIL until 003 confirm is implemented:
 * `--confirm` is an unknown option today (exit 1 "unknown option").
 */
import * as readline from 'node:readline';
import type * as readlineTypes from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { NoopMonitor, PollingMonitor } from '../src/screen.js';

// ESM module namespaces are not spy-able, so stub `node:readline` via vi.mock.
// The driver under test must use `node:readline` `createInterface` / `question()`
// (per 003 non-goals); per-test helpers below set the mock return per test.
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof readlineTypes>();
  return { ...actual, createInterface: vi.fn() };
});

function mockedCreateInterface(): ReturnType<typeof vi.fn> {
  return vi.mocked(readline.createInterface);
}

// ---------------------------------------------------------------------------
// helpers (mirrors test/cli.test.ts)
// ---------------------------------------------------------------------------

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

function setStdoutIsTTY(value: boolean | undefined): void {
  if (value === undefined) {
    delete (process.stdout as { isTTY?: unknown }).isTTY;
  } else {
    Object.defineProperty(process.stdout, 'isTTY', {
      value,
      configurable: true,
      writable: true,
    });
  }
}

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

// --- readline stubs ---------------------------------------------------------
// Spec 003: driver uses `node:readline` `question()` (Enter-required), never
// `setRawMode`. Tests stub `createInterface` so nothing blocks on real stdin.

interface MockReadline {
  questionSpy: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
  prompts: string[];
}

/** Auto-answer every `question()` from a queue (default `'y'`). Async like real typing. */
function mockReadlineQueue(answers: string[]): MockReadline {
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
  const createSpy = mockedCreateInterface();
  createSpy.mockReturnValue({ question: questionSpy, close: closeSpy });
  return { questionSpy, closeSpy, createSpy, prompts };
}

/** Manual answers: test controls exactly when each pending `question()` resolves. */
function mockReadlineManual(): MockReadline & {
  pending: ((answer: string) => void)[];
  answerNext: (answer: string) => void;
} {
  const prompts: string[] = [];
  const pending: ((answer: string) => void)[] = [];
  const questionSpy = vi.fn((prompt: string, cb: (answer: string) => void) => {
    prompts.push(prompt);
    pending.push(cb);
  });
  const closeSpy = vi.fn(() => undefined);
  const createSpy = mockedCreateInterface();
  createSpy.mockReturnValue({ question: questionSpy, close: closeSpy });
  return {
    questionSpy,
    closeSpy,
    createSpy,
    prompts,
    pending,
    answerNext: (answer: string): void => {
      const cb = pending.shift();
      if (cb) cb(answer);
    },
  };
}

/** Capture the screen-monitor listener so tests can fire locked/active. */
function captureScreenListener(): { get: () => ((s: 'active' | 'locked') => void) | undefined } {
  let captured: ((s: 'active' | 'locked') => void) | undefined;
  const capture = (listener: (s: 'active' | 'locked') => void): (() => void) => {
    captured = listener;
    return () => undefined;
  };
  // 005: driver uses PollingMonitor on darwin — spy both backends.
  vi.spyOn(NoopMonitor.prototype, 'subscribe').mockImplementation(capture);
  vi.spyOn(PollingMonitor.prototype, 'subscribe').mockImplementation(capture);
  return { get: () => captured };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// ---------------------------------------------------------------------------

describe('003 — confirm gate', () => {
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

  it('lists --confirm in --help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    expect(stdoutText(out)).toContain('--confirm');
  });

  it('--confirm without an interactive stdin fails fast with exit 1', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(false);
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const createSpy = mockedCreateInterface();
    await expect(
      run(['--focus', '1s', '--short', '1s', '--long', '1s', '--quiet', '--confirm']),
    ).resolves.toBe(1);
    expect(stderrText(errOut)).toContain('--confirm requires an interactive terminal');
    // Driver never starts: no phase line, no timers, no readline.
    expect(out).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    // No dangling timeout from the driver (allow the commander's own internal ones
    // by asserting none of them re-armed a pomodoro phase — simplest: no stdout).
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('prompt format is "<current> complete. Start <next>? [y/n]" with one bell (quiet)', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '5s',
      '--long',
      '5s',
      '--cycles',
      '4',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    const prompt = rl.prompts[0] ?? '';
    const combined = `${stdoutText(out)}\n${rl.prompts.join('\n')}`;
    expect(prompt.length + stdoutText(out).length).toBeGreaterThan(0);
    expect(combined).toMatch(/Focus complete\. Start Short break\? \[y\/n\]/);
    expect(countBells(stdoutText(out))).toBe(1);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('y advances exactly one phase and counts a focus when leaving focus', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    mockReadlineQueue(['y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--cycles',
      '4',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    expect(stdoutText(out)).toContain('Focus 1/4');
    await advance(1_200);
    await advance(0);
    // Advanced to short break, no second bell on the y-advance line.
    expect(stdoutText(out)).toContain('Short break');
    expect(countBells(stdoutText(out))).toBe(1);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    // Leaving focus counted exactly one.
    expect(stdoutText(out)).toMatch(/Completed 1 focuses/);
  });

  it('y from a break does not increment the focus count', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    mockReadlineQueue(['y', 'y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '1s',
      '--long',
      '60s',
      '--cycles',
      '4',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200); // focus -> short (count 1)
    await advance(0);
    await advance(1_200); // short -> focus (still count 1)
    await advance(0);
    expect(stdoutText(out)).toContain('Focus 2/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toMatch(/Completed 1 focuses/);
  });

  it('n restarts the same phase with a full deadline and unchanged count', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineManual();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '2s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--cycles',
      '4',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(2_200); // deadline -> prompt
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    rl.answerNext('n');
    await advance(0);
    // Restarted current phase line, no bell on restart.
    expect(stdoutText(out)).toContain('Focus 1/4');
    expect(countBells(stdoutText(out))).toBe(1);
    // Less than a full duration later: no second prompt yet (deadline was reset).
    await advance(1_000);
    await advance(0);
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    // After the full restarted duration: prompts again.
    await advance(1_200);
    await advance(0);
    expect(rl.questionSpy).toHaveBeenCalledTimes(2);
    rl.answerNext('y');
    await advance(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('invalid input re-prompts without transitioning (question called 2x)', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['maybe', 'y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    await advance(0);
    expect(rl.questionSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Eventually advanced after the valid y.
    expect(stdoutText(out)).toContain('Short break');
    // No extra bell for the re-prompt.
    expect(countBells(stdoutText(out))).toBe(1);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it.each([
    ['Y', 'Short break'],
    ['N', 'Focus 1/4'],
  ])('accepts %p case-insensitively', async (answer, expectedLine) => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    mockReadlineQueue([answer]);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    expect(stdoutText(out)).toContain(expectedLine);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it.each([['yes'], ['no'], [''], ['yy']])(
    're-prompts on %p instead of transitioning',
    async (bad) => {
      vi.useFakeTimers();
      setStdinIsTTY(true);
      const rl = mockReadlineQueue([bad, 'y']);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const runPromise = run([
        '--focus',
        '1s',
        '--short',
        '60s',
        '--long',
        '60s',
        '--quiet',
        '--confirm',
        '--start',
        'focus',
      ]);
      await advance(0);
      await advance(1_200);
      await advance(0);
      await advance(0);
      expect(rl.questionSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(stdoutText(out)).toContain('Short break');
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
    },
  );

  it('trims whitespace around y/n', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    mockReadlineQueue(['  y  ']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    expect(stdoutText(out)).toContain('Short break');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('confirm prompt resolves custom names on both sides', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--focus-name',
      'Deep work',
      '--short-name',
      'Coffee',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    const combined = `${stdoutText(out)}\n${rl.prompts.join('\n')}`;
    expect(combined).toMatch(/Deep work complete\. Start Coffee\? \[y\/n\]/);
    expect(stdoutText(out)).toContain('Coffee');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('quiet mode suspends the timeout chain while awaiting an answer', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineManual();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '1s',
      '--long',
      '60s',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    const writesWhilePending = out.mock.calls.length;
    // Time passes with no answer: no re-arm, no extra prompts, no transitions.
    await advance(5_000);
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    expect(out.mock.calls.length).toBe(writesWhilePending);
    rl.answerNext('y');
    await advance(0);
    expect(stdoutText(out)).toContain('Short break');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('live mode suspends interval ticks while awaiting an answer', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    setStdoutIsTTY(true);
    const rl = mockReadlineManual();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(500);
    await advance(1_000); // cross the 1s deadline
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    const writesWhilePending = out.mock.calls.length;
    await advance(2_000);
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    expect(out.mock.calls.length).toBe(writesWhilePending);
    rl.answerNext('y');
    await advance(500);
    expect(stdoutText(out)).toContain('Short break');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('one deadline -> one prompt -> one y = one phase (no cascade on overshoot)', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineManual();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '1s',
      '--long',
      '60s',
      '--cycles',
      '4',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    // Jump far past several phases at once. Gating time is frozen: the 9s
    // spent awaiting the answer must not eat into the next phase, so one y
    // advances exactly one phase with a fresh deadline (no cascade, no
    // immediate expiry from the gating delay itself).
    await advance(10_000);
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    rl.answerNext('y');
    await advance(0);
    await advance(0);
    // Exactly one phase per answer: now in short break with a fresh deadline.
    expect(stdoutText(out)).toContain('Short break');
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    // Advancing past the short break's full (post-answer) duration prompts
    // for the next transition instead of having cascaded earlier.
    await advance(1_200);
    await advance(0);
    expect(rl.questionSpy).toHaveBeenCalledTimes(2);
    rl.answerNext('y');
    await advance(0);
    expect(stdoutText(out)).toContain('Focus 2/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('SIGINT while pending closes readline, clears timers, prints summary, exits 0', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineManual();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(rl.closeSpy).toHaveBeenCalled();
    expect(clearIntervalSpy.mock.calls.length + clearTimeoutSpy.mock.calls.length).toBeGreaterThan(
      0,
    );
    expect(stdoutText(out)).toMatch(/Completed \d+ focuses/);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('does not put stdin into raw mode when confirming', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    mockReadlineQueue(['y']);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const maybeStdin = process.stdin as unknown as { setRawMode?: () => void };
    const rawSpy =
      typeof maybeStdin.setRawMode === 'function' ? vi.spyOn(maybeStdin, 'setRawMode') : null;
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    if (rawSpy !== null) expect(rawSpy).not.toHaveBeenCalled();
  });

  it('--no-loop with --confirm exits after the long break without a trailing prompt', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    // focus -> long (cycles=1) needs one y; leaving longBreak must exit directly.
    const rl = mockReadlineQueue(['y']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '1s',
      '--long',
      '1s',
      '--cycles',
      '1',
      '--quiet',
      '--no-loop',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    await advance(1_500);
    await advance(0);
    await expect(runPromise).resolves.toBe(0);
    // One prompt for focus->long, none for the terminal long->exit.
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    expect(stdoutText(out)).toMatch(/Completed 1 focuses/);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('creates the readline interface lazily on first prompt and closes it on finish', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['y']);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '5s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    expect(rl.createSpy).not.toHaveBeenCalled();
    await advance(5_200);
    await advance(0);
    expect(rl.createSpy).toHaveBeenCalledTimes(1);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(rl.closeSpy).toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('screen lock while awaiting an answer is a no-op and the answer still wins', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const screen = captureScreenListener();
    const rl = mockReadlineManual();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--confirm',
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    // Countdown already frozen: lock must not break the pending prompt.
    screen.get()?.('locked');
    await advance(1_000);
    expect(rl.questionSpy).toHaveBeenCalledTimes(1);
    rl.answerNext('y');
    await advance(0);
    expect(stdoutText(out)).toContain('Short break');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });
});
