# Design records

Accepted records are binding — follow them, don't relitigate. Proposed records are drafts, not implemented. Later records amend earlier ones, so follow the chain instead of reading 002 alone.

- `001-toolchain-decisions.md` (accepted) — build/lint/test stack and deferred alternatives.
- `002-pomodoro-cli-plan.md` (accepted, amended by 003) — timer state machine, live vs quiet driver, screen-monitor seam. Its "`Ctrl-C` only" and "no notifications" lines are superseded (see 003/004).
- `003-confirm-and-names.md` (accepted, incl. amendment 003a frozen gating) — `--confirm` gate math, phase-name rules.
- `004-desktop-notifications-macos.md` (accepted) — macOS `--notify` / `--notify-confirm` via `terminal-notifier`, extends 003.
