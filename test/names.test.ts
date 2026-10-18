/**
 * Phase names (--focus-name / --short-name / --long-name).
 *
 * Covers the observable CLI contract only (via `run(argv)`), following
 * test/cli.test.ts patterns: `vi.useFakeTimers`, spy `stdout.write`,
 * `defineProperty(process.stdout, 'isTTY')`, assert SIGINT cleanup.
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

/** Capture the screen-monitor listener so tests can fire locked/active. */
function captureScreenListener(): { get: () => ((s: 'active' | 'locked') => void) | undefined } {
  let captured: ((s: 'active' | 'locked') => void) | undefined;
  const capture = (listener: (s: 'active' | 'locked') => void): (() => void) => {
    captured = listener;
    return () => undefined;
  };
  // Driver uses PollingMonitor on darwin, NoopMonitor elsewhere/
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

describe('phase names', () => {
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
    ['--short-name', '   '],
    ['--long-name', 'a\nb'],
    ['--focus-name', 'a\x07b'],
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
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });
});
