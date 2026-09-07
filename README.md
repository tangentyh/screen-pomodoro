# screen-pomodoro

[![CI](https://github.com/tangentyh/screen-pomodoro/actions/workflows/ci.yml/badge.svg)](https://github.com/tangentyh/screen-pomodoro/actions/workflows/ci.yml)

A tiny CLI pomodoro timer that pauses when your screen locks.

> 🚧 **Under construction** — the repo currently holds the CLI scaffold (entry point, `--help` / `--version` plumbing, tests, CI). The pomodoro timing and screen-lock awareness land in an upcoming release.

- Runnable via `npx` — no install step required
- Fully typed TypeScript (strict, ESM), tested with Vitest

## What is the Pomodoro Technique?

The Pomodoro Technique is a simple time-management method created by
Francesco Cirillo in the late 1980s (named after his tomato-shaped kitchen
timer — _pomodoro_ is Italian for tomato). The idea:

1. Pick one task and focus on it for a fixed interval (traditionally 25 minutes).
2. Take a short break (traditionally 5 minutes) to rest and reset.
3. After every few focus sessions (traditionally 4), take a longer break
   (15–30 minutes).

Working in short, deliberate bursts makes it easier to start, stay focused,
and avoid burnout — and the regular breaks give your brain a chance to
recharge.

`screen-pomodoro` follows exactly this rhythm out of the box: it loops
`Focus → Short break`, inserting a `Long break` after every `--cycles`
focuses (4 by default), with the classic 25 / 5 / 15 minute defaults.
The twist: it pauses automatically when your screen locks (macOS —
Linux/Windows keep running; support planned; `--no-screen-pause` opts out),
so a coffee run or a chat never eats into your focus time.

## Quick start

```sh
# Run without installing
npx screen-pomodoro

# Show usage
npx screen-pomodoro --help
```

## CLI

```
Usage: screen-pomodoro [options]

A pomodoro timer that pauses when your screen locks.

Options:
  -V, --version        Print the version number.
  --focus <duration>   Focus duration (minutes or with s/m/h suffix). (default: "25")
  --short <duration>   Short break duration (minutes or with s/m/h suffix). (default: "5")
  --long <duration>    Long break duration (minutes or with s/m/h suffix). (default: "15")
  --cycles <n>         Focuses per long break (integer >= 1). Loops forever unless --no-loop is given. (default: "4")
  --no-loop            Stop after the first long break (i.e. after --cycles focuses) instead of looping forever.
  -q, --quiet          Log transitions only, no live countdown.
  --confirm            Awaits y/n on each phase transition (requires interactive stdin).
  --notify             Send a macOS notification on each phase transition (macOS + terminal-notifier required).
  --notify-confirm     Answer phase transitions by clicking the notification (click = yes, No = no). Implies the confirm gate; does not require interactive stdin.
  --no-screen-pause    Do not pause when the screen locks.
  --focus-name <name>  Custom label for focus phases. (default: "Focus")
  --short-name <name>  Custom label for short breaks. (default: "Short break")
  --long-name <name>   Custom label for long breaks. (default: "Long break")
  -h, --help           display help for command
```

Custom names appear in every phase line, pause/resume notice, confirm prompt,
and summary (`--focus-name "Deep work"` → `Deep work 1/4`,
`Completed 3 Deep work`). Names must be non-empty after trimming, at most 40
characters, with no control characters.

With `--confirm`, each deadline rings once and asks:

```
Deep work complete. Start Coffee? [y/n] y
```

`y` advances one phase, `n` restarts the current phase with a full deadline.
Anything else re-prompts. `--confirm` needs an interactive terminal
(`--confirm requires an interactive terminal` otherwise). `--no-loop` still
exits after the long break without a trailing prompt.

`--cycles` sets the long-break cadence; without `--no-loop` the timer loops
forever (`--cycles 2 --no-loop` runs 2 focuses then exits).

## macOS notifications (`terminal-notifier`)

macOS only — Linux/Windows use of either flag is a usage error (exit 1).
Install the notifier once:

```sh
brew install terminal-notifier
```

- `--notify` sends one fire-and-forget toast per transition (startup included)
  alongside the usual bell + phase line, in both live and quiet modes.
  A missed toast never kills the timer (one stderr note, then bell+text).
- `--notify-confirm` replaces the stdin gate: each deadline shows a toast
  (`<current> complete` / `<spent> spent. Start <next> — <upcoming>?
Click = yes, No = restart`). Click the body for yes, the `No` button for
  no. Dismissing the toast re-sends it until answered (same group, no
  stacking) — the toast equivalent of invalid stdin input.
- `--notify-confirm` cannot be combined with `--confirm` or `--notify`
  (one source only), and unlike `--confirm` it works without a TTY.
- Caveats: Focus/DnD holds the toast (timers stay frozen, as with stdin);
  over SSH / launchd-as-root delivery fails (exit 4) → `--notify` logs and
  continues, `--notify-confirm` resolves the pending prompt `false` with a
  stderr note instead of hanging.

## Screen lock (macOS)

macOS only — Linux/Windows keep running; support planned. `--no-screen-pause`
opts out (no polling at all, quiet mode stays fully idle).

- How it works: polls `/usr/sbin/ioreg -n Root -d1` every 2s (`execFile` only,
  no new dependencies). Locked = `"IOConsoleLocked" = Yes` (or defensive
  `CGSSessionScreenIsLocked = Yes` when present); anything else means active.
  Pause lands within ~2s of locking, resume on unlock — in live and quiet
  modes, reusing the pause/resume copy with no new strings and no bell.
- Fail open: probe errors, parse misses, or a missing binary mean "assume
  active, timer runs" (one stderr note until the next success, never spam).
  A missed lock overcounts seconds; a false lock would freeze a focus — the
  costs are asymmetric, so V1 biases toward running.
- Password grace period (Settings → Lock Screen → "Require password
  after…"): the console is genuinely unlocked until the grace expires, so the
  timer correctly keeps running (latency = grace + ≤1 poll).
- SSH: `ioreg` reads kernel state, so a timer in an SSH session correctly
  pauses when the desk locks.
- Password-less screensaver, display sleep without a password, and
  idle-while-thinking do not pause — "keep running" is the right
  lock-semantics answer there, and idle-time pause is out of scope.
- Fast-user-switch scoping is unverified and deferred.
- Rapid lock↔unlock within one interval coalesces silently; lock while
  `--confirm` is pending is a no-op and the answer still wins.
- Lid-close sleep freezes the process; on wake a >5s wall-clock jump probes
  before ticking so a lock-freeze lands before any phase cascade (unlocked-
  on-wake cascade on no-password machines is a known V1 limitation).

## Development

Requires Node.js >= 22.

```sh
npm install              # also installs git hooks (husky)
npm run dev              # run the CLI from source
npm run dev -- --help    # …with arguments
```

| Script                                          | What it does                                                |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `npm run build`                                 | Bundle to `dist/` with tsdown (ESM)                         |
| `npm run dev`                                   | Run the CLI from source with tsx                            |
| `npm run typecheck`                             | `tsc --noEmit`                                              |
| `npm run lint`                                  | ESLint (flat config, type-checked rules)                    |
| `npm run format` / `format:check`               | Prettier                                                    |
| `npm run test` / `test:watch` / `test:coverage` | Vitest                                                      |
| `npm run verify`                                | typecheck + lint + format:check + test + build (runs in CI) |

Pre-commit, [lint-staged](https://github.com/lint-staged/lint-staged) lints and formats staged files via [husky](https://typicode.github.io/husky/).

## License

[MIT](./LICENSE)
