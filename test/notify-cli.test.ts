/**
 * TDD red phase for docs/004-desktop-notifications-macos.md — step 2: driver wiring.
 *
 * Covers the `src/cli.ts` observable contract only (via `run(argv)`),
 * following test/confirm.test.ts patterns: `vi.useFakeTimers`, spy
 * `stdout.write`, `defineProperty(process.stdin/stdout, 'isTTY')`, stub
 * `process.platform`, mock `node:child_process.execFile` (never spawn the
 * real `terminal-notifier` binary, never block on real stdin).
 *
 * All tests are expected to FAIL until 004 step 2 lands in the driver:
 * `--notify` / `--notify-confirm` are unknown options today (exit 1
 * "unknown option"), so help/guards/flow assertions below all miss.
 *
 * Step 1 (src/notify.ts unit contract + phaseDurationMs) is already green;
 * this file mocks the binary boundary (`execFile`) so the real notify module
 * (argv building, mapping table) is exercised end-to-end through the driver:
 * - `-version` probe → availability guard.
 * - plain delivery calls → `--notify` fire-and-forget sends.
 * - `-action` calls → `--notify-confirm` blocking prompts (queued answers).
 */
import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';

// ESM module namespaces are not spy-able: stub `node:child_process` so no
// test ever spawns the real `terminal-notifier` binary. Per-test helpers
// below set the mock behavior (available / missing / manual answers).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, execFile: vi.fn() };
});

function mockedExecFile(): ReturnType<typeof vi.fn> {
  return vi.mocked(childProcess.execFile);
}

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
const originalStdinIsTTY: boolean | undefined = (process.stdin as { isTTY?: boolean }).isTTY;
const originalPlatform = process.platform;

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

function setPlatform(value: typeof process.platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: false,
    enumerable: true,
  });
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

type ExecCallback = (
  err: (Error & { code?: unknown }) | null,
  stdout?: string,
  stderr?: string,
) => void;

function callbackOf(args: readonly unknown[]): ExecCallback {
  const found = [...args].reverse().find((a) => typeof a === 'function');
  if (found === undefined) throw new Error('execFile called without a callback');
  return found as ExecCallback;
}

function enoent(): Error & { code: unknown } {
  return Object.assign(new Error('spawn terminal-notifier ENOENT'), { code: 'ENOENT' });
}

/** Binary present: `-version` ok, deliveries ok, `-action` answers from queue. */
function mockBinaryAvailable(answers: (string | Error)[] = []): { deliveries: string[][] } {
  const deliveries: string[][] = [];
  const queue = [...answers];
  mockedExecFile().mockImplementation((...callArgs: unknown[]) => {
    const [file, rawArgs, ...rest] = callArgs as [unknown, string[], ...unknown[]];
    void file;
    const argv = [...rawArgs];
    const cb = callbackOf(rest);
    if (argv.includes('-version')) {
      queueMicrotask(() => cb(null, '3.1.0', ''));
      return {};
    }
    if (argv.includes('-action')) {
      const next = queue.length > 0 ? queue.shift()! : '@ACTIONCLICKED';
      if (next instanceof Error) queueMicrotask(() => cb(next));
      else queueMicrotask(() => cb(null, next, ''));
      return {};
    }
    deliveries.push(argv);
    queueMicrotask(() => cb(null, '', ''));
    return {};
  });
  return { deliveries };
}

/** Binary missing: every call fails with ENOENT (startup probe included). */
function mockBinaryMissing(): void {
  mockedExecFile().mockImplementation((...callArgs: unknown[]) => {
    const cb = callbackOf(callArgs.slice(2));
    queueMicrotask(() => cb(enoent()));
    return {};
  });
}

/** Manual answers: test controls exactly when each pending `-action` resolves. */
function mockBinaryManual(): {
  deliveries: string[][];
  confirmArgvs: string[][];
  answerNext: (stdout: string) => void;
  failNext: (err: Error) => void;
  confirmCalls: () => number;
} {
  const deliveries: string[][] = [];
  const confirmArgvs: string[][] = [];
  const pending: ExecCallback[] = [];
  mockedExecFile().mockImplementation((...callArgs: unknown[]) => {
    const [file, rawArgs, ...rest] = callArgs as [unknown, string[], ...unknown[]];
    void file;
    const argv = [...rawArgs];
    const cb = callbackOf(rest);
    if (argv.includes('-version')) {
      queueMicrotask(() => cb(null, '3.1.0', ''));
      return {};
    }
    if (argv.includes('-action')) {
      confirmArgvs.push(argv);
      pending.push(cb);
      return {};
    }
    deliveries.push(argv);
    queueMicrotask(() => cb(null, '', ''));
    return {};
  });
  return {
    deliveries,
    confirmArgvs,
    answerNext: (stdout: string): void => {
      const cb = pending.shift();
      if (cb) cb(null, stdout, '');
    },
    failNext: (err: Error): void => {
      const cb = pending.shift();
      if (cb) cb(err);
    },
    confirmCalls: (): number => confirmArgvs.length,
  };
}

