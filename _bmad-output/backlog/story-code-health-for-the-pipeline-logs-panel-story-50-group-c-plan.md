---
title: 'Code health for the Pipeline Logs panel (story 50 group C)'
type: 'refactor'
ticket: '56'
created: '2026-11-13'
status: 'done'
baseline_revision: 'ea7ee8852e0b63acd069a26ac2a7d9e240fba64d'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The epic 6 retrospective (A3, A5, A7, AI-4) found the Pipeline Logs panel holding its read in flags (`pendingRange`, `pendingAround`, `done`, `stoppedShort`, `searchStopped`, `readUntil`, `rangeAt`, `searchCount`, the `older*` fields) that each change resets by hand, the "N record(s)" plural, zero padding and local-time formatting written several times across the logs adapter, protocol and webview, and six webview messages 6.6 added named as commands where the panel's other messages are past-tense intents.

**Approach:** A refactor: the read is held as one value per range with an explicit state, so a change replaces the value instead of resetting flags; the three helpers are written once in `src/shared`; the six messages are renamed as past-tense intents on both sides. What the user sees does not change.

**Decision (user, 2026-11-12):** split from story 50 as its group C; built after bug 53 (2026-11-13). No floor (VS Code 1.100.0) runs (user).

**Decision (2026-11-13, the recommended options; the user's standing instruction that day: "Do not ask me for approval, use the recommendation if I have to make a decision"):** one build for the three criteria; the shared helpers in a new `src/shared/logsText.ts`; the new names `stopRequested`, `retryRequested`, `accessSetUpRequested`, `anotherUserRequested`, `everyLevelRequested`, `last24hRequested`; Load older is a sub-state of a finished range, not a range of its own.

## Boundaries & Constraints

**Always:** Every message text, log line, command, setting and record read unchanged; `viewState`, `panelState`, `statusText` and every integration hook in `src/extension.ts:116` keep their values and meaning; bug 51 group A's per-partition positions (`positions`, `rangeAt`), left-out totals and gap marker (`dropped`, `newerDropped`, `gaps`, `leftOutEver`); bug 52's masking; bug 53's strip (`counter`, `counted`, `slots`, `stripSpan`); the staleness guards (`generation`, `choices`); the text the helpers produce, byte for byte (`toLocaleString('en-US')`, "match"/"matches" forms kept where they are).

**Never:** Changing an existing integration or corpus test's assertions, other than the six message names; a behavior change hidden in the refactor; touching groups B (ticket 55) or the slow-pattern check (bug 54).

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/logsPanel.ts` -- read fields: `range` 322, `chosenAt` 323, `live` 325, `pendingRange` 327, `pendingAround` 329, `highlightErrors` 331, `focusId` 333, `focusTime` 335, `note` 336, `done` 338, `positions` 340, `older` 341, `olderError` 343, `olderNote` 345, `leftOutEver` 347, `choices` 349, `session` 352 (`Session` 248-253), `olderSession` 353, `olderStop` 355, `olderFrom` 369, `readUntil` 373, `generation` 375, `failure` 377, `retryAttempt` 379, `stoppedShort` 382, `olderCount` 384, `rangeAt` 389, `searchCount` 393, `searchStopped` 395, `olderStart` 402. Dispatch: `read()` 1059-1067, `wantsRead()` 1055. Hand resets: `clearRead` 910-925, `reset` 928-951, `show` 671-677, `readAgain` 868-907, `setLive` 962-997, `readRange` 1186-1263, `tail` 1166, `loadOlder` 1271+ (guard 1273), `findError` 1423, 1460, `showSearched` 1505-1521, `revoke` 1645-1667, `stopReading` 1721-1763, `stop` 1824, `stopAll` 1837-1849, `prepend` 2007-2020. Readers: `strip` 507-514, `viewState` 477-498, `panelState` 522+, `olderAnchor` 566. Message switch 608-622. `recordsText` 278 and inline plurals 120, 144, 1233.
- `src/adapters/logs/export.ts` -- `pad` 39, `exportFileName` 46-48, `records` 51, "record was/records were" 63, 66.
- `src/shared/logsProtocol.ts` -- webview→host union 872-900 (`stopReading` 886, `retryNow` 888, `setUpAccess` 890, `useAnotherUser` 892, `showEveryLevel` 894, `last24h` 896), parser 1019-1055 (cases 1028-1033); `soFarText` 621, `leftOutHereText` 845, `slotSizeText` 728, `shortTime` 741-744 (MONTHS 738), `slotTimeText` 747-751, `slotLabel` 759, `pad` 1062, `localMinute` 1065-1067.
- `src/adapters/logs/history.ts:77` -- `unit` in `durationText`.
- `webview/src/logs/LogsView.tsx` -- imports from `../../../src/shared/logsProtocol` 45-50; `pad` 67, `localTime` 70-72, `ownTimeText`, `records` 84, inline plurals 96, 99, 115; message senders 244-257, `disabled` check 301.
- Tests: `webview/src/logs/LogsView.test.tsx` message names 553, 581, 590, 600, 605, 620, 647, loop 667; `src/test/adapters/logs/*.test.ts` (none import logsPanel); `src/test/integration/suites/97-logs.ts` uses only the hooks (`viewState` 212 uses, `statusText` 170) and the methods `stopReading()`, `setUpAccess()` (methods, not renamed).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/logsText.ts` (new, no vscode import) -- `plural(n, one, many?)` (or `countText`) using `toLocaleString('en-US')`, `pad(n, width = 2)`, and the local-time formatters now in `LogsView.tsx` (`localTime`), `export.ts` (`exportFileName`'s stamp) and `logsProtocol.ts` (`localMinute`, `shortTime`); every copy listed in the Code Map uses them; unit tests in `src/test/shared/logsText.test.ts` (or beside the existing logs tests) pin each text as produced today -- criterion 2.
- [x] `src/shared/logsProtocol.ts`, `webview/src/logs/LogsView.tsx`, `src/adapters/vscode/logsPanel.ts`, `webview/src/logs/LogsView.test.tsx` -- rename the six messages to the decided names on both sides (union, parser, senders, host switch, webview tests) -- criterion 3.
- [x] `src/adapters/vscode/logsPanel.ts` -- one read value (see Design Notes) replaces `pendingRange`, `pendingAround`, `done`, `stoppedShort`, `searchStopped`, `searchCount`, `readUntil`, `rangeAt`, and the `older*` fields become one optional Load older value; `reset`, `readAgain`, `setLive`, `revoke`, `stopReading`, `showSearched` and `show` set the value instead of patching flags; `read()`/`wantsRead()` dispatch on its kind; `viewState`, `panelState`, `strip`, `statusText` derive what they show from it -- criterion 1.
- [x] Run the stable and multi-root suites after each of the three tasks above (helpers, names, read state), so a regression is found in the task that caused it; record it in Implementation Notes.

**Acceptance Criteria:**
- Given the code after this change, when the panel is read, then no read flag is reset by hand on a change, and each helper has one definition.
- Given compile with lint, corpus, webview, stable and multi-root runs, when they run, then all pass, and `git diff ea7ee88 -- src/test/integration src/test/corpus` is empty and the webview test diff holds only the six renames and any new tests.

## Implementation Notes

- **Helpers (criterion 2):** `src/shared/logsText.ts` holds `countText(n, one, many = one + 's')` (en-US count), `pad`, `localMinute`, `localTime`, `shortTime` and `fileStamp` (the export name's `yyyymmdd-hhmm`). Every copy in the Code Map uses them: `export.ts` (`pad`, `records`, "record was/records were"), `history.ts` `durationText`, `logsProtocol.ts` (`soFarText`, `slotSizeText`, `slotLabel` incl. the "1 matches"/"3 match" form, `leftOutHereText`, `pad`/`localMinute`/`shortTime`/`MONTHS` removed), `LogsView.tsx` (`pad`, `localTime`, `records`, the footer and `matchText` plurals), `logsPanel.ts` (`recordsText`, the plurals of `stoppedReadingStatus`, `stoppedSearchStatus` and the end-of-range status). The webview test imports `localMinute`/`shortTime` from `logsProtocol` and `localTime` from `LogsView`, so those modules re-export them (one definition, no test change). `logsText` is not added to `src/shared/index.ts` (it would clash with `logsProtocol`'s re-export). Pinning tests: `src/test/shared/logsText.test.ts` (runs in the stable suite).
- **Names (criterion 3):** `stopReading`→`stopRequested`, `retryNow`→`retryRequested`, `setUpAccess`→`accessSetUpRequested`, `useAnotherUser`→`anotherUserRequested`, `showEveryLevel`→`everyLevelRequested`, `last24h`→`last24hRequested`, in the union, parser, senders, `disabled` check, host switch and webview tests (the panel's methods `stopReading()`/`setUpAccess()` and `LogSource.setUpAccess` are unchanged).
- **Read state (criterion 1):** `logsPanel.ts` has `readState: ReadState` (`tail` | `range {until, at}` | `search {count}` | `done {until, stoppedShort, searchStopped}`) in place of `pendingRange`, `pendingAround`, `done`, `stoppedShort`, `searchStopped`, `searchCount`, `readUntil`, `rangeAt`; and `older: Older` (`kind`, `error`, `note`, `from`, optional `run: OlderRun {abort, stop, count, start}`) in place of `older`, `olderError`, `olderNote`, `olderFrom`, `olderSession`, `olderStop`, `olderCount`, `olderStart`. `until` is carried into `done` because the strip reads it after the range ends (as `readUntil` did); a tail after a finished range keeps `done` (as before, `done` stayed true). `clearRead` replaces `older` with `NO_OLDER` (its callers, `reset` and a range read again from its start, cleared all four fields before). `Session.candidate` stays on the session.
- **Review fixes:** `done` carries `stopped: 'range' | 'search' | null` (`stoppedShort` is `stopped !== null`, the search's `stopped === 'search'`); `Older` is a union (`reading` with its `run`, or `more`/`none` without one); the tail's drops during a Load older are in `olderTail` (as `olderStart` was), kept past `stopAll` until that Load older settles, and `prepend` reads it as before, so there is no behaviour difference; a comment at `Session` says `readState` decides and why both kinds exist; `matchCountText` writes "1 matches"/"3 match" once; the re-exports in `logsProtocol.ts` and `LogsView.tsx` are marked as kept for the existing test imports. Pins moved: `durationText` to `history.test.ts`, the export texts to `export.test.ts` (plus "1 record was left out"), the panel's status lines to `src/test/adapters/vscode/logsPanelText.test.ts`; `logsText.test.ts` keeps the shared helpers and the protocol texts (plus "per hour", "per 4 hours"). New webview test: the six old names are refused, `matchText(1, 1)`, `footerText` for 1 and for many. After the fixes: webview 384 passed; `--label stable --grep "Pipeline log"` 192 passing, 1 pending.
- **Runs (each of stable / multiroot):** after the helpers: 1506 passing, 1 pending / 15 passing. After the names (task 2's `logsPanel.ts` alone, before the read state): 1506 / 15. After the read state: `npm run compile` exit 0; corpus 182 passed; webview 383 passed; multiroot 15 passing; stable first run 1505 passing, 1 failing (97-logs "SHOW and ONLY_THIS", a 10 s wait for two live records), then the logs suites alone (`--grep "Pipeline logs"`) 166 passing, and a second full stable run 1506 passing, 1 pending: taken as a timing flake. `git diff ea7ee88 -- src/test/integration src/test/corpus` is empty; the webview test diff was the six renames only (one test was added later, under Review fixes).

## Plan Change Log

## Review Triage Log

Thorough review (2026-11-13; blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Verdicts: 0 high, 1 medium, 13 low (8 patched, 5 rejected), 1 false. Routes: 9 patch, 0 defer, 0 loopback. The edge-case and verification-gap lenses compared every old flag transition with the new values, method by method, and found them equivalent.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 1 | BH, EC | `stopAll` drops the Load older run's `start` before the run settles; `olderStart` lived until `finally` | medium | patch | A behaviour change the Boundaries forbid (a narrow race); restored. |
| 2 | BH | `done` and `Older` types admit impossible combinations | low | patch | `stopped: 'range' | 'search' | null`; `Older` a discriminated union. |
| 3 | BH | `Session.kind` and `readState.kind` both say range/search | low | patch | A comment naming the authoritative one. |
| 4 | BH | Dead arm in `loadOlder`'s `finally` | low | patch | Removed. |
| 5 | BH | `keepStopped` rebuilds `older` per record | low | patch | One assignment. |
| 6 | BH | The "1 matches" form written twice with swapped arguments | low | patch | `matchCountText`. |
| 7 | BH | Re-exports kept for tests are unmarked | low | patch | Comments. |
| 8 | BH, VG | Old message names not shown refused; `matchText(1, 1)` and `footerText` singular unpinned | low | patch | Tests added. |
| 9 | BH | `logsText.test.ts` imports the panel (vscode); some texts unpinned | low | patch | Panel pins moved beside their modules; singular gaps and hour forms added. |
| 10 | BH, IA | `live` and `positions` still set beside `readState` | low | reject | The plan's Design Notes keep `range`, `chosenAt`, `live` as the range's choice and `positions` beside it with its bug 51 meaning; criterion 1's listed flags are all folded. |
| 11 | IA, EC | `Older` is a sibling of `readState`, not nested in `done`; Load older runs while tailing | low | reject | As before the refactor (the guard refused only range and search); the decision's "not a range of its own" holds. |
| 12 | IA, EC | `Older` still edited by spread | low | reject | Each change assigns a new value; the union in 2 removes the drift it allowed. |
| 13 | BH | No unit tests of the state machine; the "SHOW and ONLY_THIS" timeout dismissed | low | reject | The edge-case lens traced that test: the tail had started and the status was Following before the wait; no path leaves it unstarted; the integration suite drives every transition. |
| 14 | VG | Range status "…; 1 matches." unpinned at its site | low | reject | Covered by `matchCountText` once it is shared (6) and its unit test. |
| 15 | IA | Host side of the renames untested | false | reject | The host switch matches the shared union's types, so a wrong name fails type-checking; the webview side is tested. |

Intent-alignment notes (descriptive): C1 met in its narrow reading (the listed flags folded into `readState` and `Older`), C2 and C3 as specified; the tests pin texts and webview names, the integration suite covers the behaviour.

## Design Notes

A sketch, not a prescription:

```ts
type Read =
  | { kind: 'tail' }                                            // following from `positions`
  | { kind: 'range'; until: number; at?: Positions }            // a bounded read in flight (readUntil, rangeAt)
  | { kind: 'search'; count: number; candidate?: ErrorCandidate } // around the error, in flight
  | { kind: 'done'; stoppedShort: boolean; searchStopped: boolean };
type Older = { kind: 'reading' | 'more' | 'none'; from?: number; count: number; start?: number; session?: …; stop?: …; error?: string; note?: string };
```

`range`, `chosenAt`, `live`, `focusId`, `focusTime`, `note` stay as the range's choice and outcome; `positions`, the left-out and strip counts, `failure`/retry and `generation` stay beside it with their meaning. `pendingRange` becomes `read.kind === 'range'`, `pendingAround` `read.kind === 'search'`, `done` `read.kind === 'done'`. Where today two flags are set together (stop a range: `positions = rangeAt`, `done`, `stoppedShort`, `live = false`), one assignment of a new value does it. Load older is refused while `read.kind` is `range` or `search`, as the guard at 1273 does today.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (lint included)
- `npm run test:corpus`, `npm run test:webview` -- expected: pass
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: 0 failing
- same with `--label multiroot` -- expected: 0 failing
- `git diff ea7ee88 -- src/test/integration src/test/corpus` -- expected: empty

**Result (2026-11-13, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 384, multi-root 15 passing; `git diff ea7ee88 -- src/test/integration src/test/corpus` empty. Stable: the first run took 39 min of wall-clock time with "No ptyHost heartbeat" and failed one Cloud test (BAD_SIDECAR, the deploy follow timed out; the Cloud suite is not touched by this change); rerun: 1509 passing, 1 pending, 0 failing (11 min). The test settings clean; no floor run.

**Manual check result (user, 2026-11-16): tested, no issues.** Dev host 1.143.1 with 8a94337 on the user's cluster: Stop reading, Retry now and Show every level work in the Pipeline logs tab after the renames.
