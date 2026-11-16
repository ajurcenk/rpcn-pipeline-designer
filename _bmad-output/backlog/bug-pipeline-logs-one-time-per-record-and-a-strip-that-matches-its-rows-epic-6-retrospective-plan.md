---
title: 'Pipeline logs: one time per record, and a strip that matches its rows'
type: 'bugfix'
ticket: '53'
created: '2026-11-13'
status: 'done'
baseline_revision: '27f7060e96a9db159e466ef49bcba38d47b98066'
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

**Problem:** A Pipeline Logs row shows the time from the record's own `time` field, while reads, the strip, Load older and the export's order use the Kafka timestamp; Show records around this one and the around-the-error search use the shown time, so a record whose two times differ by more than 5 minutes falls outside its own window. The strip clamps records outside its span into the edge bars, and after a bounded range followed by Live every live record piles into the last bar, so a bar counts records its click does not show.

**Approach:** The Kafka timestamp is the one time of a record for every use (the row's time, the sort, the strip, Show records around this one, the around-the-error search, the gap markers); the row also shows the record's own `time` when the two differ. The strip counts each record in the bar for its time or not at all, and its span follows the records read, Live included, so a bar's click reads the records it counts.

**Decision (user, 2026-11-11):** split from bug 51 as its group B; no floor (VS Code 1.100.0) runs (user).

**Decision (2026-11-13, the recommended option; the user's standing instruction that day: "Do not ask me for approval, use the recommendation if I have to make a decision"):** the Kafka timestamp wins, since every read, the strip and Load older are built on it; the record's own `time` is shown on its row (its tooltip and accessible name) only when it differs, and the README states the rule.

## Boundaries & Constraints

**Always:** ListOffsets-by-time reads, per-partition positions and resume, Load older's anchors, bug 51 group A's left-out totals and gap marker, the 5,000 cap and its wording, `AROUND_MS` and the error tie-break by partition and offset, no strip for the live and recent ranges, `slotChosen` as `{from, to}`, bug 52's masking, the export's JSON (the value's own `time` kept; the Kafka time added only when there is none).

**Never:** A record counted in a bar it does not fall in; a new read path; a time field the webview must parse beyond an optional number.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| AROUND_DIFF | a record whose value `time` is 30 min from its Kafka timestamp; Show records around this one | the window is built on the Kafka timestamp; the record is in the rows read | — |
| ERROR_DIFF | the newest ERROR record's value `time` differs from its Kafka timestamp by more than 5 min; Show logs around the error | the record is in the window read and focused | — |
| OWN_TIME | value `time` differs | row shows the Kafka time; its tooltip names its own time | — |
| SAME_TIME | value `time` equal, missing or bad | row shows the Kafka time, no second time | — |
| STRIP_OUTSIDE | records whose Kafka timestamp falls outside the strip's span | not counted in any bar | — |
| LIVE_AFTER_RANGE | a bounded range, then Live; live records arrive | the span ends at the newest record read; a live record is counted in its own bar; that bar's click reads it | — |

</frozen-after-approval>

## Code Map

- `src/shared/logsProtocol.ts` -- `LogRow` :13-33 (`time` :16-17 doc "the value's `time`, else the record's timestamp"); validator :900 (`typeof v.time === 'number'`); `gapsIn` :1111-1115; `stripLayout` :700; `slotBounds` :716-720.
- `src/adapters/logs/records.ts` -- `parseLogTime` :34; `toLogRow` :74 (non-object :118 `time: record.timestamp`; object :135 `parseLogTime(value.time) ?? record.timestamp`).
- `src/adapters/vscode/logsPanel.ts` -- `Kept {row, ts, record}` :240-245 filled in `take` :1893; sort :1864; strip counts :1879; `oldestTs`/`newestTs` :1881-1882; `olderFrom` :1293, :1343; `olderAnchor` :566-571; export :829 (`kept.map(k => k.ts)`); `around()` :784-789 (uses `row.time`); `newestError` :1529-1541 (candidate :1537-1538); `showSearched` :1505-1512 (`focusTime` → `focusNotShownText` :1236); `get strip` :507-515; `chooseSlot` :733-739 (rejects unless `strip.from ≤ from < to ≤ strip.end`); `setLive` :962-985; `AROUND_MS` :128.
- `src/adapters/logs/filter.ts` -- `SlotCounter` :83-130, the clamp :111-112.
- `src/adapters/logs/history.ts` -- `stripSpan` :113-120 (ends at `range.to ?? max(chosenAt, readUntil, newest)`).
- `src/adapters/logs/export.ts` -- `exportLine` default and raw rows :18, :27 use `row.time`.
- `webview/src/logs/LogsView.tsx` -- time cell `localTime(row.time)` :672 (`localTime` :70); `gapsIn(state.rows)` :597; slot click :347.
- `README.md` -- :118 (row time), :120 (around the error), :126 (records per time), :128 (export).
- Tests: `src/test/adapters/logs/records.test.ts:86-91`, :20, :78; `filter.test.ts:178` SlotCounter; `history.test.ts:107`, :130-137 stripSpan; `webview/src/logs/LogsView.test.tsx` :266 gaps, :762-769 slot click, :796-814 `slotChosen`; `src/test/integration/suites/97-logs.ts` AROUND :1029, :1279, :1320, :1343, :1371, AROUND_FILTER :2584, AROUND_READING :2617, :2930, strip :1669-1886, EXPORT_NOTE :2755, Kafka-time export :1986; fake `src/test/helpers/fakeLogs.ts` `write` :29-35, :110-117; suite helpers `rec(id, text, ago, extra)` :150-153 (`extra` can set `time`), `recAt` :156-159.
- Prior plans: `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-records-per-hour-strip-plan.md` (:95 the clamp was designed in; :97 a bar's click shows its records); `_bmad-output/backlog/bug-pipeline-logs-reading-and-state-edge-cases-epic-6-retrospective-plan.md` (positions, left-out totals, gap marker).

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/logs/records.ts`, `src/shared/logsProtocol.ts` -- `toLogRow` sets `time: record.timestamp` always and an optional `ownTime` (the value's parsed `time`) only when it differs; `LogRow` docs and the validator accept the optional number -- one time.
- [x] `src/adapters/vscode/logsPanel.ts` -- confirm `around`, `newestError`, `showSearched` and `focusTime` now read the Kafka time through `row.time`; no other change unless a use still reads the value's time.
- [x] `src/adapters/logs/export.ts` -- the default and raw lines keep what they print today for a record whose two times agree; for one whose times differ, the line's time is the Kafka time and the JSON keeps the value's own `time` (no change to the JSON).
- [x] `webview/src/logs/LogsView.tsx` -- the time cell shows `row.time`; with `ownTime`, its `title` and accessible name add "Its own time: <local time>"; a light mark (e.g. a dotted underline) tells it apart.
- [x] `src/adapters/logs/filter.ts` -- `SlotCounter.strip` leaves out a minute outside `[0, count)` instead of clamping it.
- [x] `src/adapters/logs/history.ts`, `logsPanel.ts` `get strip` -- with Live on after a bounded range, the span ends at `max(range.to, readUntil, newest)`; `chooseSlot`'s bound check follows the span.
- [x] `README.md` -- :118 states the rule (the Kafka time; its own time in the tooltip when it differs); :126 the strip counts each record in its bar or not at all.
- [x] Tests -- unit: `toLogRow` (`ownTime` set only when different), `SlotCounter` (no clamp), `stripSpan` (live after range); webview: the tooltip with and without `ownTime`; integration (97-logs): AROUND_DIFF, ERROR_DIFF, LIVE_AFTER_RANGE (the last bar's click holds the live record). Show each fails on the baseline and passes on the fix; record it in Implementation Notes.

**Acceptance Criteria:**
- Given the matrix rows, when the unit, webview and integration tests run, then each row is covered and passes.
- Given compile with lint, corpus, webview, stable and multi-root runs, when they run, then all pass; an existing test changes only where it asserted the defect, and each such change is listed in Implementation Notes.

## Implementation Notes

- `toLogRow` (records.ts): `time` is always `record.timestamp`; `ownTime` (the value's parsed `time`) is set only when it parses and differs. `LogRow.ownTime?: number`; `isRow` accepts it absent or a finite number.
- `logsPanel.ts`: `around`, `newestError`, `showSearched`/`focusTime` read `row.time`, now the Kafka time; no change there. The only change is passing `this.live` to `stripSpan` in `get strip`; `chooseSlot` checks against `strip.from`/`strip.end`, so it follows the span with no change.
- `export.ts`: no change needed. A JSON row prints its value (its own `time` kept; the Kafka time added only when it has none, as before); a raw row's `row.time` was already the Kafka time.
- `SlotCounter.strip` (filter.ts): a minute before the strip's start, or starting after its `end`, is left out. The minute the span ends in still goes in the last bar, even when it is past the slots' whole sizes (a span that starts mid-minute): `slotBounds` makes the last bar end at `end`, so its click reads that minute. Without this, a strictly `[0, count)` rule would drop records the last bar's click does read.
- `stripSpan` (history.ts): new `live` argument. For a bounded range with Live on, the end is `max(range.to, readUntil, newest)`.
- Webview: the time cell shows `row.time`. With `ownTime` it is wrapped in `.rpcn-logs-own-time` (dotted underline, `title` "Its own time: <local time>"), with a screen-reader-only ". Its own time: …" so the cell's accessible name carries it (`ownTimeText` exported).
- README: the row-time rule (in the Show logs paragraph) and the strip rule (in Records per time).
- Existing tests changed because they asserted the defect: `records.test.ts` RECORD (the row's `time` was the value's time; it is now the Kafka time, plus `ownTime`); `filter.test.ts` SlotCounter ("a record outside the span counts in the nearest slot": now left out, so the total is 3 and bars 0 and 59 are empty); `97-logs.ts` `slotted` helper (it modelled the clamp; it now models the leave-out rule).
- New tests: records (`ownTime` only when different; SAME_TIME for missing and bad), filter (end-minute rule, outside left out), history (`stripSpan` with Live after a range), webview (tooltip and accessible name, with and without `ownTime`), integration LIVE_AFTER_RANGE, AROUND_DIFF + OWN_TIME, ERROR_DIFF.
- Baseline: with the source files reverted to 27f7060 and the new tests kept, 5 unit tests failed (mocha on tsc output), the webview OWN_TIME test failed, and `vscode-test --label stable --grep "bug 53"` failed 4 of 4 (LIVE_AFTER_RANGE "the span ends at the newest record read"; AROUND_DIFF "the row's time is the Kafka timestamp"; ERROR_DIFF range mismatch; SlotCounter end minute). With the fix, all of them pass.
- Verification: `npm run compile` (lint included) exit 0; `test:corpus` 182 passed; `test:webview` 383 passed; stable (VS Code 1.146.0) 1500 passing, 0 failing, 1 pending; multiroot 15 passing. No floor run. The manual dev-host check is left to the user.

- Review fixes (2026-11-13):
  - `ownTime` only when the two times differ by 1 s or more (`OWN_TIME_MIN_DIFF_MS`).
  - A record with a negative Kafka timestamp is shown at the value's `time`, with no `ownTime`.
  - `stripSpan` for a bounded range always ends at `max(to, newest)`, plus `readUntil` while Live is on.
  - `SlotCounter.strip` posts `from`/`end` widened to whole minutes; the bars stay those of the span given, so Last 24 hours keeps 48. Every counted minute lies inside its bar's `slotBounds`, and `chooseSlot` checks the widened span.
  - The hidden own-time text has `user-select: none`.
  - Validator tests for a bad `ownTime`.
  - 97-logs assertions moved to the whole-minute span: SLOTS `s.end`, LOAD_OLDER stopped `s.from`, LIVE_AFTER_RANGE `s.end >= live` and Live off.
  - Verification for these fixes: unit (logs) 50 passing, `LogsView.test.tsx` 52 passed, stable `--grep "Pipeline logs (integration"` 111 passing.

## Plan Change Log

- 2026-11-13 (implementation): the `SlotCounter` task said to leave out "a minute outside `[0, count)`". It is implemented as "a minute before the start or after `end`", with the minute the span ends in kept in the last bar. That bar's click (`slotBounds`) reads up to `end`, so this keeps "a bar's click reads the records it counts" when the span starts mid-minute. Intent unchanged.

## Review Triage Log

Thorough review (2026-11-13; blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Verdicts: 0 high, 4 medium, 7 low (5 patched, 2 rejected), 1 false; intent-alignment descriptive. Routes: 9 patch, 0 defer, 0 loopback.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 1 | BH, IA | `ownTime` set for any difference: nearly every real row would be marked | medium | patch | A logger's time and the producer's timestamp differ by ms; threshold 1 s, README says so. |
| 2 | BH, EC, IA | Edge bars count records in the span's partial first and last minutes that their clicks do not read | medium | patch | Counts per minute, `slotBounds` cut at `from`/`end`; the span aligned to whole minutes. |
| 3 | BH, EC | Live off (or the cap pause, Stopped) drops live records already read from the strip | medium | patch | The span grew only while `live`; ends at `max(range.to, newest)` always. |
| 4 | EC | A record with no Kafka timestamp (-1) shows 1969; the old fallback to the value's `time` is gone | medium | patch | Fall back to the value's time when `timestamp < 0`. |
| 5 | BH | LIVE_AFTER_RANGE asserts `s.end === live.timestamp`; `readUntil` can end it later | low | patch | `>=`. |
| 6 | BH, EC | Copying rows copies the hidden ". Its own time: …" | low | patch | `user-select: none` on the hidden text. |
| 7 | VG, BH | `isRow`'s `ownTime` clause untested | low | patch | Rejection cases added. |
| 8 | BH | `stripSpan` live cases untested (`readUntil` > newest, `olderFrom`, deploy range) | low | patch | Unit cases, with 3. |
| 9 | BH | Stale test name and an overlong header comment | low | patch | Rename, rewrap. |
| 10 | BH | Strip total can be below the chips with no word why | low | patch | One README sentence; after 2 and 3 only out-of-order CreateTime records are left out. |
| 11 | BH | The own time is only in a `title`, unreachable by keyboard | low | reject | Screen readers get the hidden text; a focusable mark adds a control to every such row. |
| 12 | BH | Search and chips cannot see the own time | false | reject | `time` was never a searchable field (a column field, left out of `fields`) before or after. |

Intent-alignment notes (descriptive): reading R1a (the row's `time` is the Kafka time, every consumer follows by inheritance); R2b (tooltip and accessible name, no second visible time); R3a strict ms (patched to 1 s); R4a (span grows for Live after a bounded range; patched to keep live records after Live off); tests at the model and panel API, not a webview bar click.

## Design Notes

With the Kafka timestamp in `row.time`, every host use that reads `row.time` follows it without its own change; `Kept.ts` stays for the sort and anchors. The strip's span already starts at `min(range.from, olderFrom)` and, for an unbounded end, at the newest record read, so leaving out instead of clamping only drops records whose CreateTime is out of order with the read; the strip's totals then count what its bars show. The footer's record count is not the strip's total and stays as it is.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (lint included)
- `npm run test:corpus`, `npm run test:webview` -- expected: pass
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: 0 failing
- same with `--label multiroot` -- expected: 0 failing

**Manual checks (if no CLI):**
- Dev host on the user's cluster (left to the user): a row whose own time differs shows it in its tooltip.

**Result (2026-11-13, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 383, stable 1502 passing, 1 pending, 0 failing (12 min), multi-root 15 passing; the test settings clean; no floor run. Manual check left to the user: on the dev host, a row whose own `time` differs from its Kafka timestamp by a second or more shows it in its tooltip.
