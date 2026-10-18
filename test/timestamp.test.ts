import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';

function stdoutText(spy: { mock: { calls: readonly unknown[][] } }): string {
  return spy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : String(call[0])))
    .join('');
}

const TIMESTAMP_RE = /\[\d{2}:\d{2}:\d{2}\] /;

const originalStdoutIsTTY = (process.stdout as { isTTY?: unknown }).isTTY;

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

describe('--timestamp', () => {
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
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('quiet startup line is prefixed with [HH:MM:SS]', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '5m', '--quiet', '--timestamp']);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stdoutText(out)).toMatch(TIMESTAMP_RE);
      expect(stdoutText(out)).toContain('Focus 1/4');
    } finally {
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
    }
  });

  it('quiet phase change keeps the bell first, then the timestamp', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--timestamp',
    ]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_200);
      const text = stdoutText(out);
      expect(text).toContain('\x07');
      expect(text).toContain('Short break');
      // Bell rings first, then the timestamped line (string ops: \x07 in a
      // regex literal trips no-control-regex).
      const chunks = out.mock.calls.map((call) => String(call[0]));
      expect(chunks.some((c) => c.startsWith('\x07[') && c.includes('Short break'))).toBe(true);
      expect(text).toMatch(/\[\d{2}:\d{2}:\d{2}\] Short break/);
    } finally {
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
    }
  });

  it('SIGINT summary carries the timestamp', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--quiet', '--timestamp']);
    try {
      await vi.advanceTimersByTimeAsync(0);
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
      expect(stdoutText(out)).toMatch(/\[\d{2}:\d{2}:\d{2}\] Completed \d+ focuses/);
    } finally {
      if (process.listenerCount('SIGINT') > sigintBaseline) process.emit('SIGINT');
      await runPromise.catch(() => undefined);
    }
  });

  it('live countdown ticks stay unstamped; history commits carry the timestamp', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--timestamp']);
    try {
      await vi.advanceTimersByTimeAsync(500);
      const chunks = out.mock.calls.map((call) => String(call[0]));
      const commit = chunks.find((c) => c.endsWith('\n'));
      expect(commit?.startsWith('\r\x1b[K[')).toBe(true);
      expect(commit ?? '').toMatch(/\[\d{2}:\d{2}:\d{2}\] Focus 1\/4/);
      // Ephemeral `\r` ticks carry only the countdown: wall-clock seconds
      // and remaining seconds flip on different boundaries, so stamping
      // them shows two clocks ticking out of phase.
      const renders = chunks.filter((c) => c.startsWith('\r') && !c.includes('\n'));
      expect(renders.length).toBeGreaterThan(0);
      for (const r of renders) {
        expect(r).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
        expect(r.endsWith('\x1b[K')).toBe(true);
      }
    } finally {
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
    }
  });
});
