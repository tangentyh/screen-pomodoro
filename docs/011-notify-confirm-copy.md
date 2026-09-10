# 011 — Notification Confirm Copy: Proposal in Title, Verb on Button

Status: accepted. Amends 004 D6 (confirm copy), D2 (mapping table), D3
(`No` action label). No `timer.ts` changes, no new flags.

## Goals

1. Title reads standalone: it states what finished _and_ what is proposed,
   so a Banner-truncated toast still shows the decision.
2. Action button describes its result (HIG: verb-first, never `Yes`/`No`):
   `Restart <current>` instead of `No`.
3. Keep copy length parity with 004 (no new truncation class), keep
   nominal clocks (004 D7), keep resend/exit/lock semantics (004 D2, 007).

## Non-goals

- No change to fire-and-forget `--notify` copy, startup chooser, group,
  sound, bell, deadline math, or screen-pause semantics.
- No comma escaping: same known limit as 009 (comma in a custom name
  splits `-action` with no escaping). Documented, not validated.

## Copy (final)

Builders in `src/notify.ts` (all labels via `display.ts`, never hardcoded;
`nextLabel` carries the focus counter when focus, finished side stays bare
per 004 D9):

- `buildNotifyConfirmTitle(current, next, config, names, focusCount)`:
  `<current> complete. Start <nextLabel>?`
  - e.g. `Focus complete. Start Short break?`
  - e.g. `Short break complete. Start Focus 2/4?`
  - custom: `Deep work complete. Start Coffee?`
- `buildNotifyConfirmAction(current, names)`:
  `Restart <current>` (bare, no counter)
  - e.g. `Restart Focus`, `Restart Coffee`
- `buildNotifyConfirmMessage(current, next, config, names, focusCount)`:
  `<spent> spent. Click for <nextLabel> — <upcoming>, <restart> to redo.`
  - e.g. `25:00 spent. Click for Short break — 5:00, Restart Focus to redo.`
  - e.g. `5:00 spent. Click for Focus 2/4 — 25:00, Restart Short break to redo.`
  - custom: `25:00 spent. Click for Coffee — 5:00, Restart Deep work to redo.`

Rationale: `Start` (not `Click to`) keeps the stdin voice
(`<current> complete. Start <next>?`) and stays ~4 chars shorter; the
click-mapping lives in the message, where both affordances fit. `Restart`
(not bare `<current>`) is verb-first per HIG and unambiguous across
directions (bare `Focus` reads as "go to Focus" when it means "redo Focus").

## Behavior

Mapping (amends 004 D2 table):

| output                             | meaning           | driver does                                           |
| ---------------------------------- | ----------------- | ----------------------------------------------------- |
| `@ACTIONCLICKED` (body click)      | yes (start next)  | `true`                                                |
| `<restart>` (action button, exact) | no (redo current) | `false`                                               |
| `@CLOSED` / `@TIMEOUT`             | re-prompt         | re-send same toast (same `-group`, replaces in place) |
| anything else / spawn error        | no                | `false` + stderr note                                 |

- Exact match is against the per-prompt `Restart <current>` label
  (trimmed stdout, case-sensitive like 004's `No`). Colliding custom
  labels share `parseStartChoice` order by documentation; comma-split
  fragments fall into "anything else" (fail closed, never spins).
- `NO_LABEL = 'No'` stays exported as the deprecated fallback default for
  `createNotificationConfirmer` callers that omit `actionLabel`; the driver
  always passes the new label. Resend reuses identical argv (new label
  included); unlock-resend, SIGINT-kill, and `-remove` semantics unchanged.

## Architecture

- `src/notify.ts`: new `buildNotifyConfirmAction(current, names)`;
  `buildNotifyConfirmTitle` gains `(next, config, focusCount)`; message
  builder reworded; `NotifyConfirmerOptions` gains optional
  `actionLabel?: string` (default `NO_LABEL`), used for both `-action` argv
  and the `false` match.
- `src/driver.ts`: `runConfirmFlow` builds title/message/action with the
  new signatures and passes `actionLabel` through.
- `src/program.ts`: `--notify-confirm` help reworded
  (`click = start next, Restart = redo`).

## Edge cases

- 40-char custom names: title up to ~97 chars truncates like any long
  title; no new class beyond 004 (old max ~49 already truncated). Message
  length parity held (~68 chars both).
- Comma in a name splits the button (009 parity) → unexpected fragment →
  `false` + note. Documented in README caveats.
- `@CLOSED`/`@TIMEOUT`/spawn-error/SIGINT paths unchanged except the
  label they carry.

## Tests

- `test/notify.test.ts`: title/message/action builders (default + custom +
  counter), confirmer mapping against dynamic label (exact, whitespace
  trim, `@CLOSED` resend with identical argv incl. label, unexpected →
  `false` + note, default fallback `No` when `actionLabel` omitted).
- `test/notify-cli.test.ts`: driver prompt carries new title/message/
  `-action Restart …`; click advances, button restarts.

## Docs / help

- `--help`: `Answer phase transitions by clicking the notification (click = start next, Restart = redo). …`
- README macOS notifications: new toast transcript + comma caveat.
- This doc is the record; 004 D6/D2/D3 amended as above.

## Alternatives considered

- **Bare `<current>` button** (original proposal): rejected — noun-only,
  ambiguous across directions (`Focus` button means redo when
  focus→short, but go-to when short→focus).
- **`Click to <next>` title**: rejected — 4 chars longer than `Start`,
  and overstates (only body click goes next).
- **Forbid `,` in phase names**: rejected — breaking change to 003
  validation for one backend quirk; document instead (009 precedent).

## Decision log

- [x] D1: title `<current> complete. Start <nextLabel>?` (counter on next
      when focus).
- [x] D2: button `Restart <current>` (bare, verb-first); message
      `<spent> spent. Click for <nextLabel> — <upcoming>, <restart> to redo.`
- [x] D3: per-prompt exact match on the restart label; `NO_LABEL` kept as
      deprecated default; comma limit documented, not validated.
