/**
 * TDD red phase for docs/004-desktop-notifications-macos.md — step 1.
 *
 * Covers the `src/notify.ts` unit contract only (pure builders + injectable
 * exec fakes), following test/confirm.test.ts patterns: inject fakes, never
 * spawn the real `terminal-notifier` binary, never block.
 *
 * All tests are expected to FAIL until 004 is implemented:
 * - `src/notify.ts` does not exist yet (import error = red).
 * - `phaseDurationMs` is not exported from `src/timer.ts` yet.
 *
 * Proposed API under test (per 004 Architecture + Decisions D1–D10):
 * - GROUP_ID / SOUND constants
 * - isNotifySupported(platform?)
 * - escapeNotifierMessage(s)
 * - buildNotifyTitle / buildNotifyMessage (fire-and-forget copy, D9 + D8)
 * - buildNotifyConfirmTitle / buildNotifyConfirmMessage (blocking copy, D6)
 * - phaseDurationMs(config, phase) in timer.ts (D7 + D10, pure switch)
 * - checkNotifierAvailable(exec) — `terminal-notifier -version` once
 * - sendNotification(exec, { title, message }) — fire-and-forget, never rejects
 * - createNotificationConfirmer(exec, { title, message, actionLabel, isFinished? }): ConfirmFn
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PHASE_NAMES, type PhaseNames } from '../src/display.js';
import {
  buildNotifyConfirmAction,
  buildNotifyConfirmMessage,
  buildNotifyConfirmTitle,
  buildNotifyMessage,
  buildNotifyStartMessage,
  buildNotifyStartTitle,
  buildNotifyTitle,
  checkNotifierAvailable,
  createNotificationConfirmer,
  createNotificationStartChooser,
  escapeNotifierMessage,
  GROUP_ID,
  isNotifySupported,
  parseNotifyGroup,
  sendNotification,
  SOUND,
  type ExecFileFn,
} from '../src/notify.js';
import { phaseDurationMs, type PomodoroConfig } from '../src/timer.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const CONFIG: PomodoroConfig = {
  focusMs: 25 * 60_000,
  shortBreakMs: 5 * 60_000,
  longBreakMs: 15 * 60_000,
  cycles: 4,
};

const CUSTOM: PhaseNames = {
  focus: 'Deep work',
  shortBreak: 'Coffee',
  longBreak: 'Lunch',
};

interface ExecResult {
  stdout: string;
  stderr: string;
}

function okExec(stdout: string): ExecFileFn & { calls: unknown[][] } {
  const fn = vi.fn(async (_file: string, _args: readonly string[]): Promise<ExecResult> => ({
    stdout,
    stderr: '',
  })) as unknown as ExecFileFn & { calls: unknown[][]; mock: { calls: unknown[][] } };
  // Expose vitest mock calls for argv assertions via (fn as any).mock.calls.
  return fn;
}

function argvOf(exec: { mock: { calls: unknown[][] } }, callIndex = 0): string[] {
  const call = exec.mock.calls[callIndex];
  if (call === undefined) throw new Error(`expected exec call #${String(callIndex)}`);
  // exec(file, argsArray)
  return call[1] as string[];
}

function fileOf(exec: { mock: { calls: unknown[][] } }, callIndex = 0): string {
  const call = exec.mock.calls[callIndex];
  if (call === undefined) throw new Error(`expected exec call #${String(callIndex)}`);
  return call[0] as string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('004 — notify constants', () => {
  it('uses a single stable group and Bottle sound (D3)', () => {
    expect(GROUP_ID).toBe('screen-pomodoro');
    expect(SOUND).toBe('Bottle');
  });
});

describe('004 — isNotifySupported', () => {
  it('darwin → true, linux/win32 → false', () => {
    expect(isNotifySupported('darwin')).toBe(true);
    expect(isNotifySupported('linux')).toBe(false);
    expect(isNotifySupported('win32')).toBe(false);
  });

  it('defaults to process.platform', () => {
    expect(isNotifySupported()).toBe(process.platform === 'darwin');
  });
});

describe('004 — escapeNotifierMessage (D5)', () => {
  it('prefix-escapes a leading [ as \\[', () => {
    expect(escapeNotifierMessage('[Coffee] break')).toBe('\\[Coffee] break');
  });

  it('prefix-escapes leading (, { and quotes per -help note', () => {
    expect(escapeNotifierMessage('(hi')).toBe('\\(hi');
    expect(escapeNotifierMessage('{hi')).toBe('\\{hi');
    expect(escapeNotifierMessage('"hi')).toBe('\\"hi');
    expect(escapeNotifierMessage("'hi")).toBe("\\'hi");
  });

  it('leaves non-leading specials and plain text alone', () => {
    expect(escapeNotifierMessage('Focus')).toBe('Focus');
    expect(escapeNotifierMessage('a[b')).toBe('a[b');
    expect(escapeNotifierMessage('')).toBe('');
  });
});

describe('004 — phaseDurationMs in timer.ts (D7 + D10)', () => {
  it('is a pure nominal lookup: focus/short/long from config', () => {
    expect(phaseDurationMs(CONFIG, 'focus')).toBe(25 * 60_000);
    expect(phaseDurationMs(CONFIG, 'shortBreak')).toBe(5 * 60_000);
    expect(phaseDurationMs(CONFIG, 'longBreak')).toBe(15 * 60_000);
  });
});

describe('004 — buildNotifyTitle (D9: entered side, counter focus-only)', () => {
  it('25m focus → 5m break gives title `Short break` (no counter on breaks)', () => {
    // focusCount=1: one focus completed, now entering the break.
    expect(buildNotifyTitle('shortBreak', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe('Short break');
    expect(buildNotifyTitle('longBreak', CONFIG, DEFAULT_PHASE_NAMES, 4)).toBe('Long break');
  });

  it('entered focus carries the counter: Focus 2/4', () => {
    expect(buildNotifyTitle('focus', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe('Focus 2/4');
  });

  it('counter wraps per set: a full set later focusCount=4 is Focus 1/4 again', () => {
    expect(buildNotifyTitle('focus', CONFIG, DEFAULT_PHASE_NAMES, 4)).toBe('Focus 1/4');
    expect(buildNotifyTitle('focus', CONFIG, DEFAULT_PHASE_NAMES, 5)).toBe('Focus 2/4');
  });

  it('startup focus is Focus 1/4', () => {
    expect(buildNotifyTitle('focus', CONFIG, DEFAULT_PHASE_NAMES, 0)).toBe('Focus 1/4');
  });

  it('custom names verbatim: `Deep work 2/4`, `Coffee`', () => {
    expect(buildNotifyTitle('focus', CONFIG, CUSTOM, 1)).toBe('Deep work 2/4');
    expect(buildNotifyTitle('shortBreak', CONFIG, CUSTOM, 1)).toBe('Coffee');
  });

  it('counter never appears on breaks even with custom names', () => {
    expect(buildNotifyTitle('shortBreak', CONFIG, CUSTOM, 3)).not.toMatch(/\d+\/\d+/);
    expect(buildNotifyTitle('longBreak', CONFIG, CUSTOM, 4)).not.toMatch(/\d+\/\d+/);
  });
});

describe('004 — buildNotifyMessage (D9 + D7 nominal clocks)', () => {
  it('25m focus → 5m break: `25:00 spent on Focus. Short break — 5:00 remaining`', () => {
    expect(buildNotifyMessage('focus', 'shortBreak', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe(
      '25:00 spent on Focus. Short break — 5:00 remaining',
    );
  });

  it('custom names: `25:00 spent on Deep work. Coffee — 5:00 remaining`', () => {
    expect(buildNotifyMessage('focus', 'shortBreak', CONFIG, CUSTOM, 1)).toBe(
      '25:00 spent on Deep work. Coffee — 5:00 remaining',
    );
  });

  it('break → focus carries the upcoming counter: `5:00 spent on Short break. Focus 2/4 — 25:00 remaining`', () => {
    expect(buildNotifyMessage('shortBreak', 'focus', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe(
      '5:00 spent on Short break. Focus 2/4 — 25:00 remaining',
    );
  });

  it('finished side stays bare (no counter), upcoming side carries it', () => {
    // Leaving focus 1 (count becomes 1) → entering focus is impossible here;
    // leaving shortBreak (count 1) → entering focus 2/4: finished side bare.
    const msg = buildNotifyMessage('shortBreak', 'focus', CONFIG, CUSTOM, 1);
    expect(msg).toBe('5:00 spent on Coffee. Deep work 2/4 — 25:00 remaining');
  });

  it('startup (leaving undefined, D8): remaining-only, no spent prefix', () => {
    expect(buildNotifyMessage(undefined, 'focus', CONFIG, DEFAULT_PHASE_NAMES, 0)).toBe(
      '25:00 remaining',
    );
  });

  it('spent/upcoming are nominal config durations (pause/gating never inflate)', () => {
    // Same config → same message regardless of how long the driver waited.
    const a = buildNotifyMessage('focus', 'shortBreak', CONFIG, DEFAULT_PHASE_NAMES, 1);
    const b = buildNotifyMessage('focus', 'shortBreak', CONFIG, DEFAULT_PHASE_NAMES, 1);
    expect(a).toBe(b);
    expect(a).toContain('25:00');
    expect(a).toContain('5:00');
  });
});

describe('011 — confirm copy (amends 004 D6)', () => {
  it('title states the proposal: `Focus complete. Start Short break?`', () => {
    expect(buildNotifyConfirmTitle('focus', 'shortBreak', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe(
      'Focus complete. Start Short break?',
    );
    expect(buildNotifyConfirmTitle('focus', 'shortBreak', CONFIG, CUSTOM, 1)).toBe(
      'Deep work complete. Start Coffee?',
    );
  });

  it('next focus carries the counter in the title', () => {
    expect(buildNotifyConfirmTitle('shortBreak', 'focus', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe(
      'Short break complete. Start Focus 2/4?',
    );
  });

  it('action is verb-first: `Restart <current>` (bare, no counter)', () => {
    expect(buildNotifyConfirmAction('focus', DEFAULT_PHASE_NAMES)).toBe('Restart Focus');
    expect(buildNotifyConfirmAction('focus', CUSTOM)).toBe('Restart Deep work');
    expect(buildNotifyConfirmAction('shortBreak', CUSTOM)).toBe('Restart Coffee');
  });

  it('message: `25:00 spent. Click for Short break — 5:00, Restart Focus to redo.`', () => {
    expect(buildNotifyConfirmMessage('focus', 'shortBreak', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe(
      '25:00 spent. Click for Short break — 5:00, Restart Focus to redo.',
    );
  });

  it('custom names: `25:00 spent. Click for Coffee — 5:00, Restart Deep work to redo.`', () => {
    expect(buildNotifyConfirmMessage('focus', 'shortBreak', CONFIG, CUSTOM, 1)).toBe(
      '25:00 spent. Click for Coffee — 5:00, Restart Deep work to redo.',
    );
  });

  it('next focus carries the counter in the message proposal', () => {
    expect(buildNotifyConfirmMessage('shortBreak', 'focus', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe(
      '5:00 spent. Click for Focus 2/4 — 25:00, Restart Short break to redo.',
    );
  });
});

describe('004 — checkNotifierAvailable (startup guard)', () => {
  it('runs `terminal-notifier -version` once and resolves on success', async () => {
    const exec = okExec('3.0.0\n');
    await expect(checkNotifierAvailable(exec)).resolves.toBeUndefined();
    expect(fileOf(exec as unknown as { mock: { calls: unknown[][] } })).toBe('terminal-notifier');
    expect(argvOf(exec as unknown as { mock: { calls: unknown[][] } })).toContain('-version');
  });

  it('ENOENT → brew-hint error', async () => {
    const enoent = Object.assign(new Error('spawn terminal-notifier ENOENT'), {
      code: 'ENOENT',
    });
    const exec = vi.fn(async (): Promise<ExecResult> => {
      throw enoent;
    });
    await expect(checkNotifierAvailable(exec as unknown as ExecFileFn)).rejects.toThrow(
      /brew install terminal-notifier/i,
    );
  });

  it('exit-3 text matches /System Settings|tccutil/i', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 3 });
    const exec = vi.fn(async (): Promise<ExecResult> => {
      throw denied;
    });
    await expect(checkNotifierAvailable(exec as unknown as ExecFileFn)).rejects.toThrow(
      /System Settings|tccutil/i,
    );
  });
});

describe('004 — sendNotification (fire-and-forget)', () => {
  it('delivers via execFile with -group/-sound/-title/-message as separate argv entries (no shell)', async () => {
    const exec = okExec('');
    await sendNotification(exec, {
      title: 'Short break',
      message: '25:00 spent on Focus. Short break — 5:00 remaining',
    });
    expect(fileOf(exec as unknown as { mock: { calls: unknown[][] } })).toBe('terminal-notifier');
    const argv = argvOf(exec as unknown as { mock: { calls: unknown[][] } });
    expect(argv).toContain('-group');
    expect(argv).toContain(GROUP_ID);
    expect(argv).toContain('-sound');
    expect(argv).toContain(SOUND);
    // Title/message are separate argv entries (never a shell string).
    const titleIdx = argv.indexOf('-title');
    const msgIdx = argv.indexOf('-message');
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(msgIdx).toBeGreaterThanOrEqual(0);
    expect(argv[titleIdx + 1]).toBe('Short break');
    expect(argv[msgIdx + 1]).toBe('25:00 spent on Focus. Short break — 5:00 remaining');
  });

  it('fire-and-forget has no -action (blocking confirmer adds it)', async () => {
    const exec = okExec('');
    await sendNotification(exec, { title: 't', message: 'm' });
    expect(argvOf(exec as unknown as { mock: { calls: unknown[][] } })).not.toContain('-action');
  });

  it('escapes a leading-[ message as \\[…', async () => {
    const exec = okExec('');
    await sendNotification(exec, {
      title: '[Coffee]',
      message: '[Coffee] break',
    });
    const argv = argvOf(exec as unknown as { mock: { calls: unknown[][] } });
    expect(argv[argv.indexOf('-message') + 1]).toBe('\\[Coffee] break');
  });

  it('never rejects on delivery failure (caller logs; timer continues)', async () => {
    const exec = vi.fn(async (): Promise<ExecResult> => {
      throw Object.assign(new Error('denied'), { code: 3 });
    });
    await expect(
      sendNotification(exec as unknown as ExecFileFn, { title: 't', message: 'm' }),
    ).resolves.toBeUndefined();
  });

  it('phase names like `$(rm -rf ~)` are inert single argv entries (execFile-only, D5)', async () => {
    const exec = okExec('');
    const evil = '$(rm -rf ~)';
    await sendNotification(exec, { title: evil, message: evil });
    const argv = argvOf(exec as unknown as { mock: { calls: unknown[][] } });
    expect(argv).toContain(evil);
    expect(fileOf(exec as unknown as { mock: { calls: unknown[][] } })).toBe('terminal-notifier');
  });
});

describe('011 — createNotificationConfirmer mapping table (amends 004 D2)', () => {
  function confirmerWith(
    outputs: (string | Error)[],
    opts?: { title?: string; message?: string; actionLabel?: string; isFinished?: () => boolean },
  ): { exec: ReturnType<typeof vi.fn>; confirm: (msg: string) => Promise<boolean> } {
    const queue = [...outputs];
    const exec = vi.fn(async (_file: string, _args: readonly string[]): Promise<ExecResult> => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { stdout: next ?? '', stderr: '' };
    });
    const confirm = createNotificationConfirmer(exec, {
      title: opts?.title ?? 'Focus complete. Start Short break?',
      message: opts?.message ?? '25:00 spent. Click for Short break — 5:00, Restart Focus to redo.',
      actionLabel: opts?.actionLabel ?? 'Restart Focus',
      isFinished: opts?.isFinished,
    });
    return { exec, confirm };
  }

  it('@ACTIONCLICKED (body click) → true', async () => {
    const { confirm } = confirmerWith(['@ACTIONCLICKED']);
    await expect(confirm('ignored')).resolves.toBe(true);
  });

  it('restart button (`Restart Focus`) → false, exact label', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { confirm } = confirmerWith(['Restart Focus']);
    await expect(confirm('ignored')).resolves.toBe(false);
    // Explicit restart is an answer, not a failure: no stderr note required.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace', async () => {
    const { confirm: yes } = confirmerWith(['  @ACTIONCLICKED\n']);
    await expect(yes('ignored')).resolves.toBe(true);
    const { confirm: no } = confirmerWith(['  Restart Focus  \n']);
    await expect(no('ignored')).resolves.toBe(false);
  });

  it('@CLOSED → re-sends the same toast (same argv/group, replaces in place)', async () => {
    const { exec, confirm } = confirmerWith(['@CLOSED', '@ACTIONCLICKED']);
    await expect(confirm('ignored')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    const first = exec.mock.calls[0]?.[1] as string[];
    const second = exec.mock.calls[1]?.[1] as string[];
    expect(first).toEqual(second);
    expect(first).toContain('-group');
    expect(first).toContain(GROUP_ID);
  });

  it('@TIMEOUT → re-sends (defensive; V1 sets no -timeout)', async () => {
    const { exec, confirm } = confirmerWith(['@TIMEOUT', 'Restart Focus']);
    await expect(confirm('ignored')).resolves.toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('anything else → false + stderr note', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { confirm } = confirmerWith(['bogus']);
    await expect(confirm('ignored')).resolves.toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('button title is exact: `restart focus`/`RESTART FOCUS` are not the explicit answer (still false, with note)', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { confirm: lower } = confirmerWith(['restart focus']);
    await expect(lower('ignored')).resolves.toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('spawn error after startup check → false + stderr note (never re-sends undeliverable)', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const vanished = Object.assign(new Error('spawn terminal-notifier ENOENT'), {
      code: 'ENOENT',
    });
    const { exec, confirm } = confirmerWith([vanished]);
    await expect(confirm('ignored')).resolves.toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it('argv asserts -group/-sound/-action Restart with title/message as separate entries (no shell)', async () => {
    const { exec, confirm } = confirmerWith(['@ACTIONCLICKED'], {
      title: 'Deep work complete. Start Coffee?',
      message: '25:00 spent. Click for Coffee — 5:00, Restart Deep work to redo.',
      actionLabel: 'Restart Deep work',
    });
    await confirm('ignored');
    expect(exec.mock.calls[0]?.[0]).toBe('terminal-notifier');
    const argv = exec.mock.calls[0]?.[1] as string[];
    expect(argv).toContain('-group');
    expect(argv).toContain(GROUP_ID);
    expect(argv).toContain('-sound');
    expect(argv).toContain(SOUND);
    expect(argv).toContain('-action');
    expect(argv).toContain('Restart Deep work');
    expect(argv[argv.indexOf('-title') + 1]).toBe('Deep work complete. Start Coffee?');
    expect(argv[argv.indexOf('-message') + 1]).toBe(
      '25:00 spent. Click for Coffee — 5:00, Restart Deep work to redo.',
    );
  });

  it('escapes leading-[ in the delivered message', async () => {
    const { exec, confirm } = confirmerWith(['@ACTIONCLICKED'], {
      title: 't',
      message: '[Coffee] break',
    });
    await confirm('ignored');
    const argv = exec.mock.calls[0]?.[1] as string[];
    expect(argv[argv.indexOf('-message') + 1]).toBe('\\[Coffee] break');
  });

  it('isFinished short-circuits like the stdin confirmer (SIGINT settles pending)', async () => {
    const exec = vi.fn(async (): Promise<ExecResult> => ({ stdout: '@ACTIONCLICKED', stderr: '' }));
    const confirm = createNotificationConfirmer(exec, {
      title: 't',
      message: 'm',
      actionLabel: 'Restart Focus',
      isFinished: () => true,
    });
    await expect(confirm('ignored')).resolves.toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('consumeResendRequest: driver kill for unlock-resend re-sends silently instead of failing', async () => {
    let resend = true; // unlock killed the waiting child
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const queue: (string | Error)[] = [
      Object.assign(new Error('Command failed: terminal-notifier'), { signal: 'SIGTERM' }),
      '@ACTIONCLICKED',
    ];
    const exec = vi.fn(async (_file: string, _args: readonly string[]): Promise<ExecResult> => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { stdout: next ?? '', stderr: '' };
    });
    const confirm = createNotificationConfirmer(exec, {
      title: 't',
      message: 'm',
      actionLabel: 'Restart Focus',
      consumeResendRequest: () => {
        const requested = resend;
        resend = false;
        return requested;
      },
    });
    await expect(confirm('ignored')).resolves.toBe(true);
    // Same toast re-sent (second call, identical argv), no stderr note.
    expect(exec).toHaveBeenCalledTimes(2);
    const firstArgv = exec.mock.calls[0]?.[1] as string[];
    const secondArgv = exec.mock.calls[1]?.[1] as string[];
    expect(secondArgv).toEqual(firstArgv);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('an answer that raced the unlock drops the stale resend request (later failure still resolves false)', async () => {
    let resend = true; // unlock landed just as the click did; the click won
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exec = vi.fn(async (): Promise<ExecResult> => ({ stdout: '@ACTIONCLICKED', stderr: '' }));
    const consume = (): boolean => {
      const requested = resend;
      resend = false;
      return requested;
    };
    const first = createNotificationConfirmer(exec, {
      title: 't',
      message: 'm',
      actionLabel: 'Restart Focus',
      consumeResendRequest: consume,
    });
    await expect(first('ignored')).resolves.toBe(true);
    // Success cleared the raced flag: a later genuine failure resolves
    // false with a note instead of re-sending forever.
    const failing = vi.fn(async (): Promise<ExecResult> => {
      throw new Error('spawn terminal-notifier ENOENT');
    });
    const second = createNotificationConfirmer(failing, {
      title: 't',
      message: 'm',
      actionLabel: 'Restart Focus',
      consumeResendRequest: consume,
    });
    await expect(second('ignored')).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('008 — parseNotifyGroup + custom group isolation', () => {
  it('defaults share GROUP_ID; custom group passes through verbatim', async () => {
    const exec = okExec('');
    await sendNotification(exec, { title: 't', message: 'm', group: 'work' });
    const argv = argvOf(exec as unknown as { mock: { calls: unknown[][] } });
    expect(argv[argv.indexOf('-group') + 1]).toBe('work');
  });

  it('confirmer carries the custom group into the blocking -action toast', async () => {
    const exec = vi.fn(async (_file: string, _args: readonly string[]): Promise<ExecResult> => ({
      stdout: '@ACTIONCLICKED',
      stderr: '',
    }));
    const confirm = createNotificationConfirmer(exec, {
      title: 't',
      message: 'm',
      group: 'stretch',
      actionLabel: 'Restart Focus',
    });
    await expect(confirm('ignored')).resolves.toBe(true);
    const argv = exec.mock.calls[0]?.[1] as unknown as string[];
    expect(argv[argv.indexOf('-group') + 1]).toBe('stretch');
  });

  it('trims surrounding whitespace', () => {
    expect(parseNotifyGroup('  work  ')).toBe('work');
  });

  it.each(['', '   ', 'a\nb', 'a\rb', 'a\tb', 'a\u0007b'])('rejects %p', (value) => {
    expect(() => parseNotifyGroup(value)).toThrow(/group|empty|invalid/i);
  });

  it('rejects groups longer than 64 chars', () => {
    expect(() => parseNotifyGroup('x'.repeat(65))).toThrow(/group|64/i);
  });

  it('allows spaces and emoji within the limit', () => {
    expect(parseNotifyGroup('Deep work 🍅')).toBe('Deep work 🍅');
  });
});

describe('004 — module constraints (D1 driver-only, D5 execFile-only)', () => {
  it('notify module imports no timer core and shells out via execFile only', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../src/notify.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"]\.\/timer\.js['"]/);
    expect(source).toMatch(/execFile/);
  });
});

describe('009 — buildNotifyStartTitle/Message (startup toast menu)', () => {
  it('title is `Choose starting phase`', () => {
    expect(buildNotifyStartTitle()).toBe('Choose starting phase');
  });

  it('default names: `Start Focus — 25:00, Short break — 5:00, or Long break — 15:00? Click = Focus`', () => {
    expect(buildNotifyStartMessage(CONFIG, DEFAULT_PHASE_NAMES)).toBe(
      'Start Focus — 25:00, Short break — 5:00, or Long break — 15:00? Click = Focus',
    );
  });

  it('custom labels verbatim (bare, no counter)', () => {
    expect(buildNotifyStartMessage(CONFIG, CUSTOM)).toBe(
      'Start Deep work — 25:00, Coffee — 5:00, or Lunch — 15:00? Click = Deep work',
    );
  });

  it('durations are nominal config clocks (pause/gating never inflate)', () => {
    const tiny: PomodoroConfig = {
      focusMs: 60_000,
      shortBreakMs: 1_000,
      longBreakMs: 60_000,
      cycles: 4,
    };
    expect(buildNotifyStartMessage(tiny, DEFAULT_PHASE_NAMES)).toBe(
      'Start Focus — 1:00, Short break — 0:01, or Long break — 1:00? Click = Focus',
    );
  });
});

describe('009 — createNotificationStartChooser mapping', () => {
  type StartPhase = 'focus' | 'shortBreak' | 'longBreak';
  function chooserWith(
    outputs: (string | Error)[],
    opts?: {
      title?: string;
      message?: string;
      group?: string;
      names?: PhaseNames;
      isFinished?: () => boolean;
    },
  ): { exec: ReturnType<typeof vi.fn>; choose: (msg: string) => Promise<StartPhase | undefined> } {
    const queue = [...outputs];
    const exec = vi.fn(async (_file: string, _args: readonly string[]): Promise<ExecResult> => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { stdout: next ?? '', stderr: '' };
    });
    const choose = createNotificationStartChooser(exec, {
      title: opts?.title ?? 'Choose starting phase',
      message:
        opts?.message ??
        'Start Focus — 25:00, Short break — 5:00, or Long break — 15:00? Click = Focus',
      group: opts?.group,
      names: opts?.names,
      isFinished: opts?.isFinished,
    });
    return { exec, choose };
  }

  it('button title → phase (bare labels, trimmed, case-insensitive)', async () => {
    const { choose: f } = chooserWith(['Focus']);
    await expect(f('ignored')).resolves.toBe('focus');
    const { choose: s } = chooserWith(['  Short break  ']);
    await expect(s('ignored')).resolves.toBe('shortBreak');
    const { choose: l } = chooserWith(['LONG BREAK']);
    await expect(l('ignored')).resolves.toBe('longBreak');
  });

  it('parses via parseStartChoice: digits/letters and --start words', async () => {
    const { choose: two } = chooserWith(['2']);
    await expect(two('ignored')).resolves.toBe('shortBreak');
    const { choose: word } = chooserWith(['short-break']);
    await expect(word('ignored')).resolves.toBe('shortBreak');
  });

  it('custom labels resolve as actions', async () => {
    const { choose } = chooserWith(['Coffee'], { names: CUSTOM });
    await expect(choose('ignored')).resolves.toBe('shortBreak');
  });

  it('@ACTIONCLICKED (body click) → focus (stdin empty = Focus parity)', async () => {
    const { choose } = chooserWith(['@ACTIONCLICKED']);
    await expect(choose('ignored')).resolves.toBe('focus');
  });

  it('@CLOSED → re-sends the same toast (same argv/group, replaces in place)', async () => {
    const { exec, choose } = chooserWith(['@CLOSED', 'Short break']);
    await expect(choose('ignored')).resolves.toBe('shortBreak');
    expect(exec).toHaveBeenCalledTimes(2);
    const first = exec.mock.calls[0]?.[1] as string[];
    const second = exec.mock.calls[1]?.[1] as string[];
    expect(second).toEqual(first);
    expect(first).toContain('-group');
    expect(first).toContain(GROUP_ID);
  });

  it('@TIMEOUT → re-sends', async () => {
    const { exec, choose } = chooserWith(['@TIMEOUT', '@ACTIONCLICKED']);
    await expect(choose('ignored')).resolves.toBe('focus');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('spawn error → focus + stderr note (fallback to the old default, never spins)', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const vanished = Object.assign(new Error('spawn terminal-notifier ENOENT'), { code: 'ENOENT' });
    const { exec, choose } = chooserWith([vanished]);
    await expect(choose('ignored')).resolves.toBe('focus');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it('unexpected output → focus + stderr note', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { choose } = chooserWith(['bogus']);
    await expect(choose('ignored')).resolves.toBe('focus');
    expect(errSpy).toHaveBeenCalled();
  });

  it('isFinished → undefined without spawning (SIGINT abort parity)', async () => {
    const exec = vi.fn(async (): Promise<ExecResult> => ({ stdout: 'Focus', stderr: '' }));
    const choose = createNotificationStartChooser(exec, {
      title: 't',
      message: 'm',
      isFinished: () => true,
    });
    await expect(choose('ignored')).resolves.toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it('argv uses repeated -action (not comma-joined) with bare custom labels', async () => {
    const { exec, choose } = chooserWith(['Coffee'], { names: CUSTOM });
    await choose('ignored');
    expect(exec.mock.calls[0]?.[0]).toBe('terminal-notifier');
    const argv = exec.mock.calls[0]?.[1] as string[];
    expect(argv).toContain('-group');
    expect(argv).toContain(GROUP_ID);
    expect(argv).toContain('-sound');
    expect(argv).toContain(SOUND);
    expect(argv[argv.indexOf('-title') + 1]).toBe('Choose starting phase');
    // Repeated -action entries, one per phase, verbatim (no comma-join).
    const actions = argv.filter((_, i) => argv[i - 1] === '-action');
    expect(actions).toEqual(['Deep work', 'Coffee', 'Lunch']);
    expect(argv.join('\x00')).not.toMatch(/Deep work,Coffee/);
  });

  it('custom --notify-group carries into the chooser toast', async () => {
    const { exec, choose } = chooserWith(['Focus'], { group: 'work' });
    await expect(choose('ignored')).resolves.toBe('focus');
    const argv = exec.mock.calls[0]?.[1] as unknown as string[];
    expect(argv[argv.indexOf('-group') + 1]).toBe('work');
  });
});
