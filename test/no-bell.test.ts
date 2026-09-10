/**
 * docs/010-no-bell.md — `--no-bell` opt-out.
 *
 * Covers the observable CLI contract (via `run(argv)`), following
 * test/cli.test.ts + test/confirm.test.ts patterns: `vi.useFakeTimers`,
 * spy `stdout.write`, stub `node:readline` for the confirm case.
 * Never real stdin, never spawned binaries.
 */
import * as readline from 'node:readline';
import type * as readlineTypes from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';

vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof readlineTypes>();
  return { ...actual, createInterface: vi.fn() };
});

function mockedCreateInterface(): ReturnType<typeof vi.fn> {
  return vi.mocked(readline.createInterface);
}

function stdoutText(spy: { mock: { calls: readonly unknown[][] } }): string {
  return spy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : String(call[0])))
    .join('');
}

function countBells(text: string): number {
  return text.split('\x07').length - 1;
}

const originalStdoutIsTTY = (process.stdout as { isTTY?: unknown }).isTTY;
const originalStdinIsTTY = (process.stdin as { isTTY?: unknown }).isTTY;

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

function mockReadlineQueue(answers: string[]): { prompts: string[] } {
  const prompts: string[] = [];
  const queue = [...answers];
  const questionSpy = vi.fn((prompt: string, cb: (answer: string) => void) => {
    prompts.push(prompt);
    const next = queue.length > 0 ? queue.shift()! : 'y';
    queueMicrotask(() => {
      cb(next);
    });
  });
  const closeSpy = vi.fn(() => undefined);
  mockedCreateInterface().mockReturnValue({ question: questionSpy, close: closeSpy });
  return { prompts };
}

describe('010 — no-bell opt-out', () => {
  let sigintBaseline = 0;

  beforeEach(() => {
    sigintBaseline = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockedCreateInterface().mockClear();
    vi.useRealTimers();
    if (originalStdoutIsTTY === undefined) delete (process.stdout as { isTTY?: unknown }).isTTY;
    else
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
        writable: true,
      });
    if (originalStdinIsTTY === undefined) delete (process.stdin as { isTTY?: unknown }).isTTY;
    else
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinIsTTY,
        configurable: true,
        writable: true,
      });
  });

  it('lists --no-bell in --help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    expect(stdoutText(out)).toContain('--no-bell');
  });

  it('quiet phase change rings by default (backward compat)', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '2s',
      '--short',
      '1s',
      '--long',
      '1s',
      '--cycles',
      '4',
      '--quiet',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(stdoutText(out)).toContain('Short break');
    expect(countBells(stdoutText(out))).toBeGreaterThan(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('quiet phase change with --no-bell prints the line with zero bells', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '2s',
      '--short',
      '1s',
      '--long',
      '1s',
      '--cycles',
      '4',
      '--quiet',
      '--no-bell',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_500);
    const text = stdoutText(out);
    expect(text).toContain('Short break');
    expect(countBells(text)).toBe(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('--confirm prompt with --no-bell still prompts and advances, silently', async () => {
    vi.useFakeTimers();
    setStdinIsTTY(true);
    const rl = mockReadlineQueue(['y']);
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
      '--confirm',
      '--start',
      'focus',
      '--no-bell',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_200);
    await vi.advanceTimersByTimeAsync(0);
    const combined = `${stdoutText(out)}\n${rl.prompts.join('\n')}`;
    expect(combined).toMatch(/Focus complete\. Start Short break\? \[y\/n\]/);
    expect(stdoutText(out)).toContain('Short break');
    expect(countBells(stdoutText(out))).toBe(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });

  it('live countdown with --no-bell commits history with zero bells', async () => {
    vi.useFakeTimers();
    setStdoutIsTTY(true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runPromise = run([
      '--focus',
      '2s',
      '--short',
      '10s',
      '--long',
      '10s',
      '--cycles',
      '4',
      '--no-bell',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_500);
    const text = stdoutText(out);
    expect(text).toContain('Short break');
    expect(countBells(text)).toBe(0);
    process.emit('SIGINT');
    await expect(runPromise).resolves.toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
  });
});
