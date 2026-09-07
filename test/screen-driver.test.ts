/**
 * docs/005-screen-lock-macos.md — step 2: driver wiring (green).
 *
 * Covers the `src/cli.ts` observable contract via `run(argv)`, following
 * test/confirm.test.ts patterns: `vi.useFakeTimers`, spy `stdout.write`,
 * `defineProperty(process.stdout, 'isTTY')` — never a real `ioreg` spawn,
 * never real stdin.
 *
 * Driver contract under test (per 005 Architecture + D1–D8):
 * - `--no-screen-pause` opt-out flag (default: pause on).
 * - Factory wiring: default arms the 2000ms poll on darwin (PollingMonitor),
 *   opt-out stays fully idle (NoopMonitor, zero wakeups).
 * - Lock/unlock reuses the existing pause/resume copy (no new strings, no bell).
 * - Wake-jump guard: `JUMP_THRESHOLD_MS = 5000`, `probeNow()` before `tick()`
 *   on drift, lock-freeze before cascade (both live + quiet paths).
 * - `run(argv, { monitor })` injection keeps CLI tests hermetic on darwin
 *   (stub monitor, never real `ioreg`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import type { ScreenMonitor, ScreenState } from '../src/screen.js';

// ---------------------------------------------------------------------------
// helpers (mirrors test/cli.test.ts + test/confirm.test.ts)
// ---------------------------------------------------------------------------

function stdoutText(spy: { mock: { calls: readonly unknown[][] } }): string {
  return spy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : String(call[0])))
    .join('');
}

function stderrText(spy: { mock: { calls: readonly unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.map((arg) => String(arg)).join(' ')).join('\n');
}

function countBells(text: string): number {
  return text.split('\x07').length - 1;
}

const originalStdoutIsTTY: boolean | undefined = (process.stdout as { isTTY?: boolean }).isTTY;

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

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/**
 * Hermetic stub monitor per 005 ("injected stub monitor, never real ioreg").
 * No real timers, no spawns: `fire()` drives subscription transitions
 * synchronously, `probeNow()` resolves `probeState` for the wake-jump guard.
 */
class StubMonitor implements ScreenMonitor {
  private readonly listeners = new Set<(s: ScreenState) => void>();
  private lastKnown: ScreenState = 'active';
  probeState: ScreenState = 'active';
  probeCalls = 0;

  constructor(initial: ScreenState = 'active') {
    this.lastKnown = initial;
    this.probeState = initial;
  }

  subscribe(listener: (s: ScreenState) => void): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  getInitialState(): ScreenState {
    return this.lastKnown;
  }

  async probeNow(): Promise<ScreenState> {
    this.probeCalls += 1;
    this.lastKnown = this.probeState;
    return this.probeState;
  }

  fire(state: ScreenState): void {
    this.lastKnown = state;
    for (const listener of [...this.listeners]) {
      listener(state);
    }
  }
}

function pollIntervals(setIntervalSpy: { mock: { calls: readonly unknown[][] } }): number[] {
  return setIntervalSpy.mock.calls
    .map((call) => call[1])
    .filter((ms): ms is number => typeof ms === 'number');
}

/**
 * Always settle the driver so a failing primary assertion never leaks a
 * SIGINT handler into the next test's baseline.
 */
async function settle(runPromise: Promise<number>): Promise<void> {
  process.emit('SIGINT');
  try {
    await runPromise;
  } catch {
    // run() resolves exit codes; ignore settlement errors here.
  }
}

// ---------------------------------------------------------------------------

describe('005 step 2 — --no-screen-pause flag', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setStdoutIsTTY(originalStdoutIsTTY);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('lists --no-screen-pause in --help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    expect(stdoutText(out)).toContain('--no-screen-pause');
  });

  it('--no-screen-pause is a known flag (not "unknown option")', async () => {
    vi.useFakeTimers();
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--quiet', '--no-screen-pause']);
    try {
      await advance(0);
      // Known flag → driver starts (no usage error); SIGINT settles exit 0.
      expect(stderrText(errOut)).not.toMatch(/unknown option/i);
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
    } finally {
      await settle(runPromise);
    }
  });
});

