import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

export type ScreenState = 'active' | 'locked';

export type ScreenListener = (state: ScreenState) => void;

export interface ScreenMonitor {
  subscribe(listener: ScreenListener): () => void;
  getInitialState(): ScreenState;
  probeNow(): Promise<ScreenState>;
}

/** Poll interval per 005 D4 (amends 002's "fully idle" quiet-mode line). */
export const POLL_MS = 2000;

const IOREG_BIN = '/usr/sbin/ioreg';
const IOREG_ARGS = ['-n', 'Root', '-d1'] as const;

export interface ProbeResult {
  stdout: string;
  stderr: string;
}

export type ProbeExec = (file: string, args: readonly string[]) => Promise<ProbeResult>;

export type SetIntervalFn = (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
export type ClearIntervalFn = (handle: ReturnType<typeof setInterval>) => void;

export interface PollingMonitorOptions {
  pollMs?: number;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
}

const execFileAsync = promisify(execFileCallback);

const defaultProbeExec: ProbeExec = async (file, args) => {
  const result = await execFileAsync(file, [...args]);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

// V1 signal per 005 Behavior + D2 (whitespace-tolerant: top level pads with
// spaces `"key" = Yes`, array entries don't `"key"=Yes`).
const LOCKED_RE = /"IOConsoleLocked"\s*=\s*Yes/;
const DEFENSIVE_LOCKED_RE = /"CGSSessionScreenIsLocked"\s*=\s*Yes/;
// Key-presence (any value) distinguishes a clean `= No` parse from a miss.
const CONSOLE_LOCKED_KEY_RE = /"IOConsoleLocked"\s*=/;
const DEFENSIVE_KEY_RE = /"CGSSessionScreenIsLocked"\s*=/;

function parseIoreg(stdout: string): { state: ScreenState; ok: boolean } {
  if (LOCKED_RE.test(stdout) || DEFENSIVE_LOCKED_RE.test(stdout)) {
    return { state: 'locked', ok: true };
  }
  if (CONSOLE_LOCKED_KEY_RE.test(stdout) || DEFENSIVE_KEY_RE.test(stdout)) {
    return { state: 'active', ok: true };
  }
  // Missing keys / garbage: fail open (active) + note-once at the call site.
  return { state: 'active', ok: false };
}

/**
 * MVP seam: always `active`, never fires. The CLI wires it in so the
 * pause-on-lock path exists but never triggers until a per-OS watcher
 * implements `ScreenMonitor`.
 */
export class NoopMonitor implements ScreenMonitor {
  private listeners = new Set<ScreenListener>();

  subscribe(listener: ScreenListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  getInitialState(): ScreenState {
    return 'active';
  }

  probeNow(): Promise<ScreenState> {
    return Promise.resolve('active');
  }
}

/**
 * 005 — macOS `ioreg` polling monitor. Injectable `execFile`-only probe
 * (argv array, never a shell string) plus injectable timers for fake-timer
 * tests; fail-open everywhere (error/parse-miss → active + note-once).
 */
export class PollingMonitor implements ScreenMonitor {
  private readonly probe: ProbeExec;
  private readonly pollMs: number;
  private readonly setIntervalFn: SetIntervalFn;
  private readonly clearIntervalFn: ClearIntervalFn;
  private readonly listeners = new Set<ScreenListener>();
  private lastKnown: ScreenState = 'active';
  private interval: ReturnType<typeof setInterval> | undefined;
  private noted = false;

  constructor(probe: ProbeExec = defaultProbeExec, options: PollingMonitorOptions = {}) {
    this.probe = probe;
    this.pollMs = options.pollMs ?? POLL_MS;
    // Resolve globals at call time so `vi.spyOn(globalThis, …)` and fake
    // timers observe the calls; custom fns stay injectable per 005.
    this.setIntervalFn =
      options.setIntervalFn ??
      ((callback: () => void, ms: number) => globalThis.setInterval(callback, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle: ReturnType<typeof setInterval>) => {
        globalThis.clearInterval(handle);
      });
  }

  subscribe(listener: ScreenListener): () => void {
    this.listeners.add(listener);
    this.interval ??= this.setIntervalFn(() => {
      void this.pollAndNotify();
    }, this.pollMs);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.interval !== undefined) {
        this.clearIntervalFn(this.interval);
        this.interval = undefined;
      }
    };
  }

  getInitialState(): ScreenState {
    return this.lastKnown;
  }

  async probeNow(): Promise<ScreenState> {
    const { state } = await this.runProbe();
    // One-shot: refresh last-known without fanning out to subscribers.
    this.lastKnown = state;
    return state;
  }

  private noteOnce(): void {
    if (this.noted) return;
    this.noted = true;
    process.stderr.write(
      'screen-pomodoro: ioreg screen-lock probe failed, assuming screen active\n',
    );
  }

  private async runProbe(): Promise<{ state: ScreenState; ok: boolean }> {
    let stdout: string;
    try {
      const result = await this.probe(IOREG_BIN, [...IOREG_ARGS]);
      stdout = result.stdout;
    } catch {
      this.noteOnce();
      return { state: 'active', ok: false };
    }
    const parsed = parseIoreg(stdout);
    if (parsed.ok) {
      this.noted = false;
    } else {
      this.noteOnce();
    }
    return parsed;
  }

  private async pollAndNotify(): Promise<void> {
    const { state } = await this.runProbe();
    if (state === this.lastKnown) return;
    this.lastKnown = state;
    for (const listener of [...this.listeners]) {
      listener(state);
    }
  }
}

export interface CreateScreenMonitorOptions {
  platform?: string;
  enabled?: boolean;
}

/**
 * Backend selector per 005: `enabled === false` (the `--no-screen-pause`
 * path) → `NoopMonitor`; otherwise `darwin` → `PollingMonitor`, anything
 * else → `NoopMonitor`. Defaults to `process.platform` / `true`.
 */
export function createScreenMonitor(opts: CreateScreenMonitorOptions = {}): ScreenMonitor {
  const platform = opts.platform ?? process.platform;
  const enabled = opts.enabled ?? true;
  if (!enabled) return new NoopMonitor();
  if (platform === 'darwin') return new PollingMonitor();
  return new NoopMonitor();
}
