# 007 — No Toast on a Locked Screen

Status: accepted. Amends 004 Behavior/D8 + pending-kill inventory, 005 D5 +
`confirmPending` edge: nothing is ever _fired_ while the countdown is frozen
on a locked screen, nothing lingers there, and a `--notify-confirm` decision
owed across a lock stays answerable via an unlock re-send.

## Goals

1. No `terminal-notifier` delivery — fire-and-forget _or_ blocking prompt —
   is ever sent while the timer is paused on a locked screen: not at
   startup, not at transitions. Skipped toasts are not queued; the shared
   `-group` means the next entry's toast replaces in place, so nothing is
   lost and nothing stacks.
2. No toast lingers on the lock screen: the lock transition withdraws
   whatever fired in the poll gap just before the lock was noticed
   (best-effort `-remove`, ignored on failure).
3. A `--notify-confirm` prompt owed across a lock stays decidable: the
   pending toast is not re-prompted _into_ the lock, and unlock re-sends
   the identical toast so the click still counts exactly once. The answer
   still wins (003 B4) — a raced click is never misread.
4. No new flags, no new strings, no `timer.ts` changes. Stdin `--confirm`
   behavior unchanged (its prompt lives in terminal history, nothing to
   re-show).

## Non-goals

- No fresh-probe-before-transition on expiry. An `ioreg` probe per phase
  change closes the ≤1-poll race completely, but it broke hermetic tests
  (real spawns on every transition) for marginal gain over withdraw — V1
  keeps the documented poll-staleness model (005 Non-goals).
- No stdin prompt re-print on unlock (history already shows it; an extra
  line carries no new information).
- No second concurrent toast for the resend (ambiguous answer ownership).

## Behavior

- `--notify` sends iff the timer is not paused at send time — startup and
  every transition alike (004 D8's startup toast is skipped when starting
  locked). The `Paused` history line remains the source of truth while
  locked; the deferred transition (line + bell + toast) lands together
  after unlock.
- Lock transition, both modes: alongside the `Paused` line, best-effort
  `-remove screen-pomodoro` (guarded to notify runs; silent on failure).
- Startup applies `monitor.getInitialState()` _before_ notifying/arming:
  start-while-locked freezes immediately (birth line, then `Paused`, no
  toast; live does not arm the 250ms tick — unlock re-arms it). No-op when
  active or opted out: the real backend's initial state is always active,
  so the first poll still corrects a true start-while-locked within
  `POLL_MS`, and the withdraw covers the interim toast. Amends 005 D5's
  "no driver startup ceremony" line.
- Unlock with a `--notify-confirm` toast pending: kill the waiting child;
  the confirmer re-sends the identical argv (same `-group`, replaces in
  place) with no extra bell and no stderr note. The post-unlock click/`No`
  counts exactly once; a second prompt is never opened. Lock with a prompt
  pending still opens nothing into the lock and repeats no bell — amends
  005's "lock while `confirmPending`: no-op" edge (the _decision_ is still
  a no-op; only the _toast visibility_ is restored on unlock).
- Stdin `--confirm` pending across a lock: fully silent both ways, as
  before — answer after unlock.

## Architecture

Driver + one confirmer option, no new modules:

- `notifyEntered` bails when `timer.paused` (covers startup, transitions,
  and post-`y` sends alike — the tick paths already bail while paused, so
  this is the last line, not the first).
- `onScreenState` records the raw lock edge _ahead of_ the
  `finished`/`confirmPending` guard, then: locked → `removeToast()` after
  pausing; unlock edge → `requestConfirmResend()` (no-ops unless a
  notification prompt is actually pending with a live child — so stdin
  confirms, idle timers, and finished runs never touch a child).
- `createNotificationConfirmer` gains `consumeResendRequest: () => boolean`
  (return-and-clear): a spawn error with a request outstanding re-sends
  instead of resolving `false`; a successful answer clears a request that
  raced the click, so a later prompt's genuine failure still resolves
  `false` with a note (never spins). `isFinished` still wins first, so the
  SIGINT kill path is unchanged. Pending-kill inventory is now two: exit
  (`finish()`) and unlock-resend (pending only).

## Edge cases

- Banner vs Alert: the resend matters most for Banners (auto-dismiss leaves
  no clickable toast); Alerts just get replaced in place plus a re-chime.
- Rapid lock↔unlock while pending: one resend per unlock edge —
  transitions are diff-then-fire and probes never fan out while
  `confirmPending`, so no pile-up.
- Click racing the unlock kill: the answer wins and the stale request is
  dropped; a kill that finds no child is a no-op (never a lost yes, never
  a phantom no).
- `--no-screen-pause`: edges ignored entirely, including an
  initially-locked monitor (opt-out runs through deadlines as before).
- Terminal long-break exit fires no prompt and no toast — unchanged
  (004/003); answering a prompt whose phase already ended follows existing
  gate math.
- SSH headless delivery failure (004 exit 4) is orthogonal: it resolves
  `false` with a note at answer time, never a resend.

## Tests

Follow the stub-monitor + mocked-`execFile` patterns (never a real spawn,
never real stdin) — `run(argv, { monitor: stub })` exercises both seams
at once:

- `test/notify-cli.test.ts` (mocked binary, stub monitor): lock at expiry
  sends no new toast (startup toast withdrawn via `-remove`), unlock
  delivers the transition toast with line + bell; starting locked sends
  zero toasts and freezes; pending `--notify-confirm` toast survives the
  lock unanswered (1 send, 1 bell), unlock re-sends identical argv
  silently, post-unlock click advances exactly once. Manual mock's
  `-action` child is killable (SIGTERM → spawn error) so the resend and
  SIGINT kills stay observable.
- `test/notify.test.ts` (unit): kill-with-request re-sends silently and
  resolves the click; a raced answer drops the stale request so a later
  genuine failure still resolves `false` with a note.
- `test/screen-driver.test.ts` (no notify): start-while-locked freezes
  immediately in quiet (birth + `Paused`, frozen clock) and live (no 250ms
  tick armed until unlock); opt-out ignores an initially-locked monitor.

## Docs / help

- No `--help` change (no new flag).
- README macOS notifications: `--notify` toasts skip while locked (nothing
  queued — the next entry replaces in place); lock withdraws the visible
  toast; `--notify-confirm` re-sends the pending toast on unlock.
- README Screen lock: start-while-locked freezes before the first poll;
  pending notification prompt re-sends on unlock (stdin prompt just waits).

## Alternatives considered

- **Probe-before-transition on every expiry:** rejected — correct in
  theory, but a real `ioreg` spawn per phase change broke hermetic tests
  and bought little over withdraw for a ≤2s race.
- **Leave the pending toast un-resent (pure no-op):** rejected — Banner
  toasts can be gone by unlock, stranding the timer behind an invisible
  prompt with no affordance to answer.
- **Withdraw the pending prompt on lock without resend:** rejected — same
  stranding, self-inflicted.
- **Re-print the stdin prompt on unlock:** rejected — terminal history
  already shows it.

## Decision log

- [x] D1: never _send_ while paused (`notifyEntered` guard) + withdraw on
      lock (`-remove`) — no probes, no new I/O in the steady state.
- [x] D2: startup applies `getInitialState()` before notify/arm (amends
      005 D5) — immediate freeze instead of a ≤1-poll toast window.
- [x] D3: unlock re-sends a pending notification prompt via a
      driver-owned kill + confirmer handshake (identical argv, silent,
      exactly-once); stdin path untouched.
- [x] D4: handshake is return-and-clear with success-clear, `isFinished`
      first — a raced click wins, a later genuine failure still fails
      closed to `false`, never spins.
