# 003 — Confirm Gate + Phase Names

Status: accepted. Extends `002-pomodoro-cli-plan.md`. All sign-offs (A1–D4) confirmed.

## Goals

1. `--confirm`: opt-in gate on phase transitions. On deadline, ask `y/n`; `y` = advance, `n` = stay (full restart of current phase).
2. `--focus-name / --short-name / --long-name`: custom labels used in all stdout output and reusable by future monitors (notifications, etc.).

## Non-goals

- No per-transition granularity, no snooze durations, no config file, no persistence.
- No change to `src/timer.ts` deadline math (absolute `endsAtMs`).
- No stdin raw mode / single-keypress handling — keeps the `002` constraint (`Ctrl-C` only, line-buffered input). Uses `node:readline` `question()` (Enter-required), so the existing `setRawMode never called` test keeps passing.

## CLI surface

- `--confirm`: boolean, default off. `Awaits y/n on each phase transition (requires interactive stdin).`
- `--focus-name <name>` (default `Focus`), `--short-name <name>` (default `Short break`), `--long-name <name>` (default `Long break`).
- Name validation (usage error, exit 1, same contract as duration/cycles errors):
  - `trim()` must be non-empty; max 40 chars.
  - Reject `\r \n \t \x07` with a clear message.
  - Emoji/spaces allowed.
- Startup guard: `--confirm` + `!process.stdin.isTTY` → `program.error('--confirm requires an interactive terminal')`, exit 1. Prevents CI hangs. Future notification confirmer (see Architecture) can relax this by providing a non-stdin source.

## Confirm behavior

Prompt (both live and quiet modes):

```
\x07
<current> complete. Start <next>? [y/n]
```

E.g. `Deep work complete. Start Coffee? [y/n] ` (names resolved via `phaseLabel`).

- Input: only `y` / `n` (trimmed, case-insensitive). Everything else (`yes`, `no`, empty, `yy`, …) re-prompts with no transition and no restart.
- `y`: advance exactly one phase via existing transition (`timer.tick(now)` / `nextPhase`), counting a focus iff leaving `focus`. Then print the new phase line (no second bell).
- `n`: full restart of current phase: `endsAt = now + duration(current)`, `focusCount` unchanged. Then print the current phase line. No bell.
- Bell: single `\x07` immediately before the prompt only. Silent on `y`-advance, `n`-restart, and re-prompts. The prompt is the one place that genuinely needs attention.
- Overshoot: one deadline → one prompt → one `y` = one phase (matches `tick` advances-exactly-once). Sources: event-loop stall / laptop sleep delaying the 250ms interval or quiet `setTimeout`, and test time jumps (`advanceTimersByTimeAsync`). After `y`, recompute `remaining` from the new `endsAtMs`; if already expired, prompt again rather than cascading.
- Screen lock while awaiting answer: countdown already frozen, `pause('screen')` is a no-op; the answer still wins.
- `Ctrl-C` / `Ctrl-D` while prompting: existing SIGINT path — close `readline`, clear timers, remove SIGINT listener, print `Completed N <summary-name>`, exit 0.
- `--no-loop` terminal exit (leaving `longBreak` → would exit): skip confirm, print summary + exit directly.

## Naming behavior

Display-only `PhaseNames` (`{ focus, shortBreak, longBreak }`). Lives in `src/cli.ts` (or a tiny `src/display.ts`). Never enters `PomodoroConfig` / `timer.ts` — core stays phase-enum-only and `node:`-free.

