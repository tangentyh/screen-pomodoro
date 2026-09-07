/**
 * TDD red phase for docs/003-confirm-and-names.md — part 1: phase names.
 *
 * Covers the observable CLI contract only (via `run(argv)`), following
 * test/cli.test.ts patterns: `vi.useFakeTimers`, spy `stdout.write`,
 * `defineProperty(process.stdout, 'isTTY')`, assert SIGINT cleanup.
 *
 * All naming tests are expected to FAIL until 003 naming is implemented:
 * `--focus-name`, `--short-name`, `--long-name` are unknown options today.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { NoopMonitor, PollingMonitor } from '../src/screen.js';

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

/** Capture the screen-monitor listener so tests can fire locked/active. */
function captureScreenListener(): { get: () => ((s: 'active' | 'locked') => void) | undefined } {
  let captured: ((s: 'active' | 'locked') => void) | undefined;
  const capture = (listener: (s: 'active' | 'locked') => void): (() => void) => {
    captured = listener;
    return () => undefined;
  };
  // 005: driver uses PollingMonitor on darwin, NoopMonitor elsewhere/
  // opt-out. Spy both so the capture works regardless of backend (the real
  // poll interval hasn't fired yet for the short advances below, so no real
  // ioreg spawn interferes).
  vi.spyOn(NoopMonitor.prototype, 'subscribe').mockImplementation(capture);
  vi.spyOn(PollingMonitor.prototype, 'subscribe').mockImplementation(capture);
  return { get: () => captured };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// ---------------------------------------------------------------------------

describe('003 — phase names', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('lists the three --*-name options in --help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    const help = stdoutText(out);
    expect(help).toContain('--focus-name');
    expect(help).toContain('--short-name');
    expect(help).toContain('--long-name');
  });

  it('defaults unchanged: bare quiet run still prints Focus 1/4 and Short break', async () => {
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
      '4',
      '--quiet',
    ]);
    await advance(0);
    await advance(1_200);
    const text = stdoutText(out);
    expect(text).toContain('Focus 1/4');
    expect(text).toContain('Short break');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('custom names appear in the quiet first line', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '5m',
      '--focus-name',
      'Deep work',
      '--short-name',
      'Coffee',
      '--long-name',
      'Lunch',
      '--quiet',
    ]);
    await advance(0);
    expect(stdoutText(out)).toContain('Deep work 1/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('custom names appear in the live first line', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '5m', '--focus-name', 'Deep work', '--cycles', '4']);
    await advance(500);
    expect(stdoutText(out)).toContain('Deep work 1/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('custom names appear in the bell phase-change line (quiet)', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '5s',
      '--long',
      '5s',
      '--focus-name',
      'Deep work',
      '--short-name',
      'Coffee',
      '--quiet',
    ]);
    await advance(0);
    await advance(1_200);
    const text = stdoutText(out);
    expect(text).toContain('\x07');
    expect(text).toContain('Coffee');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('custom names appear in the bell phase-change line (live)', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '5s',
      '--long',
      '5s',
      '--focus-name',
      'Deep work',
      '--short-name',
      'Coffee',
    ]);
    await advance(0);
    await advance(1_500);
    const text = stdoutText(out);
    expect(text).toContain('\x07');
    expect(text).toContain('Coffee');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('summary uses default "focuses" wording without custom names', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '1s', '--short', '1s', '--long', '1s', '--quiet']);
    await advance(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toMatch(/Completed \d+ focuses/);
  });

  it('summary uses the custom focus name verbatim (no inflection)', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '1s',
      '--long',
      '1s',
      '--focus-name',
      'Deep work',
      '--quiet',
    ]);
    await advance(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toContain('Completed 0 Deep work');
  });

  it.each([
    ['--focus-name', ''],
    ['--short-name', ''],
    ['--long-name', ''],
    ['--focus-name', '   '],
    ['--short-name', '   '],
    ['--focus-name', 'a\nb'],
    ['--short-name', 'a\nb'],
    ['--long-name', 'a\nb'],
    ['--focus-name', 'a\rb'],
    ['--focus-name', 'a\tb'],
    ['--focus-name', 'a\x07b'],
    ['--short-name', 'a\x07b'],
  ])('rejects %s %p with a usage error', async (flag, value) => {
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run([flag, value])).resolves.toBe(1);
    const stderr = stderrText(errOut);
    // Must be a name-validation error, not "unknown option" (proves the
    // --*-name flag is registered). "unknown option '--focus-name'" would
    // spuriously match /name/i via the flag spelling.
    expect(stderr).not.toMatch(/unknown option/i);
    expect(stderr).toMatch(/name|empty|invalid/i);
  });

  it('rejects names longer than 40 chars', async () => {
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run(['--focus-name', 'x'.repeat(41)])).resolves.toBe(1);
    const stderr = stderrText(errOut);
    expect(stderr).not.toMatch(/unknown option/i);
    expect(stderr).toMatch(/name|empty|invalid|40/i);
  });

  it('allows emoji and spaces in names', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '5m',
      '--focus-name',
      'Deep work 🍅',
      '--short-name',
      'Coffee break',
      '--quiet',
    ]);
    await advance(0);
    expect(stdoutText(out)).toContain('Deep work 🍅');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('quiet pause/resume lines include the custom name', async () => {
    vi.useFakeTimers();
    const screen = captureScreenListener();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '60s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--focus-name',
      'Deep work',
      '--quiet',
    ]);
    await advance(0);
    const listener = screen.get();
    expect(listener).toBeDefined();
    listener?.('locked');
    await advance(0);
    expect(stdoutText(out)).toMatch(/Paused Deep work — screen locked, timer frozen/);
    listener?.('active');
    await advance(0);
    expect(stdoutText(out)).toMatch(/Resumed Deep work — .* remaining/);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('live paused line keeps the name via the phase line', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const screen = captureScreenListener();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '60s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--focus-name',
      'Deep work',
    ]);
    await advance(500);
    screen.get()?.('locked');
    await advance(300);
    expect(stdoutText(out)).toMatch(/Deep work.*\(paused — screen locked\)/);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('exposes phaseLabel/buildPhaseLine helpers for future monitors (cli or display module)', async () => {
    const cliMod = (await import('../src/cli.js')) as Record<string, unknown>;
    let phaseLabel: unknown = cliMod.phaseLabel;
    let buildPhaseLine: unknown = cliMod.buildPhaseLine;
    if (phaseLabel === undefined || buildPhaseLine === undefined) {
      // Spec allows helpers to live in a tiny src/display.ts instead of cli.ts.
      // Use a dynamic (non-literal) import so typecheck passes when display.ts
      // does not exist yet; a failed import falls through to the failure below.
      try {
        const displayPath = `../src/display.js`;
        const displayMod = (await import(displayPath)) as Record<string, unknown>;
        phaseLabel ??= displayMod.phaseLabel;
        buildPhaseLine ??= displayMod.buildPhaseLine;
      } catch {
        // display.ts does not exist yet — fall through to the failure below.
      }
    }
    expect(typeof phaseLabel, 'expected phaseLabel helper to be exported').toBe('function');
    expect(typeof buildPhaseLine, 'expected buildPhaseLine helper to be exported').toBe('function');
  });

  it('timer.ts stays pure (no node: imports) after the naming refactor', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../src/timer.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"]node:/);
  });
});
