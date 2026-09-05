# 004 — Desktop Notifications (macOS via `terminal-notifier`)

Status: proposed. Extends `003-confirm-and-names.md`. macOS only; Linux/Windows
explicitly out of scope.

## Goals

1. Fire-and-forget desktop notification on every phase transition (`--notify`).
2. Confirm-via-notification (`--notify-confirm`): the phase-transition gate
   from 003, but answered by clicking the notification instead of typing `y/n`.
   Click body = yes, `No` action button = no:
   `answer=$(terminal-notifier -group screen-pomodoro -sound Bottle -title 'Done' -message 'Deploy to production?' -action 'No')`

## Non-goals

- No Linux/Windows notifiers (`libnotify`, WinRT toasts, …). Non-darwin use of
  either new flag is a usage error (exit 1), same contract as the 003
  `--confirm requires an interactive terminal` guard.
- No new npm dependencies. Shell out to the Homebrew binary only.
- No change to `src/timer.ts` deadline math (absolute `endsAtMs` preserved).
  Driver-only change in `src/cli.ts` + one new module (`src/notify.ts`),
  honoring 003 D1 (core stays phase-enum-only, `node:`-free).
- No stdin raw mode changes, no per-transition granularity, no snooze, no
  config file, no persistence.

## Ground truth (`brew info terminal-notifier`, `terminal-notifier -help`)

- `brew info terminal-notifier` (2026-09-05): `3.0.0_1 → stable 3.1.0, HEAD`,
  `Send macOS User Notifications from the command-line`,
  `https://github.com/julienXX/terminal-notifier`, `License: MIT`,
  `Installed (on request)`. Missing-binary error text must point here:
  `` `brew install terminal-notifier` ``.
- `-help` contract (v3.0.0, verified locally):
  - `-title / -message / -sound NAME / -group ID / -action TITLE / -timeout SECONDS / -remove ID`.
  - Sounds are names in `/System/Library/Sounds` (`Bottle.aiff`, `Glass.aiff`,
    `Hero.aiff`, … verified present) or `'default'`. V1 uses `-sound Bottle`
    (matches the requested example; distinct from the default system ding).
  - `-group ID`: replaces old notifications with the same ID — the anti-stack
    mechanism. V1 uses one stable group (`screen-pomodoro`, see Decisions).
  - With `-action`, the tool **waits** and prints the outcome on stdout:
    the button title, or one of `@ACTIONCLICKED` / `@CLOSED` / `@TIMEOUT`
    (`-timeout` prints `@TIMEOUT` and exits 6; default waits indefinitely).
  - With a single `-action 'No'`: body click → `@ACTIONCLICKED`,
    button click → `No`. Hence the requested mapping: click = yes,
    action = no.
  - `-remove ID` deletes the delivered notification with that group ID
    (exit cleanup).
  - `-ignoreDnD` is documented best-effort/no-op without an Apple entitlement
    — V1 must **not** pass it.
  - Leading-`[` (also `(`, `{`, quote) in `-message` must be escaped as
    `\[` — phase names allow it today (003 only rejects
    `\r \n \t \x07`), so the notify module must escape it (see Architecture).
  - No-GUI-session watchdog: exits 4 after ~10s over SSH / launchd-as-root
    (`Notifications can only be posted for a logged-in user`). Plan for it
    (see Edge cases).

## CLI surface

- `--notify`: boolean, default off. `Send a macOS notification on each phase
transition (macOS + terminal-notifier required).`
- `--notify-confirm`: boolean, default off. `Answer phase transitions by
clicking the notification (click = yes, No = no). Implies the confirm gate;
does not require interactive stdin.`
- Guards (all fail-fast before the timer starts, exit 1, same contract as
  duration/cycles/name errors):
  - Either flag on `process.platform !== 'darwin'` →
    `error: --notify requires macOS (terminal-notifier)` (same for
    `--notify-confirm`).
  - Either flag when `terminal-notifier` is not on `PATH` →
    `` `terminal-notifier not found: brew install terminal-notifier` ``.
    Check once at startup (e.g. `terminal-notifier -version`), not per phase.
  - `--confirm` + `--notify-confirm` together → usage error (ambiguous
    `ConfirmFn` source). V1 is explicit; no auto-pick magic (see Alternatives).
  - 003's `--confirm requires an interactive terminal` guard stays as-is for
    `--confirm`. `--notify-confirm` is the documented way to confirm without
    a TTY (relaxes the guard by providing the non-stdin source 003 foresaw).

