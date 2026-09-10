import type * as readline from 'node:readline';

/**
 * Driver seam for phase-transition confirmation. The driver depends on this
 * `confirm(msg)` signature, not on `readline` directly: today it is wired to
 * {@link createStdinConfirmer}, tomorrow a notification-action confirmer can
 * implement the same interface.
 */
export type ConfirmFn = (message: string) => Promise<boolean>;

/**
 * Raw-line asker for the startup phase menu. Resolves the typed line;
 * resolves `undefined` when the interface closes or the driver finishes
 * before an answer (Ctrl-D/EOF, SIGINT cleanup) so the caller can abort
 * instead of leaving its await unsettled. Single-shot: the caller owns
 * re-prompting on unparsable input. Never uses raw mode.
 */
export function createStdinAsker(
  getInterface: () => readline.Interface,
  isFinished: () => boolean,
): (message: string) => Promise<string | undefined> {
  return (message: string) =>
    new Promise<string | undefined>((resolve) => {
      if (isFinished()) {
        resolve(undefined);
        return;
      }
      const iface = getInterface();
      // Same close-guard as the confirmer: a close without an answer
      // (Ctrl-D/EOF, or SIGINT cleanup closing readline) must settle.
      // Guarded for mocked interfaces in tests that only stub
      // question()/close().
      let onClose: (() => void) | undefined;
      const maybeOnce = (iface as unknown as { once?: unknown }).once;
      if (typeof maybeOnce === 'function') {
        onClose = (): void => {
          resolve(undefined);
        };
        try {
          (iface as unknown as { once(event: string, cb: () => void): void }).once(
            'close',
            onClose,
          );
        } catch {
          onClose = undefined;
        }
      }
      iface.question(message, (answer: string) => {
        if (onClose !== undefined) {
          try {
            const maybeOff = (iface as unknown as { off?: unknown }).off;
            if (typeof maybeOff === 'function') {
              (iface as unknown as { off(event: string, cb: () => void): void }).off(
                'close',
                onClose,
              );
            } else {
              const maybeRemove = (iface as unknown as { removeListener?: unknown }).removeListener;
              if (typeof maybeRemove === 'function') {
                (
                  iface as unknown as { removeListener(event: string, cb: () => void): void }
                ).removeListener('close', onClose);
              }
            }
          } catch {
            // Ignore listener-cleanup errors; resolve() stays idempotent.
          }
        }
        resolve(isFinished() ? undefined : answer);
      });
    });
}

/**
 * stdin confirmer: strict `y`/`n` (trimmed, case-insensitive), Enter required
 * via `node:readline` `question()`. Anything else re-prompts with no
 * transition and no restart. Never uses raw mode.
 */
export function createStdinConfirmer(
  getInterface: () => readline.Interface,
  isFinished: () => boolean,
): ConfirmFn {
  return (message: string) =>
    new Promise<boolean>((resolve) => {
      const askOnce = (): void => {
        if (isFinished()) {
          resolve(false);
          return;
        }
        const iface = getInterface();
        // If the interface closes without answering (Ctrl-D/EOF, or
        // SIGINT cleanup closing readline), resolve instead of leaving the
        // pending question — and the driver's top-level await — unsettled.
        // Guarded for mocked interfaces in tests that only stub
        // question()/close().
        let onClose: (() => void) | undefined;
        const maybeOnce = (iface as unknown as { once?: unknown }).once;
        if (typeof maybeOnce === 'function') {
          onClose = (): void => {
            resolve(false);
          };
          try {
            (iface as unknown as { once(event: string, cb: () => void): void }).once(
              'close',
              onClose,
            );
          } catch {
            onClose = undefined;
          }
        }
        const removeCloseListener = (): void => {
          if (onClose === undefined) return;
          try {
            const maybeOff = (iface as unknown as { off?: unknown }).off;
            if (typeof maybeOff === 'function') {
              (iface as unknown as { off(event: string, cb: () => void): void }).off(
                'close',
                onClose,
              );
              return;
            }
            const maybeRemove = (iface as unknown as { removeListener?: unknown }).removeListener;
            if (typeof maybeRemove === 'function') {
              (
                iface as unknown as { removeListener(event: string, cb: () => void): void }
              ).removeListener('close', onClose);
            }
          } catch {
            // Ignore listener-cleanup errors; resolve() stays idempotent.
          }
        };
        iface.question(message, (answer: string) => {
          removeCloseListener();
          if (isFinished()) {
            resolve(false);
            return;
          }
          const normalized = answer.trim().toLowerCase();
          if (normalized === 'y') {
            resolve(true);
          } else if (normalized === 'n') {
            resolve(false);
          } else {
            askOnce();
          }
        });
      };
      askOnce();
    });
}
