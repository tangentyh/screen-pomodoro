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
import type { ScreenMonitor, ScreenState } from '../src/screen.js';

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
      // Killable like the real child: SIGTERM surfaces as a spawn error so
      // the driver's unlock-resend and SIGINT kills stay observable here.
      return {
        kill: (): void => {
          const idx = pending.indexOf(cb);
          if (idx >= 0) {
            pending.splice(idx, 1);
            cb(
              Object.assign(new Error('Command failed: terminal-notifier'), { signal: 'SIGTERM' }),
            );
          }
        },
      };
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
    expect(help).toContain('--notify-group');
  });

  it('--notify-group without --notify/--notify-confirm is a usage error', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    mockBinaryAvailable();
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run(['--focus', '1s', '--quiet', '--notify-group', 'work'])).resolves.toBe(1);
    expect(stderrText(errOut)).toMatch(/notify-group.*notify|notify.*notify-group/i);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it.each([
    ['--notify-group', ''],
    ['--notify-group', '   '],
    ['--notify-group', 'x'.repeat(65)],
  ])('rejects %s %p with a usage error', async (flag, value) => {
    vi.useFakeTimers();
    setPlatform('darwin');
    mockBinaryAvailable();
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run(['--focus', '1s', '--quiet', '--notify', flag, value])).resolves.toBe(1);
    const stderr = stderrText(errOut);
    expect(stderr).not.toMatch(/unknown option/i);
    expect(stderr).toMatch(/group|empty|invalid/i);
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

  it('custom --notify-group isolates deliveries and exit removal', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    const { deliveries } = mockBinaryAvailable();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--notify',
      '--notify-group',
      'work',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    expect(deliveries.length).toBeGreaterThan(0);
    for (const argv of deliveries) {
      expect(argv[argv.indexOf('-group') + 1]).toBe('work');
    }
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    const removal = allArgvs().find((argv) => argv.includes('-remove'));
    expect(removal).toBeDefined();
    expect(removal).toContain('work');
    expect(removal).not.toContain('screen-pomodoro');
  });

  it('custom --notify-group carries into the --notify-confirm prompt', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    setStdinIsTTY(false);
    mockBinaryAvailable(['@ACTIONCLICKED']);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '1s',
      '--short',
      '60s',
      '--long',
      '60s',
      '--quiet',
      '--notify-confirm',
      '--notify-group',
      'stretch',
      // 009: pin --start focus so the startup toast menu is skipped.
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    const prompted = confirmArgvs()[0] ?? [];
    expect(prompted[prompted.indexOf('-group') + 1]).toBe('stretch');
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
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
      // 009: pin --start focus so the startup toast menu is skipped.
      '--start',
      'focus',
    ]);
    await advance(0);
    expect(stdoutText(out)).toContain('Focus 1/4');
    await advance(1_200);
    await advance(0);
    expect(stdoutText(out)).toContain('Short break');
    // Single pre-prompt bell (stdin parity) alongside -sound Bottle.
    expect(countBells(stdoutText(out))).toBe(1);
    // Blocking prompt carries -action Restart with the 011 click-mapping copy.
    const prompted = confirmArgvs()[0] ?? [];
    expect(prompted).toContain('-action');
    expect(prompted).toContain('Restart Focus');
    expect(prompted[prompted.indexOf('-title') + 1]).toBe('Focus complete. Start Short break?');
    expect(prompted[prompted.indexOf('-message') + 1]).toBe(
      '0:01 spent. Click for Short break — 1:00, Restart Focus to redo.',
    );
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(stdoutText(out)).toMatch(/Completed 1 focuses/);
  });

  it('Restart restarts the same phase with a full deadline and unchanged count', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    setStdinIsTTY(false);
    // Queue two explicit restarts: the second prompt must also restart (count stays
    // 0) instead of falling through to the helper's default '@ACTIONCLICKED'.
    mockBinaryAvailable(['Restart Focus', 'Restart Focus']);
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
      // 009: pin --start focus so the startup toast menu is skipped.
      '--start',
      'focus',
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
      // 009: pin --start focus so the startup toast menu is skipped.
      '--start',
      'focus',
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
      // 009: pin --start focus so the startup toast menu is skipped.
      '--start',
      'focus',
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

  it('--no-loop exits after the long break without a trailing toast prompt', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    setStdinIsTTY(false);
    mockBinaryAvailable(['@ACTIONCLICKED']);
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
      '--notify-confirm',
      // 009: pin --start focus so the startup toast menu is skipped.
      '--start',
      'focus',
    ]);
    await advance(0);
    await advance(1_200);
    await advance(0);
    // focus -> long took one click; the terminal long break exits directly.
    await advance(1_500);
    await advance(0);
    await expect(runPromise).resolves.toBe(0);
    expect(confirmArgvs()).toHaveLength(1);
    expect(stdoutText(out)).toMatch(/Completed 1 focuses/);
  });
});