function confirmArgvs(): string[][] {
  return mockedExecFile().mock.calls.flatMap((call) => {
    const argv = call[1] as string[] | undefined;
    return argv?.includes('-action') === true ? [argv] : [];
  });
}

function allArgvs(): string[][] {
  return mockedExecFile().mock.calls.map((call) => call[1] as string[]);
}

// ---------------------------------------------------------------------------

describe('004 step 2 — flags and fail-fast guards', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
    mockedExecFile().mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setStdoutIsTTY(originalStdoutIsTTY);
    setStdinIsTTY(originalStdinIsTTY);
    setPlatform(originalPlatform);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('lists --notify and --notify-confirm in --help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    const help = stdoutText(out);
    expect(help).toContain('--notify');
    expect(help).toContain('--notify-confirm');
  });

  it.each([['--notify'], ['--notify-confirm']])(
    'non-darwin + %s fails fast with exit 1 (macOS guard, driver never starts)',
    async (flag) => {
      vi.useFakeTimers();
      setPlatform('linux');
      const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await expect(run(['--focus', '1s', '--quiet', flag])).resolves.toBe(1);
      const stderr = stderrText(errOut);
      expect(stderr).not.toMatch(/unknown option/i);
      expect(stderr).toMatch(/macOS|darwin/i);
      expect(stdoutText(out)).toBe('');
      expect(mockedExecFile()).not.toHaveBeenCalled();
    },
  );

  it.each([['--notify'], ['--notify-confirm']])(
    'missing binary + %s fails fast with exit 1 + brew hint',
    async (flag) => {
      vi.useFakeTimers();
      setPlatform('darwin');
      mockBinaryMissing();
      const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await expect(run(['--focus', '1s', '--quiet', flag])).resolves.toBe(1);
      const stderr = stderrText(errOut);
      expect(stderr).not.toMatch(/unknown option/i);
      expect(stderr).toMatch(/brew install terminal-notifier/i);
      expect(stdoutText(out)).toBe('');
    },
  );

  it.each([
    ['--confirm', '--notify-confirm'],
    ['--notify', '--notify-confirm'],
  ])('%s + %s together is a usage error (one source only, D1)', async (a, b) => {
    vi.useFakeTimers();
    setPlatform('darwin');
    mockBinaryAvailable();
    setStdinIsTTY(true);
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run(['--focus', '1s', '--quiet', a, b])).resolves.toBe(1);
    const stderr = stderrText(errOut);
    expect(stderr).not.toMatch(/unknown option/i);
    expect(stderr).toMatch(/notify-confirm/);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('--notify-confirm works with stdin.isTTY === false (003 guard is --confirm-only)', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    setStdinIsTTY(false);
    mockBinaryAvailable(['@ACTIONCLICKED']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '60s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--notify-confirm',
    ]);
    await advance(0);
    // Driver started instead of fail-fast: first phase line, no usage error.
    expect(stdoutText(out)).toContain('Focus 1/4');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toMatch(/Completed \d+/);
  });
});

