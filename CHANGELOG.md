# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-11

### Added

- Exit summary now reports completed short and long breaks alongside focuses (`Completed 2 focuses, 1 short breaks, 0 long breaks`), using custom `--focus-name` / `--short-name` / `--long-name` labels verbatim in their own slots. The terminal long break under a confirm gate now counts like the auto-advance paths do.

## [0.4.0] - 2026-09-10

### Changed

- `--notify-confirm` toast copy states the proposal in the title and uses a verb-first restart button: `<current> complete. Start <next>?` (e.g. `Focus complete. Start Short break?`, with the focus counter when proposing focus) and message `<spent> spent. Click for <next> — <upcoming>, Restart <current> to redo.`, replacing the bare `<current> complete` title and `No` button. Clicking the body still starts the next phase, the `Restart <current>` button still redoes the current one, and resend / unlock-resend / SIGINT-kill semantics are unchanged. A comma in a custom phase name now also splits the restart button label (same documented limit as the startup chooser).

## [0.3.0] - 2026-09-08

### Added

- `--no-bell`: silence the terminal bell (`\x07`) everywhere the driver rings (phase-change lines, terminal long-break summary, pre-prompt rings for `--confirm` / `--notify-confirm` startup and transition prompts). Bell stays on by default; lines, prompts, and `-sound Bottle` are otherwise byte-identical. `--notify --no-bell` gives a single chime instead of terminal ding + `Bottle`.

## [0.2.0] - 2026-09-08

### Added

- `--start <phase>`: open in any phase (`focus`, `short` / `short-break`, `long` / `long-break`). Without a gate the timer auto-flows from there; `--no-loop --start long` runs one long break then exits.
- Startup menu under a confirm gate without `--start`: stdin `--confirm` asks once (`1`/`2`/`3`, `f`/`s`/`l`, phase words, or custom labels; empty = Focus), `--notify-confirm` shows one 3-action toast instead (click = Focus, dismiss re-sends). Explicit `--start` skips the question.
- `--notify-group <id>`: isolate overlapping timers so each keeps its own toasts, prompts, and cleanup (default still shares one group; requires `--notify` or `--notify-confirm`).

### Fixed

- Notifications are screen-lock aware: nothing fires while paused on a locked screen, locking withdraws the visible toast, starting locked freezes before the first toast, and a pending `--notify-confirm` prompt re-sends on unlock so the click still counts exactly once.

## [0.1.0] - 2026-09-07

First release.

### Added

- Pomodoro loop (`Focus → Short break`, `Long break` every `--cycles` focuses) with 25 / 5 / 15 minute defaults and `--no-loop` single-set mode.
- Live countdown and `--quiet` transition-only output, with `--timestamp` history prefixes.
- Automatic pause when the screen locks on macOS (`ioreg` polling, fail-open), with `--no-screen-pause` opt-out.
- `--confirm` stdin gate and custom phase names (`--focus-name`, `--short-name`, `--long-name`).
- macOS desktop notifications via `terminal-notifier`: `--notify` and `--notify-confirm`.
- Runnable via `npx screen-pomodoro`, no install step required.