## Behavior

### `--notify` (fire-and-forget, no gating change)

- Supplements, never replaces, today's output: keep `\x07` + phase line
  (backward compat), add one `terminal-notifier` delivery per transition:
  `-group screen-pomodoro -sound Bottle -title <title> -message <message>`.
- Title/message are adapted to the entered phase from the same helpers as
  stdout (never hardcoded `Focus`, per 003 C-refactor) via two tiny builders
  in `src/notify.ts`:
  - `title`: `phaseLabel(entered, names)` plus the focus counter when
    `entered === 'focus'` — e.g. `Focus 2/4`, `Deep work 2/4` (custom
    `--focus-name`), `Short break`, `Coffee` (custom `--short-name`).
    Counter stays focus-only (003 C1), including in the title.
  - `message`: `<spent> spent on <leaving>. <entered> — <remaining> remaining`
    — cost with its subject, then the entered phase with its clock (label +
    focus counter, i.e. the title text). Spent = nominal `config` duration
    of the leaving phase, both clocks via `formatClock`, so pauses and
    confirm-gating never inflate it — e.g. `25:00 spent on Focus. Short
break — 5:00 remaining` when a 25m focus yields to a 5m break
    (`25:00 spent on Deep work. Coffee — 5:00 remaining` with custom names).
  - Counter rule: the finished side stays bare (`phaseLabel`, no counter —
    same as the confirm title `Deep work complete`); the upcoming side
    carries the counter when focus. Labels sit in both fields by design:
    title and message each read standalone wherever macOS shows them.
  - Startup (initial phase entry, nothing completed yet): notify as well,
    same `title`, but `message` is remaining-only (`25:00 remaining`). The
    builders take the leaving phase as optional; `undefined` (startup)
    omits the `<spent> spent. <label> — ` prefix, leaving `<remaining> remaining`.
    Rationale: parity with stdout,
    which always prints the first phase line; the toast must not claim
    spent time that never happened.
- Failure is non-fatal: delivery error (denied permission, no GUI session)
  logs one stderr line and the timer continues with bell+text. Rationale: a
  missed toast must not kill a 25-minute focus.
- Both live and quiet modes send it (quiet mode benefits most — the process
  is otherwise silent between transitions).

### `--notify-confirm` (blocking, same gate semantics as 003)

- Implements the existing driver seam `ConfirmFn(msg): Promise<boolean>`
  (003 Architecture): `createNotificationConfirmer` alongside
  `createStdinConfirmer`. Driver picks exactly one source; the gate math
  (`tick(promptAt)` + `shiftEndsAtMs(A-P)` for yes, `restartCurrentPhase`
  for no, suspend-while-pending, `--no-loop` terminal exit without prompt,
  SIGINT summary + exit 0) is unchanged.
- Invocation per prompt (argv, via `execFile`, never shell — see Security):
  `-group screen-pomodoro -sound Bottle -title <title> -message <message>
-action No`, with title/message adapted to the transition. They mirror the
  stdin prompt (`<current> complete. Start <next>? [y/n]`, 003 B1) plus the
  click mapping (a toast in another app has no surrounding stdout to explain
  the buttons):
  - `title = phaseLabel(current, names) + ' complete'` — e.g.
    `Focus complete`, `Deep work complete` (custom `--focus-name`).
  - `message = formatClock(spentMs) + ' spent. Start ' + nextLabel + ' — ' +
formatClock(nextMs) + '? Click = yes, No = restart'` (`spentMs` /
    `nextMs` = nominal `config` durations of `current` / `next`;
    `nextLabel` as above) — e.g. `25:00 spent. Start Short break — 5:00?
Click = yes, No = restart`, `25:00 spent. Start Coffee — 5:00? Click =
yes, No = restart` (custom `--short-name`).
    No repeated phase name (the title already says what finished), no nested
    parentheses — short dash-separated fragments in the `buildPhaseLine`
    voice. Deliberately richer than the stdin prompt: a toast in another app
    has no terminal history, so it states the cost, the proposal with its
    duration, and how to answer.