describe('notify + screen lock — no toast fires while locked', () => {
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

  /**
   * Hermetic stub monitor (mirrors test/screen-driver.test.ts): `fire()`
   * drives subscription transitions synchronously, so lock/unlock timing is
   * exact — never a real `ioreg` spawn (the exec mock only ever sees
   * `terminal-notifier`).
   */
  class StubMonitor implements ScreenMonitor {
    private readonly listeners = new Set<(s: ScreenState) => void>();
    private lastKnown: ScreenState;

    constructor(initial: ScreenState = 'active') {
      this.lastKnown = initial;
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
      return this.lastKnown;
    }

    fire(state: ScreenState): void {
      this.lastKnown = state;
      for (const listener of [...this.listeners]) {
        listener(state);
      }
    }
  }

  /** Delivered toasts only (`-title` present — excludes `-remove`/`-version`). */
  function notifyTitles(): (string | undefined)[] {
    return allArgvs()
      .filter((argv) => argv.includes('-title'))
      .map((argv) => argv[argv.indexOf('-title') + 1]);
  }

  function removals(): string[][] {
    return allArgvs().filter((argv) => argv.includes('-remove'));
  }

  it('quiet: lock at expiry suppresses the transition toast (withdraws the stale one), unlock delivers it', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    mockBinaryAvailable();
    const stub = new StubMonitor('active');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(
      ['--focus', '2s', '--short', '60s', '--long', '60s', '--cycles', '4', '--quiet', '--notify'],
      { monitor: stub },
    );
    try {
      await advance(0);
      expect(stdoutText(out)).toContain('Focus 1/4');
      expect(notifyTitles()).toContain('Focus 1/4');
      // Lock lands just before the 2s deadline.
      stub.fire('locked');
      await advance(0);
      expect(stdoutText(out)).toMatch(/Paused Focus — screen locked, timer frozen/);
      // The startup toast must not linger on the lock screen.
      expect(removals().length).toBeGreaterThan(0);
      expect(removals()[0]).toContain('screen-pomodoro');
      const titlesWhileLocked = notifyTitles().length;
      // Run well past the deadline while locked: no phase change, no bell,
      // and crucially no new toast fired during the lock.
      await advance(5_000);
      await advance(0);
      expect(stdoutText(out)).not.toContain('Short break');
      expect(countBells(stdoutText(out))).toBe(0);
      expect(notifyTitles().length).toBe(titlesWhileLocked);
      // Unlock defers the transition until now: line + bell + toast land together.
      stub.fire('active');
      await advance(0);
      expect(stdoutText(out)).toMatch(/Resumed Focus — \d+:\d\d remaining/);
      await advance(2_500);
      await advance(0);
      expect(stdoutText(out)).toContain('Short break');
      expect(notifyTitles()).toContain('Short break');
      expect(countBells(stdoutText(out))).toBeGreaterThan(0);
    } finally {
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
    }
  });

  it('quiet: starting while locked fires no startup toast, first transition still notifies after unlock', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    mockBinaryAvailable();
    const stub = new StubMonitor('locked');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run(
      ['--focus', '2s', '--short', '60s', '--long', '60s', '--cycles', '4', '--quiet', '--notify'],
      { monitor: stub },
    );
    try {
      await advance(0);
      // Birth line + immediate freeze, but no toast on the lock screen.
      expect(stdoutText(out)).toContain('Focus 1/4');
      expect(stdoutText(out)).toMatch(/Paused Focus — screen locked, timer frozen/);
      expect(notifyTitles()).toHaveLength(0);
      // Frozen: time passes, nothing new fires.
      const frozen = stdoutText(out);
      await advance(10_000);
      await advance(0);
      expect(stdoutText(out)).toBe(frozen);
      expect(countBells(stdoutText(out))).toBe(0);
      // Unlock resumes the same focus; its expiry then notifies normally.
      stub.fire('active');
      await advance(0);
      expect(stdoutText(out)).toMatch(/Resumed Focus — \d+:\d\d remaining/);
      await advance(2_500);
      await advance(0);
      expect(stdoutText(out)).toContain('Short break');
      expect(notifyTitles()).toContain('Short break');
    } finally {
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
    }
  });

  it('--notify-confirm: lock keeps the pending toast unanswered, unlock re-sends it, click still counts', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    setStdinIsTTY(false);
    const manual = mockBinaryManual();
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stub = new StubMonitor('active');
    const runPromise = run(
      [
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
        // 009: pin --start focus so the startup toast menu is skipped.
        '--start',
        'focus',
      ],
      { monitor: stub },
    );
    try {
      await advance(0);
      await advance(2_200);
      await advance(0);
      expect(stdoutText(out)).toContain('Focus 1/4');
      expect(manual.confirmCalls()).toBe(1);
      expect(countBells(stdoutText(out))).toBe(1);
      // Lock with the toast pending: the prompt survives (answer still wins),
      // nothing re-prompts into the lock and no bell repeats.
      stub.fire('locked');
      await advance(0);
      await advance(5_000);
      await advance(0);
      expect(manual.confirmCalls()).toBe(1);
      expect(countBells(stdoutText(out))).toBe(1);
      expect(stdoutText(out)).not.toContain('Short break');
      // Unlock re-sends the identical toast (same -group, replaces in place)
      // so the decision is answerable again — silently (no second bell).
      stub.fire('active');
      await advance(0);
      expect(manual.confirmCalls()).toBe(2);
      expect(manual.confirmArgvs[1]).toEqual(manual.confirmArgvs[0]);
      expect(countBells(stdoutText(out))).toBe(1);
      expect(stderrText(errOut)).toBe('');
      // The post-unlock click counts exactly once.
      manual.answerNext('@ACTIONCLICKED');
      await advance(0);
      expect(stdoutText(out)).toContain('Short break');
      expect(manual.confirmCalls()).toBe(2);
    } finally {
      process.emit('SIGINT');
      await expect(runPromise).resolves.toBe(0);
      expect(stdoutText(out)).toMatch(/Completed 1 focuses/);
    }
  });
});
