---
title: 'Read back the log''s history'
type: 'feature'
ticket: '3'
created: '2026-11-05'
status: 'done'
baseline_revision: 'b1e150594b8ccb3cf0e75357481969ebfe3f296a'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-tracer-set-up-log-access-and-show-a-pipeline-s-live-log-plan.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/spike-6-1-findings/findings.md
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - src/adapters/logs/logReader.ts
  - src/adapters/logs/platformaticReader.ts
  - src/adapters/vscode/logsPanel.ts
  - src/shared/logsProtocol.ts
  - webview/src/logs/LogsView.tsx
  - src/test/helpers/fakeLogs.ts
  - src/test/integration/suites/97-logs.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Pipeline Logs tab (6.2) shows only the last 15 minutes and then follows live; an error from yesterday, or what a pipeline logged before its last restart, cannot be seen.

**Approach:** A time-range menu in the panel's toolbar (board 5): Live (from now on), Last 15 minutes then live (today's default), Last hour, Last 24 hours, Last 7 days, Since the last deploy, Custom range… (From and To in local time). A range other than the two live ones is read from its start to its end and then stops (Live off). **Load older records** at the top of the list reads further back; a note row marks a silence of 30 minutes or more, and a range with no records says so; the menu says records older than the topic's retention are gone.

**Decisions (user, 2026-11-05):**
- Over the 5,000-record cap, a range keeps its newest 5,000 and the footer says older ones were left out; Load older then reads back from the oldest shown, dropping the newest and pausing Live, so any range can be paged back through.
- A gap note between two shown records 30 minutes or more apart, and for a range with no records.

## Boundaries & Constraints

**Always:**
- AD-24: ListOffsets by time for a range's start, read forward; never below the log's first offset; records older than the brokers' local retention come from tiered storage through the same fetch; no consumer group.
- "Since the last deploy" is the pipeline's `update_time` from the Data Plane (AD-23), read fresh when chosen.
- Load older reads the window of the range's length (15 minutes for the live default) ending at the oldest shown record, repeatedly further back while a window is empty, stopping at the log's first offset (then "No older records").
- The retention shown is the topic's `retention.ms` when DescribeConfigs is allowed, else "within the topic's retention".
- 6.2's rules stand: one pipeline at a time, masking, `license_org` never shown, reading stops while the tab is hidden, requests only on the user's action.

**Never:**
- Filters, search, the per-hour strip, export, the full error states (6.4–6.8); a reader for more than one pipeline at a time.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| RANGE | Last 24 hours | the pipeline's records of the last 24 hours, oldest first; reading stops at the range's end; Live off | a read failure: the status line, as 6.2 |
| LIVE_DEFAULTS | Live; Last 15 minutes then live | Live: no history, new records only; the default: as 6.2 | none |
| SINCE_DEPLOY | Since the last deploy | from the pipeline's `update_time` to now, then live | the pipeline gone: said so, nothing read |
| CUSTOM | Custom range…: From, To | that range; To before From, or From in the future: refused in the menu | an unparsable date: refused |
| OVER_CAP | a range with more than 5,000 of its records | the newest 5,000; the footer: "older records left out; Load older to page back" | none |
| LOAD_OLDER | Load older records | the window before the oldest shown, prepended; at the cap the newest are dropped and Live pauses | at the log's first offset: "No older records" and the button gone |
| EMPTY_WINDOWS | Load older over a window with no records | goes further back until a window has records or the log's start | none |
| GAP | two shown records 30 minutes or more apart; a range with none | a note row "No records <from> – <to>"; for an empty range the note fills the list | none |
| RETENTION | the menu open | "Records older than 7 days are gone" (from `retention.ms`) or "within the topic's retention" | DescribeConfigs refused: the second text |
| SWITCH | another range, or another pipeline, while a range is read | the earlier read stops; the new one starts | none |

</frozen-after-approval>

## Code Map

