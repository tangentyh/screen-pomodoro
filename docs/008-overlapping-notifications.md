# 008 — Overlapping Timers via `--notify-group`

Status: accepted. Amends 004 D3 (single stable group): the default group
stays `screen-pomodoro`, with an opt-in `--notify-group <id>` that isolates
overlapping timers. No `timer.ts` changes.

## Goals

1. Two (or more) timers overlapping in time with different names/intervals
   can each keep a visible, answerable toast: deliveries, blocking
   `--notify-confirm` prompts, lock-withdraw `-remove`, exit `-remove`, and
   unlock re-send all use the timer's own group.
2. Default behavior unchanged: omitting the flag shares one group, so a
   single timer keeps today's replace-in-place, dismiss re-send, and cleanup
   semantics with zero flag churn.

## Non-goals

- No auto-isolation (no per-PID suffix, no name-derived group). Explicit
  flag keeps the group visible in `ps` and bug reports — same
  explicit-over-magic precedent as 004's rejected auto-pick.
- No change to phase-name rules, deadline math, or screen-pause semantics.
  Names/intervals stay display-only; only the group isolates.
- No multi-timer single process. Overlap means separate processes, each
  with its own loop, screen-pause polling, and bell.

## Behavior

- `--notify-group <id>`: notification group for this timer. Default
  `screen-pomodoro` (004 D3 unchanged when omitted).
- Validation (usage error, exit 1, same contract as name/duration errors):
  trimmed, non-empty, at most 64 characters, no `\r \n \t \x07`.
- Guard: `--notify-group` without `--notify` or `--notify-confirm` is a
  usage error (`--notify-group requires --notify or --notify-confirm`) —
  otherwise the flag would silently do nothing.
- When set, every `terminal-notifier` call for that process uses it:
  fire-and-forget sends, blocking `-action No` prompts (re-sends keep the
  same custom group), lock-withdraw `-remove`, exit `-remove`.
- Sharing a group (the default) still collides by design: the second
  timer's toast replaces the first's, and one's `-remove` withdraws the
  other's. Overlapping timers that must coexist pass distinct groups:

```sh
screen-pomodoro --focus 50 --short 10 --focus-name "Deep work" --notify --notify-group work &
screen-pomodoro --focus 25 --short 5 --focus-name "Stretch" --notify --notify-group stretch &
```

## Architecture

- `src/notify.ts`: `NotifyPayload`/`NotifyConfirmerOptions` gain optional
  `group`; `baseArgv(title, message, group = GROUP_ID)` threads it through
  `sendNotification` and `createNotificationConfirmer`; new pure
  `parseNotifyGroup(raw)` validator (same control set as phase names).
  `GROUP_ID` remains the default export (backward compat).
- `src/program.ts`: `--notify-group <id>` option (no commander default —
  absent means shared), parsed via `parseNotifyGroup`, guarded to require
  a notify flag, passed as `DriverFlags.notifyGroup`.
- `src/driver.ts`: `DriverFlags` gains required `notifyGroup`; all four
  touchpoints (`notifyEntered`, confirm-creation, `removeToast` for lock
  and exit) use `flags.notifyGroup`. Intra-process replace-in-place is
  preserved per group.

## Edge cases

- Crashed process with a custom group leaves its toast (same as today's
  shared-group crash — no worse, narrower blast radius).
- Lock withdraw and unlock re-send use the custom group, so one timer's
  lock edge never hides the other's toast.
- `--notify-confirm` clicks route per group: each pending child waits on
  its own toast, no cross-answering.

## Tests

- `test/notify.test.ts`: custom group reaches `-group` in sends and
  confirmer argv; `parseNotifyGroup` trims, rejects empty/control/>64,
  allows spaces/emoji.
- `test/notify-cli.test.ts`: `--help` lists the flag; group-without-notify
  errors; invalid groups error (no `unknown option`); custom group
  isolates deliveries + exit `-remove`; confirm prompt carries the group.

## Docs / help

- `--help`: `Notification group for overlapping timers (default shares one toast).`
- README: CLI block + one overlapping-timers bullet in macOS notifications.
- This doc is the record; 004 D3 is amended (default shared, opt-in
  isolation), 007 resend/remove semantics carry over per group.

## Alternatives considered

- **Per-PID auto-suffix:** rejected — invisible in `ps`, stale groups
  after crashes, surprises in bug reports.
- **Name-derived group:** rejected — same names with different intervals
  still collide; coupling display text to delivery identity is fragile.
- **Allow `--notify-group` silently without notify flags:** rejected —
  typo'd flag doing nothing is worse than a usage error.

## Decision log

- [x] D1: explicit `--notify-group <id>`, default `screen-pomodoro`.
- [x] D2: validation trimmed/non-empty/≤64/no control chars; requires
      `--notify` or `--notify-confirm`.
- [x] D3: all notifier touchpoints (send, prompt+resend, lock/exit
      `-remove`) use the configured group.
