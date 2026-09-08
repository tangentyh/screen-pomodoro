import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { run } from '../src/cli.js';

function outputOf(spy: { mock: { calls: (readonly unknown[])[] } }): string {
  return spy.mock.calls.map((call) => call.map((arg) => String(arg)).join(' ')).join('\n');
}

function stdoutText(spy: { mock: { calls: (readonly unknown[])[] } }): string {
  return spy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : String(call[0])))
    .join('');
}

// process.stdout.isTTY is undefined when piped (CI) and true on a TTY.
// Mock it via defineProperty so tests can force live vs quiet driver selection.
const originalIsTTY = (process.stdout as { isTTY?: unknown }).isTTY;

function setIsTTY(value: boolean | undefined): void {
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

describe('cli', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalIsTTY === undefined) {
      delete (process.stdout as { isTTY?: unknown }).isTTY;
    } else {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
        writable: true,
      });
    }
  });

  it('prints help and exits 0', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    expect(outputOf(out)).toContain('Usage:');
  });

  it('prints the version and exits 0', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--version'])).resolves.toBe(0);
    expect(outputOf(out)).toContain(pkg.version);
  });

  it('exits 1 with a usage error for unknown options', async () => {
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run(['--nope'])).resolves.toBe(1);
    expect(outputOf(errOut)).toContain('unknown option');
  });

  // --- docs/002-pomodoro-cli-plan.md: CLI surface ---

  it('lists pomodoro options in help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    const help = outputOf(out);
    expect(help).toContain('--focus');
    expect(help).toContain('--short');
    expect(help).toContain('--long');
    expect(help).toContain('--cycles');
    expect(help).toContain('--no-loop');
    expect(help).toMatch(/--quiet/);
  });

  it.each([
    ['--focus', '0'],
    ['--focus', '-5'],
    ['--focus', 'abc'],
  ])('rejects %s %s with a usage error', async (flag, value) => {
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run([flag, value])).resolves.toBe(1);
    // Validation wording, not just "unknown option".
    expect(outputOf(errOut)).toMatch(/positive|invalid|duration|must be/i);
  });

  it.each([
    ['--short', '0'],
    ['--long', '-1m'],
    ['--cycles', '0'],
    ['--cycles', '1.5'],
    ['--cycles', 'abc'],
  ])('rejects %s %s with a usage error', async (flag, value) => {
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run([flag, value])).resolves.toBe(1);
    expect(outputOf(errOut)).toMatch(/positive|integer|invalid|duration|must be|>= 1/i);
  });

  it('accepts duration suffixes s / m / h', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '90s',
      '--short',
      '5m',
      '--long',
      '0.05h',
      '--cycles',
      '2',
      '--quiet',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    // Driver started instead of erroring: at least a phase line was logged.
    expect(out.mock.calls.length).toBeGreaterThan(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  // --- docs/002-pomodoro-cli-plan.md: timing / display / driver ---

  it('bare run starts the live driver and exits 0 with a summary on SIGINT', async () => {
    vi.useFakeTimers();
    setIsTTY(true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const runPromise = run([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setIntervalSpy).toHaveBeenCalled();
    expect(out.mock.calls.length).toBeGreaterThan(0);

    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);

    const text = stdoutText(out);
    expect(text).toMatch(/completed/i);
    expect(text).toMatch(/focus/i);
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('TTY live mode re-renders one line via carriage return', async () => {
    vi.useFakeTimers();
    setIsTTY(true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const runPromise = run(['--focus', '5m']);
    await vi.advanceTimersByTimeAsync(1_000);
    const text = stdoutText(out);
    expect(text).toContain('\r');

    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('--quiet arms a timeout chain and logs transitions only (few writes)', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '1s',
      '--long',
      '1s',
      '--cycles',
      '2',
      '--quiet',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(setTimeoutSpy).toHaveBeenCalled();

    // Through focus + short + focus + into long: only a handful of lines, no live ticks.
    await vi.advanceTimersByTimeAsync(3_500);
    const writes = out.mock.calls.length;
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(writes).toBeLessThanOrEqual(10);

    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('defaults to quiet timeout chain when stdout is not a TTY', async () => {
    vi.useFakeTimers();
    setIsTTY(undefined);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const runPromise = run(['--focus', '1s', '--short', '1s', '--long', '1s']);
    await vi.advanceTimersByTimeAsync(0);
    expect(setTimeoutSpy).toHaveBeenCalled();
    // 005: quiet still polls for screen lock (2000ms) on darwin, but never
    // arms the live 250ms countdown. Filter by interval ms, not any call.
    const intervals = setIntervalSpy.mock.calls
      .map((call) => call[1])
      .filter((ms): ms is number => typeof ms === 'number');
    expect(intervals).not.toContain(250);
    expect(out.mock.calls.length).toBeGreaterThan(0);

    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('rings the bell and prints a new phase line on phase change', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const runPromise = run([
      '--focus',
      '2s',
      '--short',
      '1s',
      '--long',
      '1s',
      '--cycles',
      '4',
      '--quiet',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(stdoutText(out)).toContain('\x07');

    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('--no-loop stops after the first long break without SIGINT', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '1s',
      '--long',
      '1s',
      '--cycles',
      '2',
      '--quiet',
      '--no-loop',
    ]);
    // focus(1s) + short(1s) + focus(1s) + long(1s) = 4s, then exit.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('--no-loop terminal rings + summary without starting the next focus', async () => {
    vi.useFakeTimers();
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
    ]);
    // focus(1s) + long(1s) = 2s, then exit.
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(runPromise).resolves.toBe(0);
    const text = stdoutText(out);
    expect(text).toContain('\x07');
    expect(text).toContain('Long break');
    expect(text).toMatch(/Completed 1 focuses/);
    // Exactly one focus line (startup): the terminal long break must not
    // start — or print — the next focus before exiting.
    expect(text.split('Focus').length - 1).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('focus counter wraps per set across long breaks (Focus 1/2 again, not stuck at 2/2)', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '1s',
      '--long',
      '1s',
      '--cycles',
      '2',
      '--quiet',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    // focus + short + focus + long + into the next set's first focus.
    await vi.advanceTimersByTimeAsync(4_500);
    const text = stdoutText(out);
    // Second set restarts at 1/2 instead of sticking at 2/2.
    expect(text.split('Focus 1/2').length - 1).toBe(2);

    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('cleans up timers, SIGINT handler, and monitor subscription on exit', async () => {
    vi.useFakeTimers();
    setIsTTY(true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const runPromise = run(['--focus', '1s', '--short', '1s', '--long', '1s', '--quiet']);
    await vi.advanceTimersByTimeAsync(500);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);

    expect(clearIntervalSpy.mock.calls.length + clearTimeoutSpy.mock.calls.length).toBeGreaterThan(
      0,
    );
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('does not put stdin into raw mode', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setRawMode = (process.stdin as { setRawMode?: unknown }).setRawMode;
    const rawSpy =
      typeof setRawMode === 'function'
        ? vi.spyOn(process.stdin as unknown as { setRawMode: () => void }, 'setRawMode')
        : null;

    const runPromise = run(['--focus', '1s', '--short', '1s', '--long', '1s', '--quiet']);
    await vi.advanceTimersByTimeAsync(200);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);

    if (rawSpy !== null) {
      expect(rawSpy).not.toHaveBeenCalled();
    }
  });
});
