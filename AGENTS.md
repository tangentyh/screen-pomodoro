# AGENTS.md

## What this is

`screen-pomodoro` — tiny CLI pomodoro timer (strict ESM TypeScript, Node ≥ 22, `commander`, Vitest). Loops focus → breaks, pauses on screen lock, with `--confirm` gate, custom phase names, `--quiet` mode. CLI surface is in `README.md`; binding designs in `docs/000-index.md`.

## Layout

- `src/cli.ts` — thin entry (`run`/`main`), display + back-compat re-exports. All `../src/cli.js` test imports keep working.
- `src/program.ts` — commander option parsing/validation, wires to driver.
- `src/driver.ts` — pomodoro driver (live/quiet loops, confirm flow, screen-pause, wake-jump guard, SIGINT). All I/O lives here.
- `src/confirm-stdin.ts` — stdin `y/n` confirmer (`ConfirmFn` seam).
- `src/timer.ts` — pure state machine, no `node:` imports.
- `src/display.ts` — all user-visible text. Reuse it, never hardcode phase names.
- `src/screen.ts` — `ScreenMonitor` seam (currently a no-op; real watchers inject here).
- `test/` mirrors `src` (`cli`, `confirm`, `names`, `screen`, `timer`). `dist/` is tsdown output.

## Gotchas

- `--quiet` is automatic when stdout isn't a TTY — output differs under pipes/CI.
- `run(argv)` returns the exit code (`exitOverride`); usage errors exit 1, `SIGINT` prints a summary and exits 0.
- Stdin is line-buffered `readline.question()` — never `setRawMode` (a test asserts this).
- `\x07` bell on phase change/prompt only, never on pause/resume.
- Tests use fake timers with explicit `nowMs`, spy `stdout.write`, mock `readline`/exec — never real stdin or spawned binaries.

## Conventions

- Read the relevant record in `docs/000-index.md` before changing that area.
- Done = `npm run verify` green (same gate CI runs).
