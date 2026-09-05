export type ScreenState = 'active' | 'locked';

export type ScreenListener = (state: ScreenState) => void;

export interface ScreenMonitor {
  subscribe(listener: ScreenListener): () => void;
  getInitialState(): ScreenState;
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
}
