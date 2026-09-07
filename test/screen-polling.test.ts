/**
 * docs/005-screen-lock-macos.md — step 1: PollingMonitor (green).
 *
 * Covers the `src/screen.ts` unit contract only (no driver change, low risk
 * per 005 Implementation order step 1), following test/notify.test.ts
 * patterns: stub exec fns, `vi.useFakeTimers`, spy `stderr.write` — never a
 * real `ioreg` spawn.
 *
 * Proposed API under test (per 005 Architecture + Decisions D1–D8):
 * - `POLL_MS = 2000`
 * - `ScreenMonitor` gains `probeNow(): Promise<ScreenState>`; sync
 *   `getInitialState()` stays last-known-default-active (D5).
 * - `NoopMonitor.probeNow()` resolves `'active'`.
 * - `PollingMonitor implements ScreenMonitor`: constructor takes an
 *   injectable probe exec `(file, args) => Promise<{ stdout, stderr }>`
 *   plus `{ pollMs = 2000 }`; works with fake timers; default exec is
 *   promisified `node:child_process.execFile` with argv `['-n', 'Root', '-d1']`
 *   (never a shell string). `subscribe` starts the interval (first poll
 *   corrects assumed-active within one `pollMs`); `unsubscribe` clears it,
 *   idempotent. Probe failure → `'active'` + one stderr note until the next
 *   success (note-once, reset on success).
 * - V1 signal (whitespace-tolerant): locked = `"IOConsoleLocked"\s*=\s*Yes`
 *   OR `CGSSessionScreenIsLocked"\s*=\s*Yes` when present; anything else →
 *   active (D2). `kCGSSessionOnConsoleKey` alone must NOT read as locked.
 * - `createScreenMonitor(opts?: { platform?, enabled? } = {})`:
 *   `enabled === false` → `NoopMonitor`; else `darwin` → `PollingMonitor`,
 *   anything else → `NoopMonitor` (defaults `process.platform` / `true`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createScreenMonitor,
  NoopMonitor,
  POLL_MS,
  PollingMonitor,
  type ScreenState,
} from '../src/screen.js';

// ---------------------------------------------------------------------------
// fixtures (per 005 Ground truth, Sequoia): top level pads with spaces
// (`"key" = Yes`), array entries don't (`"key"=Yes`) — regexes must be
// whitespace-tolerant. `kCGSSessionOnConsoleKey` stays Yes while locked.
// ---------------------------------------------------------------------------

type ProbeExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const UNLOCKED = `+-o Root  <class IORegistryEntry>
    "IOConsoleLocked" = No
`;

const LOCKED = `+-o Root  <class IORegistryEntry>
    "IOConsoleLocked" = Yes
`;

const LOCKED_NOSPACE = `"IOConsoleLocked"=Yes`;

const DEFENSIVE = `"CGSSessionScreenIsLocked"=Yes`;

const DEFENSIVE_SPACED = `"CGSSessionScreenIsLocked" = Yes`;

const CONSOLE_KEY_ONLY = `"kCGSSessionOnConsoleKey" = Yes`;

function stubExec(stdout: string): ProbeExec {
  return async (_file: string, _args: readonly string[]) => ({ stdout, stderr: '' });
}

function failingExec(err = new Error('spawn ioreg ENOENT')): ProbeExec {
  return async (_file: string, _args: readonly string[]) => {
    throw err;
  };
}

function mutableExec(initial: string): ProbeExec & { set: (s: string) => void } {
  let current = initial;
  const fn = (async (_file: string, _args: readonly string[]) => ({
    stdout: current,
    stderr: '',
  })) as ProbeExec & { set: (s: string) => void };
  fn.set = (s: string): void => {
    current = s;
  };
  return fn;
}

function stderrText(spy: { mock: { calls: readonly unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.map((arg) => String(arg)).join(' ')).join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('005 — POLL_MS (D4)', () => {
  it('polls every 2000ms', () => {
    expect(POLL_MS).toBe(2000);
  });
});

describe('005 — NoopMonitor.probeNow (D5)', () => {
  it("resolves 'active' without waiting", async () => {
    const monitor = new NoopMonitor();
    await expect(monitor.probeNow()).resolves.toBe('active');
  });

  it('keeps the sync last-known-default-active contract', () => {
    expect(new NoopMonitor().getInitialState()).toBe('active');
  });
});

describe('005 — V1 parsing (Behavior + D2)', () => {
  it.each<[string, string, ScreenState]>([
    ['top-level spaced `= Yes` → locked', LOCKED, 'locked'],
    ['unspaced `"key"=Yes` → locked (array-entry form)', LOCKED_NOSPACE, 'locked'],
    ['defensive `CGSSessionScreenIsLocked=Yes` → locked', DEFENSIVE, 'locked'],
    ['defensive spaced form → locked', DEFENSIVE_SPACED, 'locked'],
    ['`= No` → active', UNLOCKED, 'active'],
    ['missing keys → active (absent = unlocked, never an error)', '', 'active'],
    [
      '`kCGSSessionOnConsoleKey = Yes` alone → active (console ownership, not lock)',
      CONSOLE_KEY_ONLY,
      'active',
    ],
  ])('%s', async (_label, stdout, expected) => {
    const monitor = new PollingMonitor(stubExec(stdout));
    await expect(monitor.probeNow()).resolves.toBe(expected);
  });

  it('calls the probe with an ioreg argv array (execFile-only, never a shell string)', async () => {
    const calls: [string, readonly string[]][] = [];
    const exec: ProbeExec = async (file, args) => {
      calls.push([file, args]);
      return { stdout: UNLOCKED, stderr: '' };
    };
    const monitor = new PollingMonitor(exec);
    await expect(monitor.probeNow()).resolves.toBe('active');
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toMatch(/ioreg/);
    expect([...(calls[0]?.[1] ?? [])]).toEqual(['-n', 'Root', '-d1']);
  });
});

describe('005 — PollingMonitor subscribe / diff-then-fire (Behavior)', () => {
  it('assumes active initially, corrects to locked on the first poll within one pollMs', async () => {
    vi.useFakeTimers();
    try {
      const monitor = new PollingMonitor(stubExec(LOCKED));
      expect(monitor.getInitialState()).toBe('active');
      const listener = vi.fn((_state: ScreenState) => undefined);
      monitor.subscribe(listener);
      expect(listener).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('locked');
      expect(monitor.getInitialState()).toBe('locked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires only on change: locked→locked silent, flapping yields exactly the transitions', async () => {
    vi.useFakeTimers();
    try {
      const exec = mutableExec(LOCKED);
      const monitor = new PollingMonitor(exec);
      const listener = vi.fn((_state: ScreenState) => undefined);
      monitor.subscribe(listener);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(listener).toHaveBeenCalledTimes(1);
      exec.set(UNLOCKED);
      await vi.advanceTimersByTimeAsync(2000);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith('active');
      exec.set(LOCKED);
      await vi.advanceTimersByTimeAsync(2000);
      expect(listener).toHaveBeenCalledTimes(3);
      expect(listener).toHaveBeenLastCalledWith('locked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a custom pollMs', async () => {
    vi.useFakeTimers();
    try {
      const monitor = new PollingMonitor(stubExec(LOCKED), { pollMs: 100 });
      const listener = vi.fn((_state: ScreenState) => undefined);
      monitor.subscribe(listener);
      await vi.advanceTimersByTimeAsync(100);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribe clears the interval (timer spy) and is idempotent', async () => {
    vi.useFakeTimers();
    try {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      const monitor = new PollingMonitor(stubExec(LOCKED));
      const listener = vi.fn((_state: ScreenState) => undefined);
      const unsubscribe = monitor.subscribe(listener);
      await vi.advanceTimersByTimeAsync(2000);
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
      expect(clearSpy).toHaveBeenCalled();
      expect(() => unsubscribe()).not.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('multiple subscribers each get the transitions', async () => {
    vi.useFakeTimers();
    try {
      const monitor = new PollingMonitor(stubExec(LOCKED));
      const a = vi.fn((_state: ScreenState) => undefined);
      const b = vi.fn((_state: ScreenState) => undefined);
      const unsubA = monitor.subscribe(a);
      const unsubB = monitor.subscribe(b);
      await vi.advanceTimersByTimeAsync(2000);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      unsubA();
      unsubB();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('005 — PollingMonitor fail-open + note-once (D3)', () => {
  it('exec rejection → active + exactly one stderr note across many ticks', async () => {
    vi.useFakeTimers();
    try {
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const monitor = new PollingMonitor(failingExec());
      const listener = vi.fn((_state: ScreenState) => undefined);
      monitor.subscribe(listener);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listener).not.toHaveBeenCalled();
      expect(monitor.getInitialState()).toBe('active');
      await expect(monitor.probeNow()).resolves.toBe('active');
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('garbage stdout → active + exactly one stderr note across many ticks', async () => {
    vi.useFakeTimers();
    try {
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const monitor = new PollingMonitor(stubExec('not ioreg output at all'));
      const listener = vi.fn((_state: ScreenState) => undefined);
      monitor.subscribe(listener);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listener).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('note flag resets after a success (next failure notes again)', async () => {
    vi.useFakeTimers();
    try {
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      let fail = true;
      const exec: ProbeExec = async () => {
        if (fail) throw new Error('boom');
        return { stdout: UNLOCKED, stderr: '' };
      };
      const monitor = new PollingMonitor(exec);
      monitor.subscribe(vi.fn((_state: ScreenState) => undefined));
      await vi.advanceTimersByTimeAsync(4000);
      expect(errSpy).toHaveBeenCalledTimes(1);
      fail = false;
      await vi.advanceTimersByTimeAsync(2000);
      fail = true;
      await vi.advanceTimersByTimeAsync(2000);
      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(stderrText(errSpy)).toMatch(/ioreg|screen|lock/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('005 — PollingMonitor.probeNow (D5)', () => {
  it('resolves current state without waiting for the interval', async () => {
    const locked = new PollingMonitor(stubExec(LOCKED));
    await expect(locked.probeNow()).resolves.toBe('locked');
    const active = new PollingMonitor(stubExec(UNLOCKED));
    await expect(active.probeNow()).resolves.toBe('active');
  });

  it('constructs with no args (default exec) without spawning until probed', () => {
    expect(() => new PollingMonitor()).not.toThrow();
    expect(new PollingMonitor().getInitialState()).toBe('active');
  });
});

describe('005 — createScreenMonitor factory', () => {
  it('darwin → PollingMonitor', () => {
    expect(createScreenMonitor({ platform: 'darwin' })).toBeInstanceOf(PollingMonitor);
  });

  it.each(['linux', 'win32'])('%s → NoopMonitor', (platform) => {
    expect(createScreenMonitor({ platform })).toBeInstanceOf(NoopMonitor);
  });

  it('enabled === false → NoopMonitor even on darwin (the --no-screen-pause path)', () => {
    expect(createScreenMonitor({ platform: 'darwin', enabled: false })).toBeInstanceOf(NoopMonitor);
    expect(createScreenMonitor({ enabled: false })).toBeInstanceOf(NoopMonitor);
  });

  it('defaults to process.platform / true', () => {
    const monitor = createScreenMonitor();
    if (process.platform === 'darwin') {
      expect(monitor).toBeInstanceOf(PollingMonitor);
    } else {
      expect(monitor).toBeInstanceOf(NoopMonitor);
    }
  });
});