- Stdout mapping (trimmed):
  | output                                                                     | meaning   | driver does                                               |
  | -------------------------------------------------------------------------- | --------- | --------------------------------------------------------- |
  | `@ACTIONCLICKED` (body click)                                              | yes       | `true`                                                    |
  | `No` (action button)                                                       | no        | `false`                                                   |
  | `@CLOSED` (dismissed)                                                      | re-prompt | re-send the same toast (same `-group`, replaces in place) |
  | `@TIMEOUT` (no `-timeout` in V1; defensive)                                | re-prompt | re-send the same toast                                    |
  | anything else / spawn error after startup check                            | no        | `false` + stderr note                                     |
  | Rationale for re-send: dismissal is the toast equivalent of invalid stdin  |
  | input — 003 re-prompts instead of deciding for the user, and the gate does |
  | the same. No stacking risk (shared `-group` replaces in place) and no new  |
  | hang risk beyond what stdin confirm already accepts (timers frozen while   |
  | pending; SIGINT still settles via child-kill). Genuine delivery failures   |
  | (binary vanished, permission exit 3, no-GUI exit 4) still resolve `false`  |
  - stderr note — re-sending what cannot deliver would spin forever.
    No `-timeout` in V1 (wait indefinitely, matching stdin confirm); revisit
    with a `--notify-timeout` flag later.
- Timers stay suspended while the notifier blocks (free via the existing
  `confirmPending` gate — live interval cleared, quiet timeout chain not
  re-armed). Screen lock while pending is a no-op; the answer still wins
  (003 B4, unchanged).
- `Ctrl-C` while pending: existing SIGINT path + kill the pending
  `terminal-notifier` child so no orphan blocks on a dead prompt; then
  summary + exit 0. `finish()` also sends `-remove screen-pomodoro`
  (best-effort, ignored on failure) so a stale toast doesn't linger.
- Bell: keep the single pre-prompt `\x07` (stdin parity, cheap) alongside
  `-sound Bottle`. Revisit if double-chime annoys.

## Architecture