describe('005 step 2 — factory wiring: default polls, opt-out stays idle', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setStdoutIsTTY(originalStdoutIsTTY);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('default (flag absent) arms the 2000ms screen poll in quiet mode', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s', '--quiet']);
    try {
      await advance(0);
      // PollingMonitor.subscribe starts the interval; NoopMonitor never does.
      expect(pollIntervals(setIntervalSpy)).toContain(2000);
    } finally {
      await settle(runPromise);
    }
  });

  it('default (flag absent) arms the 2000ms screen poll in live mode', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s']);
    try {
      await advance(0);
      // Live tick (250ms) + screen poll (2000ms) both armed.
      expect(pollIntervals(setIntervalSpy)).toContain(250);
      expect(pollIntervals(setIntervalSpy)).toContain(2000);
    } finally {
      await settle(runPromise);
    }
  });

  it('--no-screen-pause with a stub reporting locked → timer never pauses, no poll armed', async () => {
    vi.useFakeTimers();
    const stub = new StubMonitor('active');
    stub.probeState = 'locked';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const runPromise = run(
      ['--focus', '60s', '--short', '60s', '--long', '60s', '--quiet', '--no-screen-pause'],
      // Injected stub would report locked, but opt-out ignores lock events
      // entirely (no freeze) and never probes.
      { monitor: stub },
    );
    try {
      await advance(0);
      // Even a locked report must not freeze the countdown when opted out.
      stub.fire('locked');
      await advance(1_000);
      const text = stdoutText(out);
      expect(text).not.toMatch(/Paused .* — screen locked, timer frozen/);
      expect(text).not.toMatch(/\(paused — screen locked\)/);
      // Opt-out never probes and arms no poll interval: fully idle.
      expect(stub.probeCalls).toBe(0);
      expect(pollIntervals(setIntervalSpy)).not.toContain(2000);
    } finally {
      await settle(runPromise);
    }
  });
});

