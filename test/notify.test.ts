/**
 * Notification builders and the `terminal-notifier` argv/mapping boundary.
 *
 * Unit-level only: pure builders + injectable exec fakes, following
 * test/confirm.test.ts patterns: inject fakes, never spawn the real
 * `terminal-notifier` binary, never block. Driver wiring lives in
 * test/notify-cli.test.ts.
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
  isNotificationDelivered,
  isNotifySupported,
  parseNotifyGroup,
  sendNotification,
  SOUND,
  type ExecFileFn,
} from '../src/notify.js';
import type { PomodoroConfig } from '../src/timer.js';

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

describe('isNotifySupported', () => {
  it('darwin → true, linux/win32 → false', () => {
    expect(isNotifySupported('darwin')).toBe(true);
    expect(isNotifySupported('linux')).toBe(false);
    expect(isNotifySupported('win32')).toBe(false);
  });
});

describe('escapeNotifierMessage', () => {
  it('prefix-escapes a leading special as \\, leaves the rest alone', () => {
    expect(escapeNotifierMessage('[Coffee] break')).toBe('\\[Coffee] break');
    expect(escapeNotifierMessage('(hi')).toBe('\\(hi');
    expect(escapeNotifierMessage('a[b')).toBe('a[b');
    expect(escapeNotifierMessage('Focus')).toBe('Focus');
  });
});

describe('buildNotifyTitle (entered side, counter focus-only)', () => {
  it('break titles are bare, entered focus carries the counter', () => {
    // focusCount=1: one focus completed, now entering the break.
    expect(buildNotifyTitle('shortBreak', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe('Short break');
    expect(buildNotifyTitle('longBreak', CONFIG, DEFAULT_PHASE_NAMES, 4)).toBe('Long break');
    expect(buildNotifyTitle('focus', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe('Focus 2/4');
  });
});

describe('buildNotifyMessage (nominal clocks)', () => {
  it('25m focus → 5m break: `25:00 spent on Focus. Short break — 5:00 remaining`', () => {
    expect(buildNotifyMessage('focus', 'shortBreak', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe(
      '25:00 spent on Focus. Short break — 5:00 remaining',
    );
  });

  it('startup (leaving undefined, D8): remaining-only, no spent prefix', () => {
    expect(buildNotifyMessage(undefined, 'focus', CONFIG, DEFAULT_PHASE_NAMES, 0)).toBe(
      '25:00 remaining',
    );
  });
});

describe('confirm copy', () => {
  it('title states the proposal: `Focus complete. Start Short break?`', () => {
    expect(buildNotifyConfirmTitle('focus', 'shortBreak', CONFIG, DEFAULT_PHASE_NAMES, 1)).toBe(
      'Focus complete. Start Short break?',
    );
    expect(buildNotifyConfirmTitle('focus', 'shortBreak', CONFIG, CUSTOM, 1)).toBe(
      'Deep work complete. Start Coffee?',
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
});

describe('checkNotifierAvailable (startup guard)', () => {
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

describe('isNotificationDelivered (Clear-All probe)', () => {
  it('runs `terminal-notifier -list <group>` and treats a non-empty table as delivered', async () => {
    const exec = okExec('GroupID\tTitle\tSubtitle\tMessage\tDelivered At\nx\tFocus\t\tmsg\tnow\n');
    await expect(isNotificationDelivered(exec, 'work')).resolves.toBe(true);
    expect(fileOf(exec as unknown as { mock: { calls: unknown[][] } })).toBe('terminal-notifier');
    const argv = argvOf(exec as unknown as { mock: { calls: unknown[][] } });
    expect(argv).toContain('-list');
    expect(argv[argv.indexOf('-list') + 1]).toBe('work');
  });

  it('treats empty output (Clear All) as not delivered', async () => {
    const exec = okExec('');
    await expect(isNotificationDelivered(exec, GROUP_ID)).resolves.toBe(false);
  });
});

describe('sendNotification (fire-and-forget)', () => {
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
    // No shell: hostile names stay inert single argv entries.
    await sendNotification(exec, { title: '$(rm -rf ~)', message: '$(rm -rf ~)' });
    const evil = argvOf(exec as unknown as { mock: { calls: unknown[][] } }, 1);
    expect(evil).toContain('$(rm -rf ~)');
    expect(evil).not.toContain('-action');
  });

  it('never rejects on delivery failure (caller logs; timer continues)', async () => {
    const exec = vi.fn(async (): Promise<ExecResult> => {
      throw Object.assign(new Error('denied'), { code: 3 });
    });
    await expect(
      sendNotification(exec as unknown as ExecFileFn, { title: 't', message: 'm' }),
    ).resolves.toBeUndefined();
  });
});

describe('createNotificationConfirmer mapping table', () => {
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

  it('anything else → false + stderr note', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { confirm } = confirmerWith(['bogus']);
    await expect(confirm('ignored')).resolves.toBe(false);
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

describe('parseNotifyGroup', () => {
  it.each(['', '   ', 'a\nb', 'a\rb', 'a\tb', 'a\u0007b'])('rejects %p', (value) => {
    expect(() => parseNotifyGroup(value)).toThrow(/group|empty|invalid/i);
  });

  it('rejects groups longer than 64 chars', () => {
    expect(() => parseNotifyGroup('x'.repeat(65))).toThrow(/group|64/i);
  });
});

describe('buildNotifyStartTitle/Message (startup toast menu)', () => {
  it('default names + nominal clocks', () => {
    expect(buildNotifyStartTitle()).toBe('Choose starting phase');
    expect(buildNotifyStartMessage(CONFIG, DEFAULT_PHASE_NAMES)).toBe(
      'Start Focus — 25:00, Short break — 5:00, or Long break — 15:00? Click = Focus',
    );
  });
});

describe('createNotificationStartChooser mapping', () => {
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
    const { choose: custom } = chooserWith(['Coffee'], { names: CUSTOM });
    await expect(custom('ignored')).resolves.toBe('shortBreak');
  });

  it('@ACTIONCLICKED (body click) → focus (stdin empty = Focus parity)', async () => {
    const { choose } = chooserWith(['@ACTIONCLICKED']);
    await expect(choose('ignored')).resolves.toBe('focus');
  });

  it('spawn error → focus + stderr note (fallback to the old default, never spins)', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const vanished = Object.assign(new Error('spawn terminal-notifier ENOENT'), { code: 'ENOENT' });
    const { exec, choose } = chooserWith([vanished]);
    await expect(choose('ignored')).resolves.toBe('focus');
    expect(exec).toHaveBeenCalledTimes(1);
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
});
