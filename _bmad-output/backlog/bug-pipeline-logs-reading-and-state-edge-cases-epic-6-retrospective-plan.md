---
title: 'Pipeline logs read every partition fully and read what their status says'
type: 'bugfix'
ticket: '51'
created: '2026-11-11'
status: 'built'
baseline_revision: '65f419802719e6d7137e77c4efd34c470532c014'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs-retrospective.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bug 51 group A (criteria 1–4; findings C1–C5, C8–C11, C13, C15; tests G1–G4, V3). A retry after "Connection lost" resumes every partition from the newest time seen on any, skipping records on a partition that was behind; a batch with no record at or after the position never moves it; a failed metadata re-read ends the read; a leader of −1 is fetched. A filter or access change on the live log re-reads from when the panel opened; a filter or Live change drops the around-the-error search silently; that search cannot be stopped; Stop reading then Live drops the rows; Set up log access across pipelines is ignored. Load older overwrites the left-out count; an export names no filter.

**Approach:** The reader reports and resumes per-partition positions, always advances past a batch, retries a failed metadata read, waits on a missing leader. The panel's read transitions follow the matrix, every multi-request read is in Reading with Stop, the left-out counts add up, and the export says its filter and carries each record's time.

**Decisions (user, 2026-11-11, the recommended options):** after a filter or access change the live log reads the last 15 minutes from then; during the around-the-error search a filter change keeps it and Live on ends it with a message; a gap left by the cap is one marker row.

**Decision (user, 2026-11-11):** bug 51 split; group A first; groups B (time and strip) and C (search) are in deferred work. The review runs the adversarial and edge-case lenses (epic 6 retrospective AI-6).

## Boundaries & Constraints

**Always:** bug 52's behavior (Forget, Stopped, masking, NO_LEAK, WRITE_FAIL) unchanged; the 5,000-record cap and its "left out" wording; every read bounded in time; every other Pipeline Logs behavior as today.