| Location                     | Format                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus line                   | `<focus-name> N/M — m:ss remaining` (counter only on focus)                                                                                                                                     |
| Break line                   | `<name> — m:ss remaining`                                                                                                                                                                       |
| Live paused                  | `<phase line> (paused — screen locked)` (name included via phase line)                                                                                                                          |
| Quiet pause                  | `Paused <name> — screen locked, timer frozen`                                                                                                                                                   |
| Quiet resume                 | `Resumed <name> — 12:34 remaining`                                                                                                                                                              |
| Confirm prompt               | `<current> complete. Start <next>? [y/n]` (both sides resolved)                                                                                                                                 |
| SIGINT / `--no-loop` summary | Default focus name → `Completed N focuses` (special-case preserves today's wording). Custom `--focus-name` → verbatim `Completed N <focus-name>`, no inflection (e.g. `Completed 3 Deep work`). |

Refactor: `phaseLabel(phase, names)` + `buildPhaseLine(timer, config, names, nowMs)`. Future monitors (desktop notifications, etc.) must reuse these helpers, never hardcode `Focus`.

## Architecture (`src/cli.ts` driver only)

- No `timer.ts` change.
- Driver depends on a `confirm(msg): Promise<boolean>` seam, not on `readline` directly. Current impl is `stdinConfirmer` (`rl.question` loop). A future `notifConfirmer` (notification action buttons = `y/n`) implements the same interface; driver picks stdin if TTY else notif if available else fail-fast.
- Confirm-pending state: suspend timers on deadline (`clearInterval` tick rendering in live mode; `clearTimeout` chain in quiet mode), `await ask(...)`, then commit (`y`) or restart (`n`) and resume timers.
- `readline.Interface` created lazily on first prompt, closed in `finish()` / `onSigint`.
- `finish()` / `onSigint` also clear timers, remove SIGINT listener, close `readline`.

## Tests

Follow `test/cli.test.ts` patterns: `vi.useFakeTimers`, spy `stdout.write`, `defineProperty(process.stdout, 'isTTY')`, assert SIGINT listener cleanup. Mock `readline` / inject `ask` — never block on real stdin.

Naming:

- Defaults unchanged: bare run still prints `Focus 1/4`, `Short break`.
- Custom names appear in live first line, quiet first line, bell phase-change line, paused suffix, quiet pause/resume lines, confirm prompt, summary.
- Validation: `--focus-name ""`, whitespace-only, embedded newline, >40 chars → exit 1 + stderr matches `/name|empty|invalid/i`.
- `timer.test.ts` untouched; purity test still passes.

Confirm:

- `y` advances one phase, increments `focusCount` only when leaving focus; `n` restarts same phase, count unchanged, deadline reset to full duration.
- Invalid input re-prompts without transitioning (question called 2×, phase unchanged).
- Case-insensitivity: `Y` / `N` work; `yes` / `no` / empty re-prompt.
- Both live and quiet branches suspend timers while pending (no extra ticks / no re-arm until answered).
- `--confirm` + `stdin.isTTY === false` → exit 1 fast, driver never starts.
- SIGINT while pending → `rl.close` called, timers cleared, listener count restored, summary printed, exit 0.
- `setRawMode` still never called.
- `--no-loop` + `--confirm`: full cycle exits without a trailing prompt.

## Docs / help

- `--help` lists `--confirm` and the three `--*-name` options.
- README CLI block + example confirm transcript.
- This doc supersedes the "`Ctrl-C` only" line in `002` for opt-in confirm.

## Implementation order

1. Naming (isolated, no stdin, low risk): `PhaseNames` + options + `phaseLabel` / `buildPhaseLine` refactor → tests → README/`--help`.
2. Confirm (stateful driver change): `--confirm` + `ask()` seam + suspend/resume in live + quiet paths + `finish()` cleanup → mocked-readline tests → README transcript.
3. `npm run verify` (typecheck + lint + format:check + test + build) green.

## Decision log (sign-offs A1–D4)

- A1: `--confirm`, `--focus-name`, `--short-name`, `--long-name` ✅
- A2: non-empty-after-trim, reject control chars, max 40, exit 1 ✅
- A3: `--confirm requires an interactive terminal` fail-fast now; `confirm()` seam admits a future notif source ✅
- B1: `<current> complete. Start <next>? [y/n]` ✅
- B2: single bell before prompt only ✅
- B3: `Ctrl-C`/`Ctrl-D` while prompting → SIGINT path ✅
- B4: screen lock while pending = no-op ✅
- B5: one prompt per phase, re-prompt if still expired ✅
- C1: counter focus-only ✅
- C2: live paused line keeps name via phase line ✅
- C3: `Paused <name> — …` / `Resumed <name> — …` ✅
- C4: default `Completed N focuses`; custom verbatim `Completed N <focus-name>` ✅
- C5: emoji/spaces allowed, control chars rejected ✅
- D1: driver-only, `timer.ts` pure ✅
- D2: mocked-readline + fake-timer test plan ✅
- D3: this doc + README/`--help` ✅
- D4: naming first, confirm second ✅
- Prior locks: `n` = full restart; strict `y/n` + re-prompt; `--no-loop` exits directly.
