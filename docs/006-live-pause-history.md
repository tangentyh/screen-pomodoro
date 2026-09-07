# 006 — Live Pause History (tidy: one row per event)

Status: accepted. Amends 002 Timing, 003 Naming table, 005 G1: live mode
leaves a persistent `Paused`/`Resumed` pair, suspends its countdown ticks
while paused, and commits every history row over the countdown row — no
ephemeral suffix, no stale-tick fossils.

## Goals

1. Live (TTY) emits the same `Paused …` / `Resumed …` history lines quiet
   already has, **instead of** the in-place `(paused — screen locked)`
   suffix. Scrollback answers "why didn't the clock advance?" with no
   duplicate row.
2. Every live history write commits _over_ the countdown row (`\r` + EL,
   then text + `\n`) instead of breaking past it with a leading `\n`. The
   old leading break scrolled the in-progress `\r` frame into scrollback
   as a stale-tick fossil — one duplicate row per event in a Ghostty paste
   (a `0:01` fossil plus the full-duration birth line). Commits erase the
   frame first, so each event leaves exactly one row.
3. No new strings, no new flag, no bell. Reuse quiet's copy verbatim; dedup
   (`pause while paused` / `resume while running` = no-op, no log) and
   `confirmPending` no-op (003 B4) unchanged.
4. Suspending ticks while paused idles live like quiet (only the 2000ms
   poll stays armed). Locks are rare, so history costs ~2 lines per cycle,
   not per-tick spam — always-on, no `--log-pauses` opt-in.

## Non-goals

- No `timer.ts` changes. Pause/resume/dedup math already correct.
- No bell on pause/resume (existing rule, AGENTS.md Gotchas).
- No stderr channel: history stays on stdout so piped logs match quiet.

## Behavior

- Pause in live: commit the paused line, then suspend the 250ms countdown
  interval (`clearInterval`, like the confirm gate does). No suffix render;
  only the 2000ms screen poll stays armed while locked.
- Resume in live: commit the resumed line, then `render(buildPhaseLine)`
  and re-arm the interval via `resumeTimers()`. `onLiveTick` returns early
  while paused (covers queued-tick races).
- Startup parity: live startup commits the initial phase line (full
  duration, no bell) before the first `render()`, mirroring every
  phase-change entry — otherwise the first phase shows only its 0:01 death
  fossil, never its birth.
- All live history sites share `commitLiveLine(text)` (`\r\x1b[K` + text +
  `\n`; bell stays a `\x07` prefix in the same write). Quiet branches are
  byte-identical to before (quiet never owns a `\r` row). SIGINT commits in
  live except while a confirm prompt owns the line (committing there would
  erase the user's answer); the confirm-terminal exit branches live/quiet
  for the same reason (it previously appended the summary to the live row
  with no break at all).
- `--no-screen-pause`, fail-open, wake-jump guard (005 D3/D6) unchanged.
- Quiet dense ledger (D5): quiet phase changes, terminal summary, and
  SIGINT summary drop live's leading break — quiet never owns a `\r` row,
  so the break printed a blank line after every `…\n` line (bell hid half
  of them as `\n\x07\n`). SIGINT keeps the break only while a confirm
  prompt owns the line.

## Architecture

`src/display.ts` + driver only:

- `buildPausedLine(timer, names)` → `Paused <name> — screen locked, timer
frozen` and `buildResumedLine(timer, names, nowMs)` → `Resumed <name> —
m:ss remaining`. Quiet path uses the same helpers (copy-identical output,
  single owner per AGENTS.md Layout).
- `src/cli.ts`: `commitLiveLine` next to `render()` (EL order differs on
  purpose — render clears the tail _after_ new text for shrink; commit
  clears the whole stale row _before_ history), used at every live history
  site: startup, phase changes, confirm y/n lines, pause, resume, SIGINT
  summary, terminal exits.

## Edge cases

- Rapid lock↔unlock: one pair per transition (dedup holds); poll
  coalescing within one interval still silent (005 Behavior, unchanged).
- Lock while `confirmPending`: no-op, answer still wins (003 B4).
- Custom `--*-name`: flows via `phaseLabel`, covered by existing names tests.
- Narrow terminals: a wrapped live row spans screen rows and one commit
  erases only the cursor row — accepted, same as before; default lines
  are short.

## Tests

- `test/screen-driver.test.ts` live: startup commits the full-duration
  birth exactly; per-chunk framing across startup/lock/unlock/phase
  change/SIGINT (every chunk is a pure `\r` render or a `\r`+EL commit —
  no bare-`\n` history, hence no fossils); lock = history, no suffix, no
  bell; ticks suspend while paused; unlock = history + same focus; no blank
  line between the pair; repeated `locked` fires once. Quiet: full no-loop
  run and SIGINT summary contain no `\n\n` (bell-stripped — the bell hid
  half the blanks as `\n\x07\n`). Ghost-EL test restricted to pure
  renders. `display.ts` ownership proven by usage + `test/names.test.ts`
  (custom names flow via shared helpers).

## Docs / help

- No `--help` change (no new flag).
- README Screen lock section: both modes leave a `Paused`/`Resumed` pair;
  live suspends ticks while paused and commits each history row over the
  countdown row, so scrollback holds one row per event; `-q` logs the pair
  only (no countdown).
- This doc amends 002's "TTY live line appends …" line, 003's Naming table
  (Live paused = history line, no suffix), and 005 G1's "reusing the copy"
  line.

## Alternatives considered

- **History + suffix (original 006):** rejected after live QA — the suffix
  repeated the frozen clock the previous tick already showed.
- **Leading-`\n` history (pre-commit):** rejected after Ghostty paste —
  each break fossilized the live frame into scrollback (the `0:01` rows).
- **Clear-then-newline (blank the row, history on the next):** rejected —
  scrolling a blanked row pushes a blank row (the pause/resume gap bug).
- **Alt-screen / cursor-up rewriting:** rejected — real complexity for a
  tiny CLI; commit framing is three bytes per write.
- **Flag-gated (`--log-pauses`):** rejected — extra surface;
  `--no-screen-pause` is already the opt-out.
- **stderr for history:** rejected — splits the transcript; non-TTY quiet
  already owns the piped-log story on stdout.

## Decision log

- [x] D1: always-on history in live (no opt-in flag).
- [x] D2: reuse quiet copy verbatim via `display.ts` helpers (no new strings).
- [x] D3 (tidy): history replaces the suffix; ticks suspend while paused.
- [x] D4 (one row per event): `commitLiveLine` at every live history site.
- [x] D5 (quiet dense ledger): no leading break on quiet history writes.