describe('004 step 2 — --notify fire-and-forget (no gating change)', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
    mockedExecFile().mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setStdoutIsTTY(originalStdoutIsTTY);
    setStdinIsTTY(originalStdinIsTTY);
    setPlatform(originalPlatform);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('notifies on startup and on transition, keeping bell + phase line (quiet)', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    const { deliveries } = mockBinaryAvailable();
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
      '--notify',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    const text = stdoutText(out);
    // Backward compat: bell + phase lines intact.
    expect(text).toContain('\x07');
    expect(text).toContain('Focus 1/4');
    expect(text).toContain('Short break');
    // One delivery per entry: startup (Focus 1/4) + transition (Short break).
    const titles = deliveries.map((argv) => argv[argv.indexOf('-title') + 1]);
    expect(titles).toContain('Focus 1/4');
    expect(titles).toContain('Short break');
    // D8 through the driver: startup claims no spent time (remaining-only).
    const startup = deliveries.find((argv) => argv[argv.indexOf('-title') + 1] === 'Focus 1/4');
    expect(startup?.[startup.indexOf('-message') + 1]).toBe('0:01 remaining');
    const transition = deliveries.find(
      (argv) => argv[argv.indexOf('-title') + 1] === 'Short break',
    );
    expect(transition?.[transition.indexOf('-message') + 1]).toBe(
      '0:01 spent on Focus. Short break — 1:00 remaining',
    );
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('sends notifications in live mode too (not quiet-only)', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    // Live countdown needs a TTY: --quiet is automatic under pipes/CI.
    setStdoutIsTTY(true);
    const { deliveries } = mockBinaryAvailable();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '1s', '--short', '60s', '--long', '60s', '--notify']);
    await advance(0);
    await advance(1_200);
    await advance(0);
    expect(stdoutText(out)).toContain('Focus 1/4');
    expect(stdoutText(out)).toContain('Short break');
    const titles = deliveries.map((argv) => argv[argv.indexOf('-title') + 1]);
    expect(titles).toContain('Focus 1/4');
    expect(titles).toContain('Short break');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('delivery failure is non-fatal: stderr note, timer continues with bell+text', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    mockedExecFile().mockImplementation((...callArgs: unknown[]) => {
      const [, rawArgs, ...rest] = callArgs as [unknown, string[], ...unknown[]];
      const argv = [...rawArgs];
      const cb = callbackOf(rest);
      if (argv.includes('-version')) {
        queueMicrotask(() => cb(null, '3.1.0', ''));
        return {};
      }
      // No-GUI-session watchdog (exit 4): delivery fails, startup probe passed.
      queueMicrotask(() => cb(Object.assign(new Error('no GUI session'), { code: 4 })));
      return {};
    });
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--notify',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    // Missed toast never kills the pomodoro: transition still lands.
    expect(stdoutText(out)).toContain('Short break');
    expect(stdoutText(out)).toContain('\x07');
    expect(stderrText(errOut).length).toBeGreaterThan(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('removes the stale toast on exit (-remove screen-pomodoro, best-effort)', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    mockBinaryAvailable();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(['--focus', '60s', '--quiet', '--notify']);
    await advance(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    const removal = allArgvs().find((argv) => argv.includes('-remove'));
    expect(removal).toBeDefined();
    expect(removal).toContain('screen-pomodoro');
  });
});

describe('004 step 2 — --notify-confirm blocking gate', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
    mockedExecFile().mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setStdoutIsTTY(originalStdoutIsTTY);
    setStdinIsTTY(originalStdinIsTTY);
    setPlatform(originalPlatform);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('click (@ACTIONCLICKED) advances exactly one phase and counts the focus', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    setStdinIsTTY(false);
    mockBinaryAvailable(['@ACTIONCLICKED']);
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
      '--notify-confirm',
    ]);
    await advance(0);
    expect(stdoutText(out)).toContain('Focus 1/4');
    await advance(1_200);
    await advance(0);
    expect(stdoutText(out)).toContain('Short break');
    // Single pre-prompt bell (stdin parity) alongside -sound Bottle.
    expect(countBells(stdoutText(out))).toBe(1);
    // Blocking prompt carried -action No with the D6 click-mapping copy.
    const prompted = confirmArgvs()[0] ?? [];
    expect(prompted).toContain('-action');
    expect(prompted).toContain('No');
    expect(prompted[prompted.indexOf('-title') + 1]).toBe('Focus complete');
    expect(prompted[prompted.indexOf('-message') + 1]).toBe(
      '0:01 spent. Start Short break — 1:00? Click = yes, No = restart',
    );
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toMatch(/Completed 1 focuses/);
  });

  it('No restarts the same phase with a full deadline and unchanged count', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    setStdinIsTTY(false);
    // Queue two explicit Nos: the second prompt must also restart (count stays
    // 0) instead of falling through to the helper's default '@ACTIONCLICKED'.
    mockBinaryAvailable(['No', 'No']);
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
      '--notify-confirm',
    ]);
    await advance(0);
    await advance(2_200);
    await advance(0);
    expect(confirmArgvs()).toHaveLength(1);
    expect(stdoutText(out)).toContain('Focus 1/4');
    // Less than a full duration later: deadline was reset, no second prompt.
    await advance(1_000);
    await advance(0);
    expect(confirmArgvs()).toHaveLength(1);
    // After the full restarted duration: prompts again.
    await advance(1_200);
    await advance(0);
    expect(confirmArgvs()).toHaveLength(2);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toMatch(/Completed 0 focuses/);
  });

  it('suspends timers while the toast is pending (no re-arm, no extra prompts)', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    setStdinIsTTY(false);
    const manual = mockBinaryManual();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '1s',
      '--long',
      '60s',
      '--quiet',
      '--notify-confirm',
    ]);
    await advance(0);
    await advance(1_200);
    expect(manual.confirmCalls()).toBe(1);
    const writesWhilePending = out.mock.calls.length;
    await advance(5_000);
    expect(manual.confirmCalls()).toBe(1);
    expect(out.mock.calls.length).toBe(writesWhilePending);
    manual.answerNext('@ACTIONCLICKED');
    await advance(0);
    expect(stdoutText(out)).toContain('Short break');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
  });

  it('SIGINT while pending settles: summary + exit 0, late answer never lands', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    setStdinIsTTY(false);
    const manual = mockBinaryManual();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--notify-confirm',
    ]);
    await advance(0);
    await advance(1_200);
    expect(manual.confirmCalls()).toBe(1);
    // Green must also kill the pending terminal-notifier child so no orphan
    // blocks on a dead prompt; observably the driver must settle regardless.
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toMatch(/Completed \d+ focuses/);
    // A click arriving after Ctrl-C loses: no post-exit transition.
    manual.answerNext('@ACTIONCLICKED');
    await advance(0);
    expect(stdoutText(out)).not.toContain('Short break');
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });
});
