import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { formatTimestamp, withTimestamp } from '../src/display.js';
import type { ScreenMonitor, ScreenState } from '../src/screen.js';

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

class StubMonitor implements ScreenMonitor {
  private readonly listeners = new Set<(s: ScreenState) => void>();

  subscribe(listener: (s: ScreenState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getInitialState(): ScreenState {
    return 'active';
  }

  async probeNow(): Promise<ScreenState> {
    return 'active';
  }

  fire(state: ScreenState): void {
    for (const listener of [...this.listeners]) {
      listener(state);
    }
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

  it('lists --timestamp in --help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    expect(stdoutText(out)).toContain('--timestamp');
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

  it('off by default: quiet startup has no timestamp prefix', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '5m', '--quiet']);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stdoutText(out)).not.toMatch(TIMESTAMP_RE);
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

  it('quiet pause/resume lines carry the timestamp', async () => {
    vi.useFakeTimers();
    const stub = new StubMonitor();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(
      ['--focus', '60s', '--short', '60s', '--long', '60s', '--quiet', '--timestamp'],
      {
        monitor: stub,
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      stub.fire('locked');
      await vi.advanceTimersByTimeAsync(0);
      expect(stdoutText(out)).toMatch(/\[\d{2}:\d{2}:\d{2}\] Paused Focus — screen locked/);
      stub.fire('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(stdoutText(out)).toMatch(/\[\d{2}:\d{2}:\d{2}\] Resumed Focus — .* remaining/);
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

describe('display timestamp helpers', () => {
  it('formatTimestamp renders [HH:MM:SS] and withTimestamp prefixes', () => {
    expect(formatTimestamp(new Date(2026, 8, 7, 4, 5, 6).getTime())).toBe('[04:05:06]');
    expect(withTimestamp('Focus 1/4', new Date(2026, 8, 7, 14, 3, 4).getTime())).toBe(
      '[14:03:04] Focus 1/4',
    );
  });
});
