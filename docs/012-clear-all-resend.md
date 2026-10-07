# 012 — Clear All Re-sends a Pending Confirm Toast

Status: accepted. Amends 004 Behavior (dismiss → re-send) and 007 D3: a
`--notify-confirm` toast removed in bulk by Notification Center's **Clear All**
is re-sent, exactly like a single dismiss, instead of stranding the timer
behind an invisible prompt. `--notify` fire-and-forget is untouched.

## Goals

1. A pending `--notify-confirm` prompt survives "Clear All": the timer must
   never wait on a toast the user can no longer see or click.
2. Same semantics as a single dismissal (004): re-send the identical argv to
   the same `-group`, silently (no second bell, no stderr note), exactly once
   per removal. The click mapping and gate math are unchanged.
3. Detection rides the existing 007 resend handshake — no new flag, no new
   dependency, no change to `timer.ts`.

## Non-goals

- **No `--notify` (fire-and-forget) resend.** That mode has no blocking child
  and no answer to protect; re-posting after an explicit Clear All would fight
  the user (a poll loop with no acknowledgement). The next transition's toast
  already replaces the cleared one in place. If a persistent, answerable
  current-phase reminder is wanted, that is `--notify-confirm`, which this
  record fixes.
- **No watchdog for the 009 startup chooser** (blocking 3-way menu without
  `--start`). It is a one-shot prompt answered while the user is at the
  keyboard; the per-transition prompt is the one that can outlive a
  walk-away. Revisit if it bites.
- No `-timeout` on the prompt (004 keeps waiting indefinitely), no polling in
  the steady state (only while a confirm child is actually pending).

## Ground truth (verified locally 2026-10-07, `terminal-notifier` 3.0.0, macOS 15.8.1)

- `-list <group>` (README: "List delivered notifications in the `ID` group")
  prints a header row plus one row per delivered notification, and prints
  **nothing** once the group is empty. It is backed by
  `getDeliveredNotifications`, so it reflects Notification Center exactly.
- An externally removed toast (`terminal-notifier -remove <group>`, the same
  removal Clear All performs) does **not** unblock a waiting `-action` child:
  the child stayed alive and only exited `@TIMEOUT` (exit 6) because the probe
  passed `-timeout 25`. Production passes no `-timeout`, so the child waits
  **forever**. Clear All is a bulk removal that skips the dismiss delegate
  (the documented `@CLOSED` path is a per-toast swipe/X only), which is why
  004/011 re-send on `@CLOSED` but Clear All strands the prompt.

## Behavior

- While a `--notify-confirm` transition prompt is pending (a live `-action`
  child exists), the driver probes `terminal-notifier -list <group>` every
  `CLEAR_POLL_MS` (3000 ms).
- Empty output counts as one miss; **two consecutive** misses are required
  before acting, so the just-posted toast cannot race the first poll. A
  non-empty probe resets the counter.
- On a confirmed miss the driver sets the 007 resend request and kills the
  waiting child; the confirmer consumes the request and re-sends the identical
  toast (`-group` replaces in place). No new bell, no stderr note.
- A failed probe (binary gone, permission exit 3, no-GUI exit 4) is
  **unknown**, not "cleared": it resets the counter and never resends. A
  delivery problem must not turn into a resend loop.
- Probes are skipped while `screenLocked` is true (007: nothing fires on a
  locked screen) and whenever no child is pending. The unlock edge already
  re-sends via the same handshake; the watchdog resumes with it.
- The watchdog is armed only for the transition confirmer and torn down when
  the prompt settles (answer, SIGINT, exit).

## Architecture

Two small additions, no new modules and no new I/O in the steady state:

- `src/notify.ts`: `isNotificationDelivered(exec, group)` — runs
  `terminal-notifier -list <group>` through the injectable `ExecFileFn` and
  returns `stdout.trim().length > 0`. Rejects on exec failure so callers can
  treat the answer as unknown. argv stays in `notify.ts` per 004.
- `src/driver.ts`: `CLEAR_POLL_MS`/`CLEAR_POLL_MISSES` constants, a
  `startClearWatchdog`/`stopClearWatchdog` pair and a `pollDelivered` probe
  that calls the existing `requestConfirmResend()`. Armed around the
  `await confirmer(message)` in `runConfirmFlow`; stopped in `finish()`.
  Reuses 007's `confirmResendRequested` + `pendingChild` (no second handshake).

## Edge cases

- First poll before macOS registers the toast: two-miss debounce.
- Repeated Clear All: one resend per pair of misses, same as repeatedly
  dismissing (004 already re-prompts on every dismissal).
- Clear All while locked: skipped (`screenLocked` guard); unlock re-sends
  through the 007 path regardless.
- `--no-screen-pause`: `screenLocked` is never set (edges ignored per 007), so
  the probe still guards a prompt; a lock without pause leaves the child
  pending, and a real empty `-list` may resend — acceptable for the opt-out.
- Answer racing a resend kill: unchanged from 007 — the answer wins, the stale
  request is dropped, a kill with no child is a no-op.
- Probe failure (SSH/headless, permission): unknown, never resends; the
  prompt still resolves `false` on the child's real delivery failure.
- Older `terminal-notifier` without `-list`: the probe rejects, is treated as
  unknown, and the timer behaves exactly as before 012 (no regression).

## Tests

- `test/notify.test.ts`: `isNotificationDelivered` — `-list <group>` argv,
  non-empty → true, empty → false, exec failure rejects.
- `test/notify-cli.test.ts` (mocked binary): the mock handles `-list` with a
  `setListPresent(bool)` toggle. Clear All re-sends the identical argv once
  `-list` confirms the group is gone (no extra bell); a single empty probe
  does not resend and a later non-empty probe resets the counter; a failed
  probe never resends and logs nothing. The 007 lock test now clears the list
  while locked and still asserts no resend until unlock.

## Docs / help

- No `--help` change (no new flag).
- README macOS notifications: note that clearing the toast (including
  Clear All) re-sends the pending prompt, same as dismissing it.
- This doc is the design record; 000-index lists it.

## Alternatives considered

- **`-timeout N` + re-send on `@TIMEOUT`:** rejected — re-sends (and re-chimes)
  on a timer even while the toast is visibly present; 004 chose to wait
  indefinitely. The probe only resends when the toast is actually gone.
- **Poll `-list ALL`:** rejected — same cost, but a stale toast from another
  group could mask ours; the per-group query is the precise question.
- **Re-send on the first empty probe:** rejected — the post-toast registration
  race would re-post a duplicate-looking toast at prompt time.
- **Watchdog inside `createNotificationConfirmer`:** rejected — the child
  handle (and therefore the kill) is driver-owned; keeping the poll in the
  driver reuses 007's single handshake and keeps `notify.ts` free of timers.
- **Also resend `--notify` toasts:** rejected — no acknowledgement exists, so
  it becomes a fight with Clear All; see Non-goals.

## Decision log

- [x] D1: probe `-list <group>` while a confirm child is pending; empty for
      two consecutive probes ⇒ reuse 007's resend handshake.
- [x] D2: failed probe is unknown (never resend); locked and no-child states
      skip. No steady-state I/O.
- [x] D3: `--notify` and the 009 startup chooser are out of scope.