- New `src/notify.ts` (platform-agnostic, fully injectable, unit-testable):
  - Constants: `GROUP_ID = 'screen-pomodoro'`, `SOUND = 'Bottle'`,
    `NO_LABEL = 'No'`.
  - `isNotifySupported(platform = process.platform): boolean` → strict
    `=== 'darwin'` check (isolated for tests).
  - `checkNotifierAvailable(exec): Promise<void>` — runs
    `terminal-notifier -version` at startup; maps `ENOENT` → brew-hint error.
  - `escapeNotifierMessage(s): string` — prefix-escape a leading
    `[` (and `(`, `{`, quote per source) with `\`, mirroring the `-help` note.
  - `buildNotifyTitle(...)` / `buildNotifyMessage(...)` — the adapted
    title/message builders from Behavior (spent included); pure,
    unit-tested with default and custom names (counter focus-only).
    Spent comes from one tiny additive export in `timer.ts`,
    `phaseDurationMs(config, phase)` (pure switch, no math change — same
    allowance as 003's `restartCurrentPhase` / `shiftEndsAtMs`).
  - `sendNotification(exec, {title, message})` — fire-and-forget
    `execFile('terminal-notifier', ['-message', …, '-group', GROUP_ID,
'-sound', SOUND, …])`; resolves void, never rejects (caller logs).
  - `createNotificationConfirmer(exec, {group, sound, …}): ConfirmFn` —
    builds the blocking `-action No` argv, `await`s `execFile`, trims stdout,
    applies the mapping table above. Takes an injectable exec
    (default `node:child_process.execFile` promisified); takes `isFinished`
    like the stdin confirmer so SIGINT settles the pending promise.
  - No `timer.ts` imports, no phase-enum knowledge beyond `display.ts`
    labels passed in by the driver.
- `src/cli.ts` driver only:
  - Parse `--notify` / `--notify-confirm`; run platform + availability guards
    before `createTimer().start()`.
  - Select `confirmFn`: stdin (003, unchanged) xor notification (new).
    Conflict (`--confirm` + `--notify-confirm`) errors out.
  - Non-confirm transitions with `--notify`: `await`/fire
    `sendNotification` next to the existing bell+line writes (both live and
    quiet branches).
  - `runConfirmFlow` unchanged except the `confirmFn` it awaits; `finish()` /
    `onSigint` gain child-kill + best-effort `-remove`.
- Security: always `execFile` with an argv array — never `exec`/shell
  strings. Phase names are already constrained (trimmed, ≤40 chars, no
  `\r\n\t\x07`) but flow through argv regardless, so a name like
  `$(rm -rf ~)` is inert.

## Edge cases

- SSH / launchd-as-root (exit 4 watchdog): startup `-version` succeeds but
  delivery fails → `--notify` logs + continues; `--notify-confirm` resolves
  the pending prompt `false` with a stderr note (never hangs the driver on
  a toast nobody can see).
- Permission denied (exit 3, first-run prompt declined): same as above, note
  points at System Settings > Notifications / `tccutil reset
