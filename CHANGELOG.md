# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
