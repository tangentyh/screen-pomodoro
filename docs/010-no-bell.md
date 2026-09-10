# 010 — `--no-bell` Opt-Out

Status: accepted. Amends 004 D3 (`keep \x07` alongside `-sound Bottle`):
the bell stays on by default, with an explicit opt-out. No `timer.ts`
changes.

## Goals

1. One flag silences the terminal bell (`\x07`) everywhere the driver
   rings today: phase-change lines, terminal long-break summary, and
   pre-prompt rings for stdin `--confirm` / `--notify-confirm` startup
   menus and transition prompts.
2. Default behavior unchanged: omitting the flag keeps today's bell
   (backward compat with all existing bell asserts).
3. Solves the notif double-chime: `--notify --no-bell` (or
   `--notify-confirm --no-bell`) leaves exactly one chime (`-sound
Bottle`), not terminal ding + `Bottle`.

## Non-goals

- No change to notification sound: `-sound Bottle` still fires under
  `--notify` / `--notify-confirm`. Fully-silent toasts would be a
  separate `--notify-sound`-style follow-up.
- No change to pause/resume (already silent per 006), startup birth
  line (already bell-free), or deadline math.
- No per-phase granularity, no config file, no env var.

## Behavior

- `--no-bell`: boolean, default off (bell on). Commander `--no-`
  negation gives `bell: true` unless passed, same pattern as
  `--no-loop` / `--no-screen-pause`.
- When passed, every `\x07` the driver would write is dropped; the
  accompanying phase line / prompt / summary / toast is otherwise
  byte-identical (minus the bell byte). Live commit framing
  (`\r\x1b[K…\n`) and quiet appends keep their shape.
- Combinable with everything: `--quiet`, `--timestamp`, `--confirm`,
  `--notify`, `--notify-confirm`, `--start`, `--no-loop`,
  `--no-screen-pause`. No exclusivity errors.

## Architecture

- `src/program.ts`: `--no-bell` option (`Disable the terminal bell
(\x07) on phase changes and prompts.`), threaded as required
  `DriverFlags.bell` (`raw.bell ?? true`).
- `src/driver.ts`: `DriverFlags` gains required `bell: boolean`; one
  `ring()` helper for standalone pre-prompt/menu rings plus one
  `bellPrefix` (`'\x07'` or `''`) for the inline
  `\x07…line\n` / `\x07\r\x1b[K…\n` writes. Covers all ten sites:
  startup menu/toast (2), confirm terminal summary (2 branches),
  confirm prompts (2), live terminal + transition (2), quiet terminal
  - transition (2). No new modules, no `notify.ts` change.

## Edge cases

- Pause/resume stay silent either way (no new strings, no bell).
- Startup birth line stays bell-free either way.
- Re-prompts / toast re-sends stay silent either way (already bell-free).
- `--notify` delivery failure still logs + continues with text (just no
  bell); `--notify-confirm` failure still resolves `false` with a note.

## Tests

- `test/no-bell.test.ts` (new, `run(argv)` + `stdout.write` spy +
  fake timers, never real stdin/binary): `--help` lists `--no-bell`;
  quiet transition with `--no-bell` prints the phase line with zero
  `\x07`; quiet transition without the flag still rings (default compat);
  `--confirm` prompt with `--no-bell` has zero bells but still prompts
  and advances on `y`.
- Existing bell asserts (cli/confirm/notify-cli/names/start/timestamp/
  screen-driver) pin the default and keep passing untouched.

## Docs / help

- `--help`: `Disable the terminal bell (\x07) on phase changes and prompts.`
- README: CLI block gains the flag; macOS notifications section notes
  `--notify --no-bell` as the single-chime setup.
- This doc is the record; 004 D3 amended (bell on by default, opt-out).

## Alternatives considered

- **Drop `\x07` whenever notify flags are set (auto-mute):** rejected —
  magic; explicit flag keeps the source visible in `ps` and bug reports
  (same precedent as 004's rejected auto-pick and 008's rejected
  auto-isolation).
- **`--silent` / `--mute` covering bell + sound:** rejected — couples
  two channels; users want text+toast without terminal ding, or
  text-only without notifs. One flag, one channel.

## Decision log

- [x] D1: explicit `--no-bell` (commander negation, default bell on).
- [x] D2: suppresses all driver `\x07`; lines/prompts/summaries/toasts
      otherwise unchanged; `-sound Bottle` untouched.
- [x] D3: combinable with all modes/gates; no new errors.
