# Design records

Accepted records are binding — follow them, don't relitigate. Proposed records are drafts, not implemented. Later records amend earlier ones, so follow the chain instead of reading 002 alone.

- `001-toolchain-decisions.md` (accepted) — build/lint/test stack and deferred alternatives.
- `002-pomodoro-cli-plan.md` (accepted, amended by 003) — timer state machine, live vs quiet driver, screen-monitor seam. Its "`Ctrl-C` only" and "no notifications" lines are superseded (see 003/004).
- `003-confirm-and-names.md` (accepted, incl. amendment 003a frozen gating) — `--confirm` gate math, phase-name rules.
- `004-desktop-notifications-macos.md` (accepted) — macOS `--notify` / `--notify-confirm` via `terminal-notifier`, extends 003.
- `005-screen-lock-macos.md` (accepted) — pause-on-lock via `ioreg` polling on macOS (`PollingMonitor` + `probeNow` + wake-jump guard, `--no-screen-pause` opt-out); implements 002's seam, Linux/Windows stay on `NoopMonitor`.
- `006-live-pause-history.md` (accepted) — live keeps the in-place paused suffix and also leaves the `Paused`/`Resumed` pair in scrollback; amends 002 Timing, 003 table, 005 G1.
- `007-no-toast-on-locked-screen.md` (accepted) — nothing fires or lingers on a locked screen; pending `--notify-confirm` toast re-sends on unlock; amends 004 Behavior/D8 + kill inventory, 005 D5 + `confirmPending` edge.
- `008-overlapping-notifications.md` (accepted) — opt-in `--notify-group <id>` isolates overlapping timers; default group unchanged; amends 004 D3.
- `009-start-phase.md` (accepted) — `--start <phase>` opens in any phase; a confirm gate (`--confirm` or `--notify-confirm`) without `--start` asks once at startup (stdin empty = Focus; toast click = Focus); explicit `--start` skips; amends 003/004.
- `010-no-bell.md` (accepted) — opt-in `--no-bell` silences the terminal bell (`\x07`) everywhere; default rings; `-sound Bottle` untouched; amends 004 D3.
