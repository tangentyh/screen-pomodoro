# 005 — Pause on Screen Lock (macOS via `ioreg` polling)

Status: accepted. Implements the screen-monitor seam 002 left as
interface-only (`NoopMonitor`), making the tagline behavior real on macOS:
the timer freezes while the console is locked and resumes on unlock.
Linux/Windows stay on `NoopMonitor` (documented, not silent-by-accident).

## Goals

1. Pause (`timer.pause('screen')`) within ~2s of the console locking, resume
   on unlock — in both live and quiet modes, reusing the pause/resume copy
   and dedup the driver already has (002 Timing; no new strings, no bell).
2. Zero new dependencies, one opt-out flag (`--no-screen-pause`). Detection is `execFile`-only
   (same rule as 004 Security), injectable and unit-testable with fake
   timers — never a real spawn in tests.
3. Fail open: any unknown (probe error, parse miss, missing binary) means
   "assume active, timer runs," never a frozen focus.

## Non-goals

- No Linux/Windows backends. The factory returns `NoopMonitor` off-darwin;
  the README says so explicitly. Per-DE matrices (logind D-Bus, GNOME
  ScreenSaver, Win32 session events) stay proposed.
- No "away" detection beyond locked: password-less screensaver, display
  sleep without a password, and idle-while-thinking do **not** pause V1
  (see Edge cases for why each is correct-or-deferred, not an oversight).
- No latency heroics. Polling trails the true lock moment by up to one
  interval; deadline math absorbs it (≤2s on a 1500s phase). The
  event-stream alternative was measured and rejected (see Alternatives).
- No `timer.ts` changes. Pause/resume/dedup semantics are already correct;
  this record is driver + `screen.ts` only.

## Ground truth (verified locally, 2026-09-06, Sequoia x86_64, unlocked)

- `/usr/sbin/ioreg -n Root -d1` → `"IOConsoleLocked" = No`, one node,
  **16ms** wall time. Cheap enough to run every 2s (0.5 wake/s; amends
  002's "fully idle process" line for quiet mode — see D4).
- `ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked raw -`
  → **exit 1, key absent** when unlocked. The classic gist recipe only works
  as "missing = unlocked," and the `-a` dump drags the whole
  `IOKitDiagnostics` tree — so V1 probes **plain** output, never `-a`.
- `python3 -c 'import Quartz…'` → `ModuleNotFoundError`. Stock macOS
  `python3` ships no PyObjC: the `CGSessionCopyCurrentDictionary` one-liner
  needs a pip dep. Rejected without further discussion.
- `log stream --predicate 'eventMessage contains "screenIsLocked"'` starts
  clean (no TCC wall), but `log show --last 2h` with the same predicate →
  **zero matches**. The event-tap match-string is unverifiable without
  physically locking, and redaction/rewording would fail silently.
- This machine: `displaysleep 5`, screensaver `idleTime 0` (never
  auto-starts) — so the local auto-lock path is display-sleep →
  require-password. A screensaver-watcher would never fire here; `ioreg`
  doesn't care which trigger locked the console. All lock paths (manual
  Ctrl-Cmd-Q, auto-lock, …) converge on the same `IOConsoleLocked` flag,
  so auto-locks need no separate mechanism — with the grace-period caveat
  in Edge cases.
- While-locked output **confirmed on hardware (2026-09-06**, Ctrl-Cmd-Q):
  `"IOConsoleLocked" = Yes`, plus `CGSSessionScreenIsLocked=Yes` and
  `CGSSessionScreenLockedTime` appearing inside the user's dict — i.e.
  both V1 signals fire, and the absent-when-unlocked reading was correct.
  Note the formats differ: top level uses `"key" = Yes` (spaces), array
  entries use `"key"=Yes` (no spaces) — regexes must be
  whitespace-tolerant. Also note `kCGSSessionOnConsoleKey` stays `Yes`
  while locked: it tracks console ownership, not lock state.

## CLI surface

- `--no-screen-pause`: boolean, default off (i.e. pausing is on). `Do not
pause when the screen locks.` Commander gives `screenPause: true` unless
  passed; the driver uses `NoopMonitor` (no polling at all — zero wakeups,
  quiet mode stays fully idle) when disabled. Valid on all platforms; it
  simply selects the noop backend. No interaction with any other flag.
- `--help` gains the one line above; no other surface change.

## Behavior

