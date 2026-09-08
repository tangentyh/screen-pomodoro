# 009 — Starting Phase (`--start` + Startup Menu)

Status: accepted. Amends 003 (confirm prompts were transition-only;
startup never asked) and 004 (`--notify-confirm` was transition-only)
and extends `timer.start` with an additive optional
phase. No change to deadline math, pause/resume, or notification delivery.

## Goals

1. `--start <phase>`: open the run in any phase, so a break can come
   first and gate into the first focus via the existing confirm flow
   (`Short break complete. Start Focus? [y/n]` → `Focus 1/4`).
2. No-flag path: with a confirm gate (`--confirm` or `--notify-confirm`)
   and no `--start`, ask once at
   startup instead of silently assuming focus — the flag stays as the
   skip-the-question fast path (aliases, scripts).

## Non-goals

- No change to the transition confirm flow, phase-name rules, deadline
  math, or screen-pause semantics. `focusCount` still starts at 0, so the
  first focus after an opening break is `1/M` and break→focus never counts.
- No per-run persistence of the choice, no config file.

## CLI surface

- `--start <phase>`: `focus`, `short`, `long` (case-insensitive) plus
  `short-break` / `long-break` aliases (dashes, underscores, spaces
  ignored). No commander default — absent means "driver decides" (menu or
  focus per the matrix below), which is why `--help` shows no
  `(default: …)` for it.
- Validation (usage error, exit 1, same contract as duration/cycles
  errors): anything else → `invalid --start …: expected one of focus,
short, long (aliases short-break, long-break)`.
- Resolution matrix:

  | `--start` | gating             | startup                             |
  | --------- | ------------------ | ----------------------------------- |
  | given     | any                | starts there, no question           |
  | omitted   | stdin `--confirm`  | asks once (empty = Focus)           |
  | omitted   | `--notify-confirm` | asks once via toast (click = Focus) |
  | omitted   | none               | focus, no question                  |

## Menu behavior

Stdin menu (`--confirm`, both live and quiet, before the first phase line):

```
Choose starting phase: 1) Focus 2) Short break 3) Long break [1]
```

Both sides resolve custom names (`2) Coffee`). Accepted answers
(trimmed, case-insensitive): empty → focus; `1`/`2`/`3`, `f`/`s`/`l`;
the `--start` word forms; the current custom labels. Anything else
(including `y`) re-prompts with no transition and no restart.

Notify menu (`--notify-confirm`, same point in startup): one blocking
toast with three actions (custom-name aware, bare labels):

- argv: `-group <group> -sound Bottle -title <title> -message
<message> -action <focusLabel> -action <shortLabel> -action
<longLabel>` — repeated `-action` (not comma-joined), per the
  `terminal-notifier` contract (`-action TITLE`: repeat or pass a comma
  separated list for several; one action draws a plain button, several
  collapse into an Options menu; the outcome prints on stdout).
- `title = Choose starting phase`; `message = Start <focusLabel> —
<focusDur>, <shortLabel> — <shortDur>, or <longLabel> — <longDur>?
Click = <focusLabel>` (nominal `config` durations via `formatClock`,
  004 D7 parity — pause/gating never inflate them; labels verbatim).
- Mapping (trimmed): button title → `parseStartChoice(title, names)`
  (same collision order as stdin: digits/letters, then `--start` words,
  then custom labels focus→short→long); `@ACTIONCLICKED` (body click) →
  focus (parity with stdin empty = Focus); `@CLOSED`/`@TIMEOUT` → re-send
  the same toast (same `-group`, replaces in place; parity with stdin
  invalid-input re-prompt and 004 D2); anything else / spawn error →
  focus + stderr note (fallback to the old default, never spins; parity
  with 004 D4 resolves-`false`); `isFinished` → `undefined` (abort via
  the existing SIGINT path).
- Known limit: a comma inside a custom phase name splits into extra
  buttons (`terminal-notifier` comma-splits every `-action` value with no
  escaping); colliding custom labels resolve in `parseStartChoice` order.

- Bell: single `\x07` before the first menu prompt / toast only; re-prompts
  and re-sends stay
  silent (transition parity, 003 B2).
- `--timestamp` stamps the stdin menu prompt like transition prompts;
  the toast carries no stamp (the OS timestamps those).
- First deadline anchors to the answer moment: menu dwell never eats into
  phase 1 (startup parity with frozen gating, 003 E1).
- `Ctrl-C` / `Ctrl-D` during the menu takes the existing SIGINT path —
  `Completed 0 focuses`, exit 0 (003 B3); a pending chooser child is
  killed like a pending transition confirmer.
- `--no-loop --start long` runs one long break then exits with
  `Completed 0 focuses`; the terminal-break rule is unchanged.

## Architecture

- `src/timer.ts` (pure, still `node:`-free): `start(nowMs, initialPhase
= 'focus')` anchors `endsAtMs` via the existing `durationForPhase`
  lookup; new pure `parseStartPhase(raw)` (throws, CLI contract).