- `src/adapters/logs/logReader.ts` -- `LogReader` gains a bounded read: `range(pipelineId, fromTime, toTime, onRecords, signal)` (forward from ListOffsets(fromTime) to the first record past `toTime` or the end offsets taken at its start), `logStart()` (the earliest offsets), and `retentionMs()` (DescribeConfigs, `undefined` when refused); `tail` unchanged.
- `src/adapters/logs/platformaticReader.ts` -- implement them with the 6.2 consumer, admin and retries; `scripts/spike/logs-probe.mjs` seeks (~:1116) show the ListOffsets and earliest-offset use on the real cluster.
- `src/adapters/cloud/dataPlane.ts` `pipelineFrom` -- keep `update_time` (as a number of milliseconds) for "Since the last deploy".
- `src/adapters/vscode/logsPanel.ts` -- the range state (kind, from, to), Load older (the window, the empty-window walk back, the log start), the cap rule (newest kept; Load older drops the newest and pauses), gap rows, the retention text; stop the earlier read on a new range.
- `src/shared/logsProtocol.ts` -- messages: the webview's range choice and Load older request; the host's range state, prepended rows, gap rows (or the gaps computed in the webview from row times: pure, unit-tested), "no older records", the retention text.
- `webview/src/logs/LogsView.tsx` -- the range menu (board 5: options, Custom range From/To inputs with validation, the retention line), Live toggle state, Load older button and "No older records", gap rows, the footer's left-out note.
- `src/test/helpers/fakeLogs.ts` -- records over days, a log start offset, retention (or refused), `update_time` via the fake Cloud.
- Tests: `src/test/integration/suites/97-logs.ts` for every matrix row; unit tests for the window and gap logic and the reader's `range`; webview tests for the menu and Load older.
- `README.md` Pipeline logs section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `logReader.ts`, `platformaticReader.ts` + unit tests -- `range`, `logStart`, `retentionMs`.
- [x] `dataPlane.ts` -- `update_time`.
- [x] `logsPanel.ts`, `logsProtocol.ts`, `webview/src/logs/*` + tests -- the menu, Load older, cap, gaps, retention.
- [x] `fakeLogs.ts`, `97-logs.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a fake topic with a pipeline's records over 3 days, when Last 24 hours is chosen and then Load older twice, then the panel shows the last 24 hours, then the 24 hours before, then the day before that, oldest first, with a gap note wherever 30 minutes or more pass without a record.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute (vscode-test under `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`), then all pass.

## Implementation Notes

- `LogReader` gains `range(pipelineId, from, to, onRecords, signal) → { start, next }` (every partition from ListOffsets(from) to min(ListOffsets(to + 1), the end offsets at its start), fetches without a wait; `start` is what Load older compares with the log's start, `next` where Live goes on), `logStart(signal)` (ListOffsets earliest) and `retentionMs(signal)` (an `Admin`'s DescribeConfigs of `retention.ms`; any failure `undefined`, `-1` no limit). `logStart` and `retentionMs` take a signal (the plan named them without one): `range` and `logStart` share one client per reader until their signal aborts, so a walk back through empty windows signs in once; the panel aborts it when the walk ends.
- `range` ends a partition after 3 fetches in a row that return nothing below its stop (a guard against looping on an offset with no batch); tail's retry and out-of-range handling moved into a shared `fetchRound`.
- Pure rules in `src/adapters/logs/history.ts` (range times, the Load older window, `mergeOlder`, `atLogStart`, the retention text) and in `src/shared/logsProtocol.ts` (range kinds and labels, `parseLocalDateTime`, `customRangeError`, `gapsIn`, the webview message validator); the gaps are computed in the webview from the rows' times.
- Live ranges: `live`, `recent`, `deploy` (tail from their `from`); bounded: `hour`, `day`, `week`, `custom` (range, then Live off). The Load older window is the range's length with a floor of 15 minutes (a since-deploy or custom range shorter than that would walk back minute by minute). Its end is the oldest kept record's Kafka timestamp (the panel keeps it beside each row); overlaps are dropped by row id.
- The cap: a forward read drops the oldest and counts them as left out (`dropped`, the footer: "N older records left out; Load older to page back"); Load older takes the newest `cap` of its window, then drops the newest of the whole (`newerDropped`, "N newer records dropped"), pausing Live. Live on after that (or with nothing read) reads the default range again, since the positions after the newest shown are gone; otherwise it goes on from the tail's or the range's end positions.
- Since the last deploy: `LogSource.lastDeploy()` (the Cloud view's `GET` of the pipeline, `update_time` as milliseconds on `CloudPipeline.updateTime`); a 404 is an info "Pipeline <name> is no longer on <cluster>, so it has no last deploy. Nothing was read." and the panel keeps what it shows. The menu's label shows the cached time when the row has one.
- The retention is read when the menu opens (`retentionRequested`), once per pipeline shown. A bounded range interrupted by hiding the tab is read again from its start when the tab shows.
- Test seams: `chooseRange`, `loadOlder`, `setLive`, `requestRetention`, `viewState`, `readingOlder`; the fake gains `range`, `logStart` (per-partition first offsets), `retentionMs` (`'refused'`), `rangeDelayMs`, and records every range read.

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && env -u WAYLAND_DISPLAY -u DISPLAY xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: Last 24 hours on a pipeline that logged yesterday (records from tiered storage); Load older; Since the last deploy; a custom range with no records (the note).

- After review (2026-11-05), superseding the notes above where they differ: a range keeps fetching a partition below its stop with a 500 ms wait and gives it up only after 30 s without progress (reported as "stopped short"); Load older over an empty window jumps to the newest record before the window's start (`timeBefore`), so a silence costs at most one empty window when only this pipeline logs; a choice counter, Load older refused during a range read, stale state reset on a re-read, and Load older failures shown in their row.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | "Since the last deploy" chosen, then another range while its GET is slow: the deploy range wins when the GET returns | medium | `chooseRange` checks only `source !== this.source` after awaiting `lastDeploy()`; breaks SWITCH | patch (a choice counter checked after the await) |
| 2 | Load older is allowed while a bounded range is still read; at the cap the forward read keeps appending, leaving a hidden hole and re-trimming the prepended rows | medium | `loadOlder` checks neither `session.kind === 'range'` nor `pendingRange`; `prepend` stops only a tail | patch |
| 3 | A range read again after the tab is shown keeps a stale `older` and `newerDropped` | low | `readRange` resets `kept`, `keptIds`, `dropped` only | patch |
| 4 | A range gives a partition up after 3 back-to-back zero-wait empty fetches, which can end a tiered-storage read early and skip records | medium | `platformaticReader.ts` `range`, `maxWaitTime: 0`, `EMPTY_FETCHES` 3; findings: tiered reads are slower | patch |
| 5 | The tail's "Following" status overwrites a Load older failure within a second; a reader failure in Load older says "Reading stopped" though reading goes on | low | `tail` callback sets `FOLLOWING_STATUS` per fetch; `loadOlder` → `failed()` | patch |
| 6 | (triage) Load older over a long silence steps back one window at a time: hundreds of ListOffsets for a quiet week (the implementer's own risk note) | medium | the walk back in `loadOlder` | patch (jump to the record before the oldest shown) |

**Verification (2026-11-06):** compile, corpus 156, webview 345, multiroot 10, stable 1287 passing with one failure, COPY_ID, which read the desktop clipboard through the Wayland session; rerun alone with `-u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11` it passed while the desktop clipboard held other text. The floor run was stopped: the user does not test on VS Code 1.100.0 (2026-11-06), so the floor is out of Verification.

**Manual check result (user, 2026-11-06):** passed on the 1.143.1 dev host against the real organization: "tested, no issues" (vscode-tracer.yaml with a `log` processor at INFO every 5 s; the time ranges, Load older, gap notes, Since the last deploy, a custom range and switching ranges).