- V1 signal: **locked** = `"IOConsoleLocked"\s*=\s*Yes` in plain
  `ioreg -n Root -d1` output, OR `CGSSessionScreenIsLocked"\s*=\s*Yes`
  if that key is present (defensive; absent = unlocked, never an error).
  Whitespace-tolerant (`\s*` — top level pads with spaces, array entries
  don't). Anything else → active.
- Poll every 2000ms (`POLL_MS`). Diff-then-fire: the listener fires only on
  change, so lock+unlock coalescing within one interval is silently absorbed
  (net effect ~0; pause/resume are idempotent, the books stay honest).
- Driver path is unchanged: the existing `monitor.subscribe(state =>
locked ? timer.pause('screen', now) : timer.resume('screen', now))`
  handler, its confirm-pending no-op, and its pause/resume copy all apply
  as-is. Only the injected monitor changes (Noop → factory).
- Wake-jump guard (D6): lid-close sleep freezes the process; on wake,
  `Date.now()` jumps and the first tick would cascade expired phases with
  rapid bells _before_ the next poll notices we're locked. So before
  ticking, if wall-clock drift since the last tick exceeds
  `JUMP_THRESHOLD_MS = 5000`, the driver awaits `probeNow()` first and
  applies a lock-freeze before any `tick()`. Unlocked-on-wake cascade
  (no-password machines) is accepted as a known V1 limitation.

## Architecture

`src/screen.ts` only (plus driver wiring in `src/cli.ts`):

- Keep the `ScreenMonitor` shape; add one method:
  `probeNow(): Promise<ScreenState>` — a one-shot async probe.
  `NoopMonitor.probeNow()` resolves `'active'`.
- New `PollingMonitor implements ScreenMonitor`, following the `notify.ts`
  seam pattern (004 Architecture):
  - Constructor takes an injectable probe exec
    `(file, args) => Promise<{ stdout, stderr }>` (structurally the notify
    `ExecFileFn`, kept local so `screen.ts` doesn't import `notify.ts`)
    plus `{ pollMs = 2000 }` and injectable
    `setInterval/clearInterval` for fake-timer tests. Default exec is
    promisified `node:child_process.execFile` with argv
    `['-n', 'Root', '-d1']` — never a shell string.
  - `subscribe` starts the interval (first poll corrects the assumed-active
    initial state within one `pollMs`); `unsubscribe` clears it, idempotent.
    `getInitialState()` returns last-known (default `'active'`) — sync
    contract unchanged, so the driver needs no startup ceremony.
  - Probe failure or parse miss → `'active'` + one stderr note until the
    next success (note-once flag, reset on success — no per-tick spam).
- New factory
  `createScreenMonitor(opts?: { platform?, enabled? } = {}): ScreenMonitor`
  — `enabled === false` → `NoopMonitor` (the `--no-screen-pause` path);
  otherwise `darwin` → `PollingMonitor`, anything else → `NoopMonitor`
  (both injectable; defaults `process.platform` / `true`).
- `src/cli.ts`: replace `new NoopMonitor()` with
  `createScreenMonitor({ enabled: raw.screenPause })`; add the
  wake-jump guard to both tick paths (live interval + quiet timeout chain)
  via `monitor.probeNow()`; `startDriver` takes an optional injected monitor
  (default: factory) so CLI tests stay hermetic on darwin — no real `ioreg`
  in tests, same rule as 004's mocked exec layer. `finish()` already calls
  `unsubscribe()`, which now also clears the poll interval; no new
  teardown paths, no orphaned children (there are none — short execs only).
- Security: `execFile` + argv array only. `ioreg` output is never
  interpreted beyond the two quoted-key regexes.

## Edge cases

- **Password grace period** (Settings → Lock Screen → "Require password
  after…"): the console is genuinely unlocked until the grace expires, so
  the timer correctly keeps running. Latency = grace + ≤1 poll. Documented,
  not fought.
- **Never-locked ⇒ never-paused, correctly.** Password-less screensaver or
  display sleep leaves the session usable by anyone walking up — "keep
  running" is the right lock-semantics answer. Idle-time pause ("staring at
  the screen thinking should not pause a focus") is explicitly out of scope.
- **Fast-user-switch:** unverified whether `IOConsoleLocked` flips when
  switched away; per-user `kCGSSessionOnConsoleKey` scoping needs the
  current username and whole-output regexes would misfire on multi-user
  output. Deferred — document as unverified, don't half-parse.
- **SSH:** `ioreg` reads kernel state, not the GUI session — a timer in an
  SSH session correctly pauses when the desk locks. (Contrast with
  `--notify`, which can't deliver headless per 004.)
- **`ioreg` missing / exec fails:** fail open (active + note-once). A missed
  lock overcounts seconds; a false lock freezes a focus — asymmetric costs,
  bias toward running.
- **Rapid lock↔unlock within one interval:** coalesced, no events. Accepted.
- **Lock while `confirmPending`:** no-op per the existing gate; the answer
  still wins (003 B4, unchanged). No bell on pause/resume (existing rule).
- **SIGINT:** existing path; `unsubscribe()` clears the poll interval
  alongside the driver timers.

## Tests

Follow `test/screen.test.ts` + `test/confirm.test.ts` patterns
(`vi.useFakeTimers`, stub exec fns, spy `stdout.write` — never spawn):

- `test/screen.test.ts` additions (`PollingMonitor`):
  - Parsing: `= Yes` → locked; `= No` → active; missing keys → active;
    `CGSSessionScreenIsLocked = Yes` → locked (defensive branch).
  - Fires only on change (locked→locked silent, flapping produces exactly
    the transitions); initial state active with first-poll correction.
  - Exec rejection / garbage stdout → active + exactly one stderr note
    across many ticks; note flag resets after a success.
  - `unsubscribe` clears the interval (assert via timer spy) and is
    idempotent; multiple subscribers each get transitions.
  - `probeNow()` resolves current state without waiting for the interval.
  - Factory: `darwin` → polling, `linux`/`win32` → `NoopMonitor`.
- `test/cli.test.ts` additions (injected stub monitor, never real `ioreg`):
  - `--help` lists `--no-screen-pause`.
  - `--no-screen-pause` with a stub reporting locked → timer never pauses,
    no poll interval armed (fully idle); default (flag absent) polls.
  - Lock mid-focus pauses (frozen `remainingMs`), unlock resumes; live and
    quiet copy unchanged (assert existing strings, not new ones).
  - Wake-jump: advance wall clock >5s with stub reporting locked → no
    `tick` cascade, pause applied first (assert no phase-change bell burst).
  - SIGINT clears the poll interval (listener/interval counts restored).
- `timer.test.ts` untouched (purity holds — no core changes).

## Docs / help

- `--help` gains `--no-screen-pause`.
- README: the intro's "pauses when your screen locks" gains "(macOS —
  Linux/Windows keep running; support planned; `--no-screen-pause` opts
  out)" plus a short "Screen lock" section: how it works (`ioreg` poll,
  ~2s), the grace-period note, the SSH note, the password-less-screensaver
  note, fast-user-switch unverified.
- This doc is the design record; 002's "seam, no implementation" line is
  superseded for macOS, and its "fully idle process" line is amended by D4.

## Implementation order

1. `src/screen.ts` (`PollingMonitor` + `probeNow` + factory) +
   `test/screen.test.ts` additions (no driver change, low risk).
2. Driver wiring: factory injection, wake-jump guard in both tick paths,
   injected-monitor CLI tests.
3. README + `--help`-parity check (none needed) + this doc finalized.
4. `npm run verify` green + manual QA (owner: user — needs physical lock,
   ~1 min total, lock scheduled-probe already confirmed `Yes` — no need to
   re-run it):
   `npm run dev -- --focus 20s --short 10s --long 10s --cycles 1 --no-loop`
   — lock ~5s into focus, stay locked ~10s, unlock; expect the paused line
   with the clock frozen, then a resumed line continuing the same focus.
   Repeat with `-q` for the Paused/Resumed pair.

## Alternatives considered

- **`log stream` event tap** (`eventMessage contains "screenIsLocked, to
value:1"` via `spawn('sh', ['-c', …])`): rejected. Undocumented private
  wording (zero hits in 2h of local logs — silent permanent miss on
  reword/redaction), no initial state (start-while-locked never pauses),
  chunk-split parsing bug (arbitrary `data` boundaries vs exact-match
  `includes`), shell-string spawn against the 004 rule, long-lived child
  with no error/exit handling, untestable inline globals, permanent `logd`
  firehose cost — all to buy ~1s of latency that deadline math makes
  unobservable.
- **Hybrid (stream fast-path + poll fallback):** rejected — M1 plus a
  fragile fast path is complexity for ~1s. Revisit only with measured
  evidence that 2s detection hurts.
- **`pgrep ScreenSaverEngine`:** rejected as primary — Ctrl-Cmd-Q lock
  doesn't always start the screensaver (false negatives), and on
  never-screensaver machines (this one: `idleTime 0`) it can never fire.
- **Python `Quartz.CGSessionCopyCurrentDictionary`:** rejected — no PyObjC
  in stock macOS `python3`, i.e. a new dependency by another name.
- **Native helper binary (Swift/ObjC `NSWorkspace`):** rejected — build,
  sign, and distribute a binary for exactness V1 can't observe.
- **Idle-time pause (`HIDIdleTime` threshold):** rejected scope — pauses
  while thinking/reading; lock ≠ away.

## Decision log (to lock at review)

- [x] D1 (revised per review): opt-out flag `--no-screen-pause`
      (default: pause on). Always-on had no escape hatch for demos,
      screen-sharing, or preference — explicit off keeps the source
      visible in `ps`/bug reports, same rationale as 004 D1.
- [x] D2: plain `ioreg -n Root -d1` only, never `-a` (16ms vs full-tree
      dump); missing keys = unlocked, never an error.
- [x] D3: fail open everywhere (error/parse-miss → active + note-once).
- [x] D4: `POLL_MS = 2000` (amends 002's "fully idle" quiet-mode line —
      0.5 wake/s of 16ms is the accepted cost; `--no-screen-pause`
      restores fully idle).
- [x] D5: `ScreenMonitor` gains `probeNow()`; `getInitialState()` stays
      sync last-known-default-active (no driver startup ceremony).
- [x] D6: wake-jump guard at `JUMP_THRESHOLD_MS = 5000` — `probeNow()`
      before `tick()` on drift; unlocked-on-wake cascade accepted for V1.
- [x] D7: fast-user-switch scoping deferred (owner never switches users;
      stays documented-as-unverified, no half-parse of multi-user output).
- [x] D8: V1 is lock-only — password-less screensaver/sleep and idle time
      explicitly do not pause.
