# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-07

First release.

### Added

- Pomodoro loop (`Focus → Short break`, `Long break` every `--cycles` focuses) with 25 / 5 / 15 minute defaults and `--no-loop` single-set mode.
- Live countdown and `--quiet` transition-only output, with `--timestamp` history prefixes.
- Automatic pause when the screen locks on macOS (`ioreg` polling, fail-open), with `--no-screen-pause` opt-out.
- `--confirm` stdin gate and custom phase names (`--focus-name`, `--short-name`, `--long-name`).
- macOS desktop notifications via `terminal-notifier`: `--notify` and `--notify-confirm`.
- Runnable via `npx screen-pomodoro`, no install step required.
