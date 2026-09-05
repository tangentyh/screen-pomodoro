import { describe, expect, it, vi } from 'vitest';
import {
  NoopMonitor,
  type ScreenListener,
  type ScreenMonitor,
  type ScreenState,
} from '../src/screen.js';

// Seam per docs/002-pomodoro-cli-plan.md (TDD red phase — src/screen.ts missing):
//   - ScreenState distinguishes 'active' from locked-like states
//   - ScreenMonitor = { subscribe(listener) => unsubscribe, getInitialState() }
//   - NoopMonitor is always 'active' and never fires; the MVP wires it in so the
//     pause path exists but never triggers.

describe('screen seam', () => {
  it('NoopMonitor starts active', () => {
    const monitor: ScreenMonitor = new NoopMonitor();
    const initial: ScreenState = monitor.getInitialState();
    expect(initial).toBe('active');
  });

  it('NoopMonitor never fires its listener', async () => {
    vi.useFakeTimers();
    try {
      const monitor = new NoopMonitor();
      const listener = vi.fn<(state: ScreenState) => void>();
      const unsubscribe = monitor.subscribe(listener satisfies ScreenListener);
      expect(typeof unsubscribe).toBe('function');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribe is idempotent and stops future notifications', () => {
    const monitor = new NoopMonitor();
    const listener = vi.fn<(state: ScreenState) => void>();
    const unsubscribe = monitor.subscribe(listener);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers without firing', async () => {
    vi.useFakeTimers();
    try {
      const monitor = new NoopMonitor();
      const a = vi.fn<(state: ScreenState) => void>();
      const b = vi.fn<(state: ScreenState) => void>();
      const unsubA = monitor.subscribe(a);
      const unsubB = monitor.subscribe(b);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
      unsubA();
      unsubB();
    } finally {
      vi.useRealTimers();
    }
  });
});
