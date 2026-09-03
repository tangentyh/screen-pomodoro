import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';

function outputOf(spy: { mock: { calls: (readonly unknown[])[] } }): string {
  return spy.mock.calls.map((call) => call.map((arg) => String(arg)).join(' ')).join('\n');
}

describe('cli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints a hello message and exits 0 by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(run([])).resolves.toBe(0);
    expect(outputOf(log)).toContain('screen-pomodoro');
  });

  it('prints help and exits 0', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--help'])).resolves.toBe(0);
    expect(outputOf(out)).toContain('Usage:');
  });

  it('prints the version and exits 0', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(run(['--version'])).resolves.toBe(0);
    expect(outputOf(out)).toContain('0.1.0');
  });

  it('exits 1 with a usage error for unknown options', async () => {
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run(['--nope'])).resolves.toBe(1);
    expect(outputOf(errOut)).toContain('unknown option');
  });
});
