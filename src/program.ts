import pkg from '../package.json' with { type: 'json' };
import { Command } from 'commander';
import { parsePhaseName, type PhaseNames } from './display.js';
import { checkNotifierAvailable, GROUP_ID, isNotifySupported, parseNotifyGroup } from './notify.js';
import { parseDuration, parseStartPhase, type Phase, type PomodoroConfig } from './timer.js';
import type { ScreenMonitor } from './screen.js';
import { startDriver } from './driver.js';

interface PomodoroOptions {
  focus: string;
  short: string;
  long: string;
  cycles: string;
  start?: string | undefined;
  loop: boolean;
  quiet: boolean;
  timestamp: boolean;
  confirm: boolean;
  notify: boolean;
  notifyConfirm: boolean;
  notifyGroup?: string | undefined;
  screenPause: boolean;
  bell: boolean;
  focusName: string;
  shortName: string;
  longName: string;
}

function parseCyclesOption(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || !Number.isFinite(value)) {
    throw new Error(`invalid cycles ${JSON.stringify(raw)}: cycles must be an integer >= 1`);
  }
  return value;
}

export function createProgram(monitorOverride?: ScreenMonitor): Command {
  const program = new Command()
    .name('screen-pomodoro')
    .description('A pomodoro timer that pauses when your screen locks.')
    .version(pkg.version, '-V, --version', 'Print the version number.')
    .option('--focus <duration>', 'Focus duration (minutes or with s/m/h suffix).', '25')
    .option('--short <duration>', 'Short break duration (minutes or with s/m/h suffix).', '5')
    .option('--long <duration>', 'Long break duration (minutes or with s/m/h suffix).', '15')
    .option(
      '--cycles <n>',
      'Focuses per long break (integer >= 1). Loops forever unless --no-loop is given.',
      '4',
    )
    .option(
      '--no-loop',
      'Stop after the first long break (with the default start, after --cycles focuses) instead of looping forever.',
    )
    .option(
      '--start <phase>',
      'Starting phase: focus, short, or long (aliases short-break, long-break). With --confirm/--notify-confirm, omit to choose at startup.',
    )
    .option('-q, --quiet', 'Log transitions only, no live countdown.')
    .option('--timestamp', 'Prefix history lines with the current time ([HH:MM:SS]).')
    .option('--confirm', 'Awaits y/n on each phase transition (requires interactive stdin).')
    .option(
      '--notify',
      'Send a macOS notification on each phase transition (macOS + terminal-notifier required).',
    )
    .option(
      '--notify-confirm',
      'Answer phase transitions by clicking the notification (click = start next, Restart = redo). Implies the confirm gate; does not require interactive stdin.',
    )
    .option('--no-screen-pause', 'Do not pause when the screen locks.')
    .option('--no-bell', 'Disable the terminal bell (\\x07) on phase changes and prompts.')
    .option(
      '--notify-group <id>',
      'Notification group for overlapping timers (default shares one toast).',
    )
    .option('--focus-name <name>', 'Custom label for focus phases.', 'Focus')
    .option('--short-name <name>', 'Custom label for short breaks.', 'Short break')
    .option('--long-name <name>', 'Custom label for long breaks.', 'Long break');

  program.action(async (): Promise<void> => {
    const raw = program.opts<PomodoroOptions>();

    let config: PomodoroConfig;
    let names: PhaseNames;
    let startPhase: Phase | undefined;
    try {
      const focusMs = parseDuration(raw.focus);
      const shortBreakMs = parseDuration(raw.short);
      const longBreakMs = parseDuration(raw.long);
      const cycles = parseCyclesOption(raw.cycles);
      config = { focusMs, shortBreakMs, longBreakMs, cycles };
      startPhase = raw.start === undefined ? undefined : parseStartPhase(raw.start);
      names = {
        focus: parsePhaseName(raw.focusName, '--focus-name'),
        shortBreak: parsePhaseName(raw.shortName, '--short-name'),
        longBreak: parsePhaseName(raw.longName, '--long-name'),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      program.error(`error: ${message}`, { exitCode: 1 });
      throw err;
    }

    const notify = raw.notify ?? false;
    const notifyConfirm = raw.notifyConfirm ?? false;

    let notifyGroup = GROUP_ID;
    try {
      if (raw.notifyGroup !== undefined) {
        notifyGroup = parseNotifyGroup(raw.notifyGroup);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      program.error(`error: ${message}`, { exitCode: 1 });
      throw err;
    }

    if (raw.notifyGroup !== undefined && !notify && !notifyConfirm) {
      program.error('error: --notify-group requires --notify or --notify-confirm', {
        exitCode: 1,
      });
      return;
    }

    if (notifyConfirm && raw.confirm) {
      program.error('error: --notify-confirm cannot be used with --confirm (one source only)', {
        exitCode: 1,
      });
      return;
    }

    if (notifyConfirm && notify) {
      program.error('error: --notify-confirm cannot be used with --notify (one source only)', {
        exitCode: 1,
      });
      return;
    }

    if (raw.confirm && !process.stdin.isTTY) {
      program.error('--confirm requires an interactive terminal', { exitCode: 1 });
      return;
    }

    if ((notify || notifyConfirm) && !isNotifySupported()) {
      const flag = notifyConfirm ? '--notify-confirm' : '--notify';
      program.error(`error: ${flag} requires macOS (terminal-notifier)`, { exitCode: 1 });
      return;
    }

    if (notify || notifyConfirm) {
      try {
        await checkNotifierAvailable();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        program.error(`error: ${message}`, { exitCode: 1 });
        return;
      }
    }

    const quiet = raw.quiet || !process.stdout.isTTY;
    await startDriver(
      program,
      config,
      {
        loop: raw.loop,
        live: !quiet,
        names,
        timestamp: raw.timestamp ?? false,
        confirm: raw.confirm,
        notify,
        notifyConfirm,
        notifyGroup,
        screenPause: raw.screenPause ?? true,
        bell: raw.bell ?? true,
        startPhase,
      },
      monitorOverride,
    );
  });

  return program;
}