describe('005 step 2 — lock mid-focus pauses, unlock resumes (existing copy)', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setStdoutIsTTY(originalStdoutIsTTY);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('quiet: lock freezes the clock (Paused … timer frozen), unlock resumes with remaining', async () => {
    vi.useFakeTimers();
    const stub = new StubMonitor('active');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s', '--quiet'], {
      monitor: stub,
    });
    try {
      await advance(0);
      expect(stdoutText(out)).toContain('Focus 1/4');
      stub.fire('locked');
      await advance(0);
      expect(stdoutText(out)).toMatch(/Paused Focus — screen locked, timer frozen/);
      const frozen = stdoutText(out);
      // Frozen while locked: time passes, no new phase line, no bell.
      // Stub never polls spontaneously, so no real ioreg can resume us here.
      await advance(10_000);
      expect(stdoutText(out)).toBe(frozen);
      expect(countBells(stdoutText(out))).toBe(0);
      stub.fire('active');
      await advance(0);
      expect(stdoutText(out)).toMatch(/Resumed Focus — \d+:\d\d remaining/);
    } finally {
      await settle(runPromise);
    }
  });

  it('live: lock leaves history with no bell and no suffix, unlock re-renders the line', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const stub = new StubMonitor('active');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s'], {
      monitor: stub,
    });
    try {
      await advance(500);
      stub.fire('locked');
      await advance(0);
      // 006 tidy: history replaces the suffix (no ephemeral duplicate).
      expect(stdoutText(out)).not.toContain('(paused — screen locked)');
      expect(stdoutText(out)).toMatch(/Paused Focus — screen locked, timer frozen/);
      expect(countBells(stdoutText(out))).toBe(0);
      stub.fire('active');
      await advance(500);
      // Still in the same focus after a lock/unlock round-trip.
      expect(stdoutText(out)).toContain('Focus 1/4');
      expect(stdoutText(out)).toMatch(/Resumed Focus — \d+:\d\d remaining/);
      expect(countBells(stdoutText(out))).toBe(0);
    } finally {
      await settle(runPromise);
    }
  });

  it('live: ticks suspend while paused (idle, no redraw churn)', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const stub = new StubMonitor('active');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s'], {
      monitor: stub,
    });
    try {
      await advance(500);
      stub.fire('locked');
      await advance(0);
      const callsAfterLock = out.mock.calls.length;
      await advance(2000);
      // Only the 2000ms screen poll may fire; no 250ms countdown redraws.
      expect(out.mock.calls.length).toBe(callsAfterLock);
      stub.fire('active');
      await advance(500);
      expect(out.mock.calls.length).toBeGreaterThan(callsAfterLock);
    } finally {
      await settle(runPromise);
    }
  });

  it('live: no blank line between Paused and Resumed (pause leaves the cursor clean)', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const stub = new StubMonitor('active');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s'], {
      monitor: stub,
    });
    try {
      await advance(500);
      stub.fire('locked');
      await advance(0);
      stub.fire('active');
      await advance(0);
      const text = stdoutText(out);
      expect(text).toContain('Paused Focus — screen locked, timer frozen');
      expect(text).not.toMatch(/timer frozen\n\nResumed/);
    } finally {
      await settle(runPromise);
    }
  });

  it('live: startup leaves a full-duration history line (parity with later phases)', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const stub = new StubMonitor('active');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s'], {
      monitor: stub,
    });
    try {
      await advance(0);
      // First phase must log its birth (full 1:00), like every phase-change
      // entry does — otherwise scrollback shows only its 0:01 death fossil.
      // Commit framing: erase the live row first so no fossil scrolls.
      const first = String(out.mock.calls[0]?.[0]);
      expect(first).toBe('\r\x1b[KFocus 1/4 — 1:00 remaining\n');
    } finally {
      await settle(runPromise);
    }
  });

  it('live: every history row commits over the live row (one row per event)', async () => {
    // Ghostty paste showed a stale-tick fossil per event: each leading-`\n`
    // history write scrolled the live `\r` frame into scrollback. Commits
    // (`\r` + EL first) erase the frame before scrolling, so each event
    // leaves exactly one row. Pin per-chunk framing across startup, lock,
    // unlock, a phase change, and SIGINT summary.
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const stub = new StubMonitor('active');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '2s', '--short', '60s', '--long', '60s'], {
      monitor: stub,
    });
    try {
      await advance(500);
      stub.fire('locked');
      await advance(0);
      stub.fire('active');
      await advance(3000);
      process.emit('SIGINT');
      await runPromise;
      const chunks = out.mock.calls.map((call) => String(call[0]));
      expect(chunks.length).toBeGreaterThan(0);
      // String ops (not regex literals) — eslint no-control-regex.
      const isRender = (chunk: string): boolean =>
        chunk.startsWith('\r') && !chunk.includes('\n') && chunk.endsWith('\x1b[K');
      const isCommit = (chunk: string): boolean => {
        const rest = chunk.startsWith('\x07') ? chunk.slice(1) : chunk;
        return rest.startsWith('\r\x1b[K') && rest.endsWith('\n') && !rest.slice(1).includes('\r');
      };
      for (const chunk of chunks) {
        expect(isRender(chunk) || isCommit(chunk), `chunk: ${JSON.stringify(chunk)}`).toBe(true);
      }
      // Spot-check the commits themselves.
      expect(chunks.some((c) => c.startsWith('\r\x1b[KFocus 1/4 —'))).toBe(true);
      expect(chunks.some((c) => c.startsWith('\r\x1b[KPaused Focus'))).toBe(true);
      expect(chunks.some((c) => c.startsWith('\r\x1b[KResumed Focus'))).toBe(true);
      expect(chunks.some((c) => c.startsWith('\x07\r\x1b[KShort break'))).toBe(true);
    } finally {
      await settle(runPromise);
    }
  });

  it('quiet: no blank lines across a full run (dense ledger)', async () => {
    // Quiet never owns a `\r` row, so history writes must not carry live's
    // leading break — `\n…\n` after a `…\n` line prints a blank row.
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(
      ['--focus', '2s', '--short', '2s', '--long', '2s', '--cycles', '1', '--no-loop', '--quiet'],
      { monitor: new StubMonitor('active') },
    );
    try {
      // Drive the quiet timeout chain through focus + short + long (2s each).
      await advance(2500);
      await advance(2500);
      await advance(2500);
      await expect(runPromise).resolves.toBe(0);
      const text = stdoutText(out).replaceAll('\x07', '');
      expect(text).toContain('Completed 1 focuses');
      expect(text).not.toContain('\n\n');
    } finally {
      await settle(runPromise);
    }
  });

  it('quiet: SIGINT summary follows history with no blank line', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s', '--quiet'], {
      monitor: new StubMonitor('active'),
    });
    try {
      await advance(0);
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
      expect(stdoutText(out)).not.toContain('\n\n');
    } finally {
      await settle(runPromise);
    }
  });

  it('live: repeated locked fires history once (dedup holds)', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const stub = new StubMonitor('active');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s'], {
      monitor: stub,
    });
    try {
      await advance(500);
      stub.fire('locked');
      await advance(0);
      stub.fire('locked');
      await advance(0);
      const text = stdoutText(out);
      expect(text.match(/Paused Focus — screen locked, timer frozen/g)?.length ?? 0).toBe(1);
    } finally {
      await settle(runPromise);
    }
  });

  it('live: every in-place redraw clears to end of line (no ghost tail after resume)', async () => {
    // QA 2026-09-07: a shorter re-render over a longer row left a stale tail
    // with a bare `\r`. Pure renders (ticks, resume re-render — chunks with
    // no `\n`) must carry EL so shrunken rows (10:00→9:59) cannot ghost.
    // History commits (`\r` + EL + text + `\n`) are pinned by the framing
    // test above, not here.
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const stub = new StubMonitor('active');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s'], {
      monitor: stub,
    });
    try {
      await advance(500);
      stub.fire('locked');
      await advance(0);
      stub.fire('active');
      await advance(500);
      const redraws = out.mock.calls
        .map((call) => call[0])
        .filter(
          (chunk): chunk is string =>
            typeof chunk === 'string' && chunk.startsWith('\r') && !chunk.includes('\n'),
        );
      // Countdown ticks + resume render redraw in place (pause/resume
      // history are commits, pinned by the framing test above).
      expect(redraws.length).toBeGreaterThan(2);
      for (const redraw of redraws) {
        expect(redraw.endsWith('\x1b[K')).toBe(true);
      }
    } finally {
      await settle(runPromise);
    }
  });
});

