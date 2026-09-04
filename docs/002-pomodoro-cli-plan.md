# 002 — Pomodoro CLI Plan

Status: accepted. Grounds the MVP in the current scaffold: `commander` program with
`run(argv) => exit code` + `exitOverride`, single `tsdown` entry (`src/cli.ts` → `dist/cli.js`),
strict ESM TypeScript on Node >= 22, Vitest with `restoreMocks`.

## MVP behavior

- Bare `screen-pomodoro` starts a looping cycle: `focus → short break → … → long break → repeat`.
- Defaults: focus 25m, short 5m, long 15m, long break every 4 focuses.
- Infinite loop by default; `--no-loop` stops after the first long break.
- Auto-advances between phases with a terminal bell + new phase line. No persistence, no history,
  no config file.
- `Ctrl-C` only for exit. No pause/skip keys, no stdin raw mode. `SIGINT` prints a one-line
  summary (`Completed N focuses`), restores the line, exits 0.
- No desktop notifications. Bell + text only.
- `--quiet`: log transitions only (phase start/end), no live countdown. Same default when stdout
  is not a TTY (piped/CI), so logs stay clean.

## State machine

Pure module (e.g. `src/timer.ts`), no I/O, no `node:` imports:

- Phases: `focus | shortBreak | longBreak`. Looping; no terminal state (`--no-loop` is enforced
  by the driver, not the machine).
- Orthogonal pause flag: `paused + pausedReason ('user' | 'screen')`. Pause freezes the countdown
  in place; resume continues the same phase. Core never knows what a screen is — it only exposes
  `pause(reason)` / `resume(reason)`.
- Operations: `start(config) / tick(nowMs) / pause(reason) / resume(reason) / nextPhase()`.
  No `skip()` in MVP.
- Transition: when `remainingMs <= 0`, increment `focusCount` (on leaving focus) and pick the next
  phase — `longBreak` iff `focusCount % cycles === 0`, else `shortBreak` after focus, else `focus`
  after any break. Cadence counts focuses, not wall-clock.
- All math from absolute deadlines (`endsAtMs = nowMs + durationMs`, `remaining = endsAt - now`),
  never a decrementing counter, so event-loop jitter does not accumulate. Pause shifts `endsAtMs`
  forward by the paused duration on resume.

## Timing / display approach

- Default (TTY): driver in `src/cli.ts` (or a tiny `src/run.ts` it calls): `setInterval(~250ms)`
  calls `timer.tick(Date.now())` and re-renders one line via `\r` + `process.stdout.write`.
- Displayed seconds are `ceil(remainingMs / 1000)`, e.g. `Focus 3/4 — 24:59 remaining`.
- On phase change: `\x07` + newline + new phase line, preserving history.
- Quiet mode (`--quiet`, or automatic when stdout is not a TTY): one `setTimeout` per phase, logging
  only phase start / phase change / pause / resume / exit. Same deadline math (`endsAtMs`,
  `remaining = endsAt - now`)
  underneath, so `pause('screen')` is `clearTimeout` + save `remaining` and `resume` re-arms with
  `remaining`. Core `timer.ts` is unchanged; only the driver swaps interval → timeout chain.
  Perf gain is ~6,000 wakeups/writes per 25-min focus → a handful of lines; the win is quiet logs
  and a fully idle process, not CPU.
- Pause/resume logging (both modes): TTY live line appends `(paused — screen locked)` with the
  deadline frozen; quiet mode emits one line each on pause (`Paused — screen locked, timer frozen`)
  and on resume (`Resumed — 12:34 remaining`). No bell for pause/resume; bell stays phase-change only.
  Duplicate events are ignored (pause while paused / resume while running = no-op, no log).
- On `SIGINT`: `clearInterval`, final newline + summary, return exit 0 through the existing `run()`
  contract. `exitOverride` behavior for `--help` / `--version` / usage errors is unchanged.
- Rendering isolated behind a `render(state)` function so tests can spy on
  `process.stdout.write`, following the existing `cli.test.ts` pattern.
- No new dependencies.

## CLI surface

Extends the existing program; keeps `-V/--version` and `-h/--help` as-is. Default action changes
from hello-print to start-timer.

- `--focus <duration>` (default `25`), `--short <duration>` (default `5`),
  `--long <duration>` (default `15`), `--cycles <n>` (default `4`), `--no-loop`,
  `-q, --quiet` (transition-only logging, no live countdown; also the default when stdout is
  not a TTY).
- Duration format: plain number means minutes (`--focus 25`); suffixes `s` / `m` / `h` allowed
  (`90s`, `25m`, `1h`, decimals like `1.5h` allowed). One shared `parseDuration` helper, parsed
  once into a ms `Config` before the timer starts. CLI layer does no countdown math.
- Validation: durations must be positive finite; `cycles` must be an integer >= 1. Invalid input
  is a commander usage error → exit 1 (same contract as the existing unknown-option test).

## File layout

- `src/cli.ts` (existing, only entry): option parsing, `Config` validation, interval driver,
  `SIGINT` handling, single screen-monitor subscription point.
- `src/timer.ts` (new): pure state machine + deadline math + duration parsing.
- `src/screen.ts` (new, types only): the seam. No implementation in MVP.
- `test/timer.test.ts` (new) + extended `test/cli.test.ts`. Coverage stays on `src/**/*.ts`.

## Tests

- `timer.test.ts` — pure, `vi.useFakeTimers` with explicit `nowMs`: phase order over 4 focuses,
  long-break cadence, custom `cycles=2`, `pause` freezes `remaining`, `resume` preserves it,
  `tick` past a deadline advances exactly once, duration parser accepts `25` / `90s` / `1.5h` and
  rejects `0` / `-5` / `abc`.
- `cli.test.ts` — same spy style as today (`console.log`, `stdout.write`, `stderr.write`):
  invalid `--focus 0` → exit 1 + usage on stderr; `--help` / `--version` still exit 0; bare run
  starts the driver and cleans up on `SIGINT` with mocked interval/render (no real sleeping);
  `--quiet` arms a timeout chain and logs transitions + pause/resume only (assert write count, not content).
- `npm run verify` (typecheck + lint + format:check + test + build) stays green. Strict flags
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) mean `Config` fields are required,
  not optional.

## Screen-state seam (interface only, no implementation)

`src/screen.ts` declares only the boundary the MVP depends on:

- A `ScreenState` value distinguishing `active` from `locked`-like, and a `ScreenMonitor`
  subscription shape: `subscribe(listener) => unsubscribe`, plus a one-shot `getInitialState()`.
- A `NoopMonitor` (always `active`, never fires) that the MVP wires in, so the pause path exists
  but never triggers.

Single wiring point in the `cli.ts` driver:
`monitor.subscribe(state => locked ? timer.pause('screen') : timer.resume('screen'))`,
torn down with `unsubscribe + clearInterval` on exit. Future per-OS watchers (macOS workspace
events, Linux dbus, Windows session events) implement `ScreenMonitor` and inject here;
`timer.ts` and its tests do not change. Pause/resume display follows the Timing section: TTY live line
shows `(paused — screen locked)` while frozen; quiet mode logs one line each on pause/resume.

## Decisions (from open questions)

1. Loop forever by default, `--no-loop` opts out — as recommended.
2. `Ctrl-C` only — no interactive keys.
3. No desktop notifications yet — bell + text.
4. Duration suffixes accepted — plain number = minutes plus `s` / `m` / `h`.
5. Long-break cadence counts focuses — yes.

## Open questions

- Exact one-line render wording (phase label, counter, time format) — bikeshed at implementation.
- `--no-loop` exit message wording and whether the final long break still rings the bell.