- `src/display.ts`: new pure `parseStartChoice(raw, names)` returning
  `Phase | undefined` (digits/letters → `--start` words → custom labels;
  digits/letters win single-letter collisions by documentation).
- `src/confirm-stdin.ts`: new `createStdinAsker` seam (single-shot raw
  line, resolves `undefined` on close/finish; caller owns re-prompting).
  Same close-guard as the confirmer so mocked `question()/close()`-only
  interfaces keep working.
- `src/driver.ts`: startup is now a short async preamble — SIGINT is
  registered before the menu, the monitor subscribes after it (lock
  during either menu is therefore impossible; the start-while-locked freeze
  still applies post-menu), and `unsubscribe` is noop-until-assigned so
  SIGINT-during-menu settles safely. `confirmPending` is held during
  either menu so the prompt owns the line for SIGINT framing (the toast
  menu kills its pending child on SIGINT like a transition prompt). The wake-jump
  baseline (005 D6) resets past menu dwell.
- `src/notify.ts`: new `buildNotifyStartTitle/Message` builders plus a
  `createNotificationStartChooser` seam (`(message) =>
Promise<Phase | undefined>`) implementing the mapping above over the
  same injectable `ExecFileFn` (argv array only, never a shell).
- `src/program.ts`: `--start` has no commander default; `undefined`
  passes through `DriverFlags.startPhase?` (now `Phase | undefined` under
  `exactOptionalPropertyTypes`).

## Edge cases

- Screen lock during either menu: no subscription yet, nothing to pause;
  unlock needs no resend (no lock-time `-remove` pre-subscription, so the
  toast stays; stdin has nothing to re-show).
- Menu answer delay then lock before first tick: covered by the existing
  post-startup initial-state freeze and wake-jump probe.
- Explicit `--start` with either gate: starts there with no menu (same
  skip rule as stdin); `--notify` startup delivery is unchanged (004).

## Tests

- `test/start.test.ts` (+ mocked exec layer for the toast): `parseStartPhase`
  words/aliases/rejections; `parseStartChoice` digits/letters/words/custom-labels/`y`→`undefined`;
  `timer.start` deadlines per phase; first-line per `--start`; invalid
  `--start` exits 1; auto-flow `short → Focus 1/4` (count 0); menu choice
  `2` → break → `y` → `Focus 1/4` (two bells); empty → focus; `3` →
  long; invalid re-prompts silently; custom label shown and accepted;
  explicit `--start` keeps readline lazy; SIGINT-during-menu → summary,
  exit 0, no phase line; `--timestamp` stamps the stdin menu; toast: button
  title → phase, `@ACTIONCLICKED` → focus, `@CLOSED`/`@TIMEOUT` → re-send
  same argv/group, spawn error / unexpected output → focus + stderr note,
  custom labels as actions, explicit `--start` keeps exec lazy too,
  SIGINT-during-toast-menu → child killed, summary, exit 0.
- `test/confirm.test.ts`: existing transition tests pin `--start focus`
  so the menu is skipped and their original intent is unchanged.

## Docs / help

- `--help`: `Starting phase: focus, short, or long (aliases short-break,
long-break). With --confirm/--notify-confirm, omit to choose at startup.`
- README: CLI block + one `--start`/menu paragraph (stdin answers and toast
  actions, skip rule, click = Focus, `--no-loop --start long` note).

## Alternatives considered

- **Flag only, no menu:** rejected — the common case (occasionally
  opening on a break under `--confirm`) shouldn't require remembering
  the flag; asking is discoverable and Enter-to-accept is cheap.
- **Always ask under a gate (drop the flag):** rejected — scripts
  and aliases need a non-interactive choice.
- **Multi-action toast for `--notify-confirm` startup choice:** chosen —
  one toast with three `-action` buttons (collapses into an Options menu
  on macOS) expresses the 3-way choice; click = Focus default, dismissal =
  re-send. Supersedes the earlier chained-binary-toasts rejection (two
  toasts for one 3-way choice was confusing).
- **Menu in `program.ts` before `startDriver`:** rejected — AGENTS.md
  puts I/O in the driver, and a second SIGINT/summary path would drift
  from the driver's (this design reuses it untouched).

## Decision log

- [x] D1: `--start focus|short|long` (+ `short-break`/`long-break`
      aliases), usage error on anything else.
- [x] D2: a confirm gate (`--confirm` or `--notify-confirm`) without
      `--start` asks once at startup (stdin empty = Focus; toast click =
      Focus); explicit `--start` skips; no gate starts in focus.
- [x] D3: menu answers `1/2/3`, `f/s/l`, `--start` words, custom
      labels (toast: button titles via the same `parseStartChoice`, click
      = Focus); silent re-prompt / re-send; one bell; SIGINT path on abort.
- [x] D4: additive core change only (`start` phase param +
      `parseStartPhase`); menu parsing in `display.ts`, asker seam in
      `confirm-stdin.ts`, chooser seam in `notify.ts`, async preamble
      confined to driver startup.