describe('005 step 2 — wake-jump guard (D6: JUMP_THRESHOLD_MS = 5000)', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setStdoutIsTTY(originalStdoutIsTTY);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('exports JUMP_THRESHOLD_MS = 5000 from the driver', async () => {
    const mod = (await import('../src/cli.js')) as unknown as Record<string, unknown>;
    expect(mod.JUMP_THRESHOLD_MS).toBe(5000);
  });

  it('quiet: wall-clock jump >5s with probe locked → pause first, no tick cascade / bell burst', async () => {
    vi.useFakeTimers();
    const stub = new StubMonitor('active');
    stub.probeState = 'locked';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(
      ['--focus', '2s', '--short', '60s', '--long', '60s', '--cycles', '4', '--quiet'],
      { monitor: stub },
    );
    try {
      await advance(0);
      expect(stdoutText(out)).toContain('Focus 1/4');
      // Lid-close sleep freezes the process: timers don't fire while frozen,
      // Date.now() jumps on wake past the 2s deadline. Simulate by jumping
      // the mocked clock, then advancing past the 2s timeout so the overdue
      // fire sees drift (12s) > 5000 — the guard must probeNow() before
      // tick() and freeze instead of cascading into Short break.
      vi.setSystemTime(Date.now() + 10_000);
      await advance(2000);
      expect(stub.probeCalls).toBeGreaterThan(0);
      const text = stdoutText(out);
      expect(text).not.toContain('Short break');
      expect(countBells(text)).toBe(0);
      expect(text).toMatch(/Paused Focus — screen locked, timer frozen/);
    } finally {
      await settle(runPromise);
    }
  });

  it('live: wall-clock jump >5s with probe locked → pause first, no tick cascade / bell burst', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const stub = new StubMonitor('active');
    stub.probeState = 'locked';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '2s', '--short', '60s', '--long', '60s', '--cycles', '4'], {
      monitor: stub,
    });
    try {
      await advance(500);
      // Freeze then jump past the 2s deadline; the next live tick sees
      // drift (~10s) > 5000, so it must probe first and freeze instead of
      // cascading. Note: fake-timer setSystemTime jumps Date but timers
      // still need an advance to fire — the 250ms tick below runs overdue
      // with the jumped wall clock.
      vi.setSystemTime(Date.now() + 10_000);
      await advance(250);
      expect(stub.probeCalls).toBeGreaterThan(0);
      const text = stdoutText(out);
      expect(text).not.toContain('Short break');
      expect(countBells(text)).toBe(0);
      expect(text).toMatch(/Paused Focus — screen locked, timer frozen/);
      expect(text).not.toContain('(paused — screen locked)');
    } finally {
      await settle(runPromise);
    }
  });

  it('quiet SIGINT clears the poll interval (no orphaned 2000ms wakeups)', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const runPromise = run(['--focus', '60s', '--short', '60s', '--long', '60s', '--quiet']);
    try {
      await advance(0);
      // A 2000ms poll must exist to need clearing (fails pre-green: Noop).
      expect(pollIntervals(setIntervalSpy)).toContain(2000);
      const callsBefore = clearIntervalSpy.mock.calls.length;
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
      // finish() → unsubscribe() clears the PollingMonitor interval even in
      // quiet mode (where the driver itself only ever used clearTimeout).
      expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      await settle(runPromise);
    }
  });
});