**Never:** groups B and C (one time per record, the strip's bars, slow patterns); a new dependency; a floor (1.100.0) run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| RESUME_PARTS | a range read on several partitions, one behind, then "Connection lost" and a retry | each partition resumes from its own last record; no record is skipped or doubled | as today |
| BATCH_ADVANCE | a fetched batch with no record at or after the position | the position moves past the batch; the tail does not spin, the range does not stall on it | none |
| META_RETRY | a fetch fails, then the metadata re-read fails | the metadata read is retried as a failed fetch is; "Connection lost" only after the retries | as today |
| LEADER | a partition with leader −1, or missing from the metadata | not fetched; waited on until it has a leader, within the read's time limit | named in the log |
| LIVE_FILTER | the live log followed for a while; the filter changes, or new log access is set up | the range is rebased on the time of the change: the last 15 minutes from then are read with the filter, then followed; the status is true | none |
| AROUND_FILTER | the around-the-error search running; the filter changes / Live is turned on | a filter change runs the search again with the filter; Live on ends the search with a message, then follows | none |
| AROUND_READING | the around-the-error search running | the panel is in Reading with a count and Stop reading; Stop ends it with a message, rows kept | none |
| STOP_THEN_LIVE | a bounded range stopped by Stop reading; Live turned on | the rows read stay and Live follows on from where the read stopped | none |
| SETUP_OTHER | Set up log access started for pipeline P; the panel switches to pipeline Q | Set up and Use another user work for Q; a request that cannot run says why in the panel | none |
| LEFT_OUT | records left out by the cap, then Load older (and the tail at the cap during it) | the footer, "N older left out" and the export message are the totals for the rows held; a gap between two reads is one marker row, "N records left out here", counted in the footer total | none |
| EXPORT_NOTE | an export with a filter active; a record with no `time` field | the message names the filter; the record's line carries its Kafka time | none |

</frozen-after-approval>

## Code Map

- `src/adapters/logs/platformaticReader.ts` -- `partitions()` :197 (`map((p, i) => [i, p.leader])`; the client stores `partitions[partitionIndex] = {leader: leaderId, …}`, `node_modules/@platformatic/kafka/dist/clients/base/base.js:532-534`, so index = id; a missing partition is a hole, which makes `new Map` throw; leader −1 is passed through); `fetchFrom` :244-262 (advance only past records ≥ position; batch has `firstOffset: bigint`, `lastOffsetDelta`, `dist/protocol/records.d.ts:79-93`); `fetchRound` :273-300 (`partitions()` re-read in the catch :288, a throw there exits); `tail` :320-359 (`resumeAt`, `onRecords(records, next)`); `range` :361-422 (keeps `at` per partition :369, :403; callback gets no positions :412; aborted range returns `{start, next}` :416-417).
- `src/adapters/logs/logReader.ts` :113-119 -- the `LogReader` interface (range's callback and a per-partition resume).
- `src/adapters/vscode/logsPanel.ts` -- state fields :268-345, `Session.kind` :223-226, `Kept = {row, ts, record}` :216-220; `panelState` :456-480 (reading only for `range && pendingRange` or `olderSession`); `clearRead` :798-812, `reset` :814-836; `setFilter` :670-713 (`reset(this.range, this.chosenAt)` :691); `setLive` :847-876 (:869, :875); `tail` :1028-1063 (from `this.range.from` :1045 or `positions`); `readRange` :1065-1149 (`resumeAt = rangeReached` :1074, :1093-1101); `findError` :1237-1306 (`session = range`, `pendingRange` false :1241); `prepend` :1723-1751 (`this.dropped = merged.leftOut` :1736; `newerDropped` summed :1741); `receive` :1708; `stopReading` :1540-1565 (:1550 needs `pendingRange`); `setUpAccess` :1567-1608 (`settingUp` :344 single boolean, not reset in `show` :587-621; silent false :1569, :1580); bug 52's `revoke` :1471-1511 and Stopped refusals (:626, :675, :849, :719, :1153, :956, :918-923) — keep; `exportShown` :750-796.
- `src/adapters/vscode/cloudLogs.ts` :230-233 -- a second Set up per cluster ignored with a log line.
- `src/adapters/logs/history.ts` `mergeOlder` :57-62; `src/adapters/logs/export.ts` `exportLine` :10-15 (writes `row.json` as is), `exportedMessage` :40-50 (no filter part); `src/shared/logsProtocol.ts` `filterActive` :86 (no describer yet); `webview/src/logs/LogsView.tsx` :280 (Set up disabled on `settingUp`).
- `src/adapters/vscode/cloudActions.ts` `paletteTarget` :139, cluster-gone branch :163-168; callers Start/Stop/Delete :100-111 (no `pickAfterGone`) and `cloudLogs.ts` `logsTarget` :476-488 (with it) -- G3.
- Tests: `src/test/adapters/logs/platformaticReader.test.ts` fake :14-113 (`partitions`, `leaders` can return −1, `onMetadata` can throw, `fetchFailures`, `emptyFetches`, a batch starting before the offset :83-90; add `lastOffsetDelta`, a batch of only earlier records, a sparse partition list), retries :198, :216, range :246, :266, :307; `src/test/helpers/fakeLogs.ts` (`partitions` :93-97, `write(partition)` :29, :103; `range` reads p0 fully first :235-252, `dropRangeAfter` :243 — reproduces C1 with interleaved times; add per-partition positions to `range`); `src/test/integration/suites/97-logs.ts` setup :250 (one partition), AROUND :1272-1364, FORGET around :2471, NO_ACCESS :1399, SIGN_IN :1417, NOT_ALLOWED :1447, SETUP_ONCE :1495, RANGE_RESUME :1502 (asserts `fromTime` = the reached time :1528 — changes with C1), READING :1559, PALETTE_MAPPED :1091-1122, exports :1947-2124 (OVER_CAP :2026); `newerDropped` asserted at :660, :677, :1329.

## Tasks & Acceptance

**Execution:**
- [ ] `platformaticReader.ts`, `logReader.ts`, `fakeLogs.ts` -- per-partition positions out of `range` and a per-partition resume; advance past every batch; the metadata re-read retried; holes and leader −1 waited on.
- [ ] `logsPanel.ts` (and `cloudLogs.ts`, `LogsView.tsx` where needed) -- the transitions per the matrix: resume from positions, LIVE_FILTER, AROUND_FILTER, AROUND_READING, STOP_THEN_LIVE, SETUP_OTHER, LEFT_OUT; bug 52's Stopped and revoke kept.
- [ ] `export.ts`, `logsProtocol.ts` -- the filter named in the export message; a record's Kafka time in its line when it has no `time`.
- [ ] tests: unit (reader: RESUME_PARTS, BATCH_ADVANCE, META_RETRY, LEADER; export), integration per matrix row with a several-partition fake (V3), and G1 (filter or Live during the search), G2 (Set up from the tab returning to the search with Live and the filter kept), G3 (the cluster-gone palette branch, both callers), G4 (an export message with newer records dropped); RANGE_RESUME's assertion changed to per-partition positions (Plan Change Log).
- [ ] `CHANGELOG.md` -- one "Fixed:" line.

**Acceptance Criteria:**
- Given the change, when a matrix row's fix is removed, then its test fails.
- Given bug 52's tests and NO_LEAK, when the suites run, then they pass unchanged.

## Implementation Notes

- C13 checked against the client: `base.js` stores `partitions[partitionIndex]`, so the array index is the id; `partitions()` now walks 0..length−1, keeps only leaders ≥ 0 and lists every id in `all`. A missing partition is a hole (detected only below the highest id). Leaderless partitions are re-read every `leaderWaitMs` (1 s); in a range they are given up after `stallMs` (30 s) and reported as `LogRangeEnd.leaderless` (status: "Partition N had no leader, so it was not read."); both readers name them in the output channel through the new `log` option (wired in `cloudView.ts`).
- `LogReader.range` gained `(records, next)` and `resumeAt`; the panel keeps `rangeAt` (replacing `rangeReached`) for the retry and for Stop reading → Live. The fake reads one partition fully, then the next, so a second partition is behind in time (V3).
- LIVE_FILTER: a filter or access change with Live on rebases both `recent` and `live` (Live from now on) to `{kind: 'recent', from: now − 15 min}`, so the menu then says "Last 15 minutes, then live" (the read that is made). `deploy`, Live off and bounded ranges are read as before (`readAgain`).
- AROUND: the search is a `search` session (Reading, count of the pipeline's records read, Stop reading → `stoppedSearchStatus`, no strip). Live on → `AROUND_ENDED_BY_LIVE_NOTE` in the note row.
- SETUP_OTHER: `settingUp` is per cluster (`settingUpFor`); a second request from the tab, or one while the row's Set up runs (`setUpAccess` returns `{ refused }`), puts `setUpRunningText(cluster)` in the note row.
- LEFT_OUT: `dropped` (left out before the oldest row) plus per-row `gaps`; `droppedCount` is the total (footer, `append`/`prepend`/`show`, export). Load older: left out = (before − read back) + left out of its batch; rows the tail left out meanwhile become one gap before the oldest kept row (`viewState.leftOutHere`, webview marker row "N records left out here"); a gap reaching the front folds into `dropped`, one dropped from the back into `newerDropped`.
- EXPORT_NOTE: `filterText` (logsProtocol) names the filter in `exportedMessage` ("Exported N records matching the filter (…) to f."), masked by the panel; `exportLine(row, kafkaTime)` puts `time` first on a JSON object without one.
- Review fixes (triage #1–25): the reader keeps the most partitions seen (a trailing missing one is a hole), remembers since when each partition has had no leader (a later `range` does not wait again; each line once until it has a leader), resets the empty count while a partition has no leader, retries the late placement's ListOffsets, caps a late partition's stop by the range's time (documented on `LogReader.range`), and uses the abort-aware `sleep` and one `retriable()`; `logStart` gives −1 for a leaderless partition, so it is never at the log's start, and the search's note and Load older's row say "Partition N had no leader, so it was not read." (Load older then stays "more"). The client decodes only whole batches (`readRecordsBatches` reads a batch only when `remaining − 12 ≥ length`; a cut one is left out whole), so the advance past `lastOffsetDelta` stays. Panel: LIVE_FILTER rebases `recent` and `live` on the change, Live on or off, the kind kept (the menu keeps "Live (from now on)"); a remask's carried gap joins `dropped`, read-backs skip rows a remask removed, Load older's gap is the tail's own drops (`olderStart.tailDropped`), `gapsChanged` only when a gap went; Stop on the search with an ERROR candidate shows around it; the search counts records by partition and offset; Set up for cluster A reads the shown pipeline of A with the new access; the footer and the export say "records left out" when gaps are in the total; no quiet-stretch row after a left-out marker. Export: `time` left out for an invalid Kafka time; the search text quoted with `JSON.stringify`.

## Plan Change Log

- RANGE_RESUME (97-logs.ts): asserts `resumeAt` = `[[0, 500]]` and the range's own `fromTime` instead of the newest reached time (C1).
- 6.3's LEFT_OUT (97-logs.ts): asserted `droppedCount` 0 after a Load older whose window read back only one of four left-out records — that was C5's undercount; it now asserts 3, then 2, then 0.
- EXPORT_ACCEPTANCE: its message now names the filter (EXPORT_NOTE). export.test `exportText` expects the Kafka time on the `{"message":"a"}` row.
- Review fixes: LogsView.test LEFT_OUT's footer, whose 2 left out are all in a gap, now expects "3 records kept (at most 3); 2 records left out." (was "2 older records left out; Load older to page back."); 97-logs LEFT_OUT (G4)'s export message expects "2 records were left out" (was "2 older records were left out"), the 2 being the gap; EXPORT_ACCEPTANCE's assertion message (not its check) says the Kafka time is added only as `time`; PALETTE_GONE also runs Delete.

## Review Triage Log

Thorough review (2026-11-11; blind-hunter, edge-case-hunter, verification-gap, intent-alignment): 0 high, 10 medium and 17 low patched, 6 rejected, 1 deferred. Every patch routed to the implementer in one message; none needed a plan loopback (each is a local fix inside the plan's scope).

| # | Finding | Lenses | Verdict | Route |
|---|---------|--------|---------|-------|
| 1 | A partition missing at the end of the metadata answer is never read, waited on or named | blind, edge, edge claim | medium | patch (keep the highest count seen) |
| 2 | Leaderless partitions are left out of `logStart`/`atLogStart`: "No older records" or "No ERROR record" while a partition was never read | blind, edge | medium | patch; the search and Load older name it |
| 3 | The leaderless wait restarts in each `range()` call: 24 windows × 30 s, two log lines per window | blind | medium | patch (remembered on the reader) |
| 4 | `emptySince` not reset by a leader loss: a partition marked stalled at once, or stalled instead of leaderless | blind, edge ×2 | medium | patch |
| 5 | The late `place()` ListOffsets is not retried: one blip ends the read | edge, edge claim | medium | patch |
| 6 | Batch advance past `lastOffsetDelta` may skip records of a truncated last batch | edge | medium (maybe-false until the decoder is read) | patch (check the decoder; guard) |
| 7 | LIVE_FILTER rebased only with Live on; a `live` range becomes Last 15 minutes and the menu label changes | intent, blind | medium | patch (both kinds, Live on or off; the user's kind kept) |
| 8 | `remask` books a carried gap as "newer dropped" | blind, edge, vgap | medium | patch |
| 9 | Stop during the search discards an ERROR candidate already read | edge | medium | patch |
| 10 | Set up succeeding for cluster A leaves the tab, on another pipeline of A, at No log access | edge | medium | patch |
| 11 | `readBack` subtracts rows a remask removed, never counted as left out | edge | low | patch |
| 12 | `prepend`'s `tailDropped` counts remask or fold changes as a gap | edge | low | patch |
| 13 | `gapsChanged` is true whenever a gap exists: a full state post per append | blind | low | patch |
| 14 | `searchCount` counts a window-boundary record twice | edge | low | patch |
| 15 | Gap records are called "older records left out" | intent | low | patch (wording) |
| 16 | A "No records from X to Y" row can sit next to the left-out marker | blind | low | patch |
| 17 | Backoffs ignore the abort; the retry classification is copied | blind | low | patch |
| 18 | The late-placed partition's stop offset is taken at placement time | blind, edge | low | patch (cap, or the doc) |
| 19 | The export's `toISOString` can throw on a bad timestamp | edge | low | patch |
| 20 | `filterText` does not quote the search text | blind | low | patch |
| 21 | `exportedMessage`'s doc comment, the export header and an assertion message are out of date | blind | low | patch |
| 22 | No test: the default reader's `log` reaches the output channel | vgap, intent | low | patch (test) |
| 23 | No test: the panel's "had no leader" status | vgap, intent | low | patch (test) |
| 24 | No test: gap counts after the tail pushes the marked row out, or a remask removes it | vgap | low | patch (tests) |
| 25 | PALETTE_GONE does not assert Delete | intent | low | patch (test) |
| 26 | The export adds `time` though a record may carry `timestamp`/`ts`/`@timestamp` | blind | low | reject: the frozen EXPORT_NOTE row names the `time` field only |
| 27 | PALETTE_GONE has no source change | blind | low | reject: G3 was a test gap on existing behavior (the retrospective) |
| 28 | After Stop on the search, a filter change reads the whole 24 hours as a plain range | blind | low | reject: a stopped search is a Last 24 hours range; reading it with the filter is what the range says |
| 29 | `setUpKey` falls back to the title; two guards (panel and CloudLogs) | blind | low | reject: every log source has a `clusterId`; CloudLogs' guard is the one that counts |
| 30 | Integration tests drive host methods on one partition; no webview test of the search's Reading or the setup note | intent | low | reject: the host owns these states; the webview renders `viewState`, covered for the marker |
| 31 | The reader's Kafka-level fixes are tested on `fakeKafka` only | intent | low | reject: the real client needs a broker; the spike and manual checks cover it (epic 6 decision) |
| 32 | The tail names a leaderless partition in the output only; Live says Following | blind | low | defer |

## Verification

**Commands:**
- `npm run compile` -- expected: 0, lint included.
- `npm run test:corpus`; `npm run test:webview` -- expected: pass.
- `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); then `--label multiroot` -- expected: all pass. No floor run.

**Result (2026-11-11, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 381, multi-root 11. Stable: the first run 1445 passing, 1 failing (Environment view ACTIONS, a 60 s timeout, not this change's code, with other jobs loading the machine: the run took 19 min against about 10); the rerun alone 1446 passing, 1 pending, 0 failing. The test settings clean; no floor run. The review fixes were applied by a second implementer after the first was stopped by the user.

**Manual checks:**
- Dev host 1.143.1 on the user's cluster: follow the live log a few minutes, then type a search (it reads the last 15 minutes from then); Show logs around the error, then Stop reading (it stops, the rows stay).

**Results (2026-11-11):** `npm run compile` 0 (lint clean); `test:corpus` 182 passed; `test:webview` 380 passed; stable 1435 passing, 1 pending, 0 failing (VS Code 1.146.0 from .vscode-test); multiroot 11 passing. No floor run. Manual checks on the user's cluster not run (they need the user's cluster and dev host).