UserNotification fr.julienxx.oss.terminal-notifier`.
- Focus/DnD holds the toast: pending behaves like stdin-waiting-for-user —
  timers frozen, no cascade. No `-ignoreDnD` (no-op per `-help`).
- Banner vs Alert style: user-controlled in System Settings; V1 works with
  either (Alerts persist, Banners auto-dismiss but the blocking child still
  waits — dismissal yields `@CLOSED` → re-send, same `-group`, no stacking).
- Stale toasts across phases: single `-group` replaces the previous one;
  exit removes it.

## Tests

Follow `test/confirm.test.ts` patterns (`vi.useFakeTimers`, spy
`stdout.write`, inject fakes — never spawn the real binary, never block):

- `test/notify.test.ts` (new):
  - Mapping table: `@ACTIONCLICKED`→true, `No`→false, `@CLOSED`/`@TIMEOUT`→re-send
    (same argv/group, replaces in place), spawn error→`false`,
    surrounding whitespace trimmed, `button title` exact.
  - Argv: asserts `-group screen-pomodoro -sound Bottle -action No` present,
    title/message passed as separate argv entries (no shell), leading-`[`
    message escaped (`\[…`).
  - Adaptation: 25m focus → 5m break gives title `Short break`, message
    `25:00 spent on Focus. Short break — 5:00 remaining`; entered focus 2/4 → title
    `Focus 2/4`; custom names verbatim (`Deep work 2/4`, `Coffee`);
    confirm prompt `Deep work complete` / `25:00 spent. Start Coffee —
5:00? Click = yes, No = restart`; counter never on breaks;
    spent and upcoming durations are nominal (pause/gating/overshoot never
    inflate them).
  - Startup: initial entry notifies with a remaining-only message (`Focus
1/4` / `25:00 remaining`) — no spent prefix without a completed phase.
  - `checkNotifierAvailable`: `ENOENT` → error matches
    `/brew install terminal-notifier/i`; exit-3 text matches
    `/System Settings|tccutil/i`.
  - `isNotifySupported`: `darwin`→true, `linux`/`win32`→false.
- `test/cli.test.ts` additions (mocked exec layer):
  - `--help` lists `--notify` + `--notify-confirm`.
  - Non-darwin + either flag → exit 1 + `/macOS|darwin/i`, driver never starts.
  - Missing binary + either flag → exit 1 + `/brew install terminal-notifier/i`.
  - `--notify-confirm` with either `--confirm` or `--notify` → exit 1
    (one source only, simplicity over combinations).
  - `--notify-confirm` works with `stdin.isTTY === false` (the 003 guard
    applies to `--confirm` only).
  - Notif-y advances one phase / counts focus; notif-No restarts with full
    deadline (mirror the two core 003 tests with the notif confirmer stubbed
    `@ACTIONCLICKED` / `No`).
  - Timers suspended while notif pending (no re-arm, no extra prompts).
  - SIGINT while notif pending → child killed, `rl.close` semantics kept for
    stdin path, summary printed, exit 0, SIGINT listener count restored.
- `timer.test.ts` untouched (purity holds).

## Docs / help

- `--help` strings from CLI surface above.
- README: CLI block gains both flags; add a macOS section (install:
  `brew install terminal-notifier`; confirm transcript showing click vs `No`;
  note dismiss → toast re-sends until answered; note DnD/SSH caveats).
- This doc is the design record; 002's `No desktop notifications` line is
  superseded for macOS only.

## Implementation order

1. `src/notify.ts` + `test/notify.test.ts` (no driver change, low risk).
2. Driver wiring: flags → guards → `ConfirmFn` select → fire-and-forget sends
   → child-kill + `-remove` cleanup → mocked-exec CLI tests.
3. README / `--help` / this doc finalized.
4. `npm run verify` green + manual QA on a Mac (owner: user, post-implementation):
   `answer=$(terminal-notifier -group screen-pomodoro -sound Bottle -title
'Done' -message 'Deploy to production?' -action 'No'); echo "got: $answer"`
   (expect `@ACTIONCLICKED` on body click, `No` on button), then a real
   `--focus 1s --notify-confirm` cycle.

## Alternatives considered

- Auto-pick (003's sketch: `--confirm` uses stdin if TTY else notif if
  available): rejected for V1 as magic — explicit `--notify-confirm` keeps
  the source visible in `ps` and in bug reports. Revisit once the backend
  matrix grows beyond one OS.
- `@CLOSED`/`@TIMEOUT` → resolve-`false` (restart-with-note): rejected in favor
  of re-send — dismissal re-prompts like invalid stdin input, and the shared
  `-group` replaces the old toast so nothing stacks.
- `node-notifier` npm dep instead of shelling out: rejected — new dep +
  bundled binaries for one OS; Homebrew path is already installed here and
  keeps `package.json` dependency-free (per 002 `No new dependencies`).

## Decision log (to lock at review)

- [x] D1: flags `--notify` + `--notify-confirm` (explicit; `--notify-confirm`
      with either `--confirm` or `--notify` → usage error, simplicity over combinations).
- [x] D2: click (`@ACTIONCLICKED`) = yes, `No` = no, `@CLOSED`/`@TIMEOUT` =
      re-send until an explicit answer.
- [x] D3: single group `screen-pomodoro`, sound `Bottle`, no `-timeout`, `-remove`
      on exit, keep `\x07`.
- [x] D4: delivery failure non-fatal under `--notify`, resolves-`false` under
      `--notify-confirm`.
- [x] D5: no `-ignoreDnD`, `execFile`-only, escape leading `[`.
- [x] D6: confirm copy final — title `<current> complete`, message `<spent> spent. Start <next> — <upcoming>? Click = yes, No = restart`.
- [x] D7: spent (and upcoming) = nominal `config` durations — pause/gating/
      overshoot never inflate them.
- [x] D8: startup `--notify` fires with a remaining-only message (parity with
      stdout's first phase line; no spent claim without a completed phase).
- [x] D9: `--notify` message — `<spent> spent on <leaving>. <entered> —
<remaining> remaining` (finished side bare, upcoming side with counter;
      each field standalone).
- [x] D10: `phaseDurationMs(config, phase)` additive export in `timer.ts` approved
      (pure switch, no math change — same allowance as 003's helpers).
