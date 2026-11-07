---
title: 'Records-per-hour strip'
type: 'feature'
ticket: '7'
created: '2026-11-06'
status: 'in-review'
baseline_revision: '10962d4759b4184a6f47e0e24ba731bab49a30e5'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-read-back-the-log-s-history-plan.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-filter-and-search-the-log-plan.md
  - src/adapters/vscode/logsPanel.ts
  - src/adapters/logs/filter.ts
  - src/adapters/logs/history.ts
  - src/shared/logsProtocol.ts
  - webview/src/logs/LogsView.tsx
  - src/test/helpers/fakeLogs.ts
  - src/test/integration/suites/97-logs.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A long range (a day, a week) shows thousands of records in a list; where the pipeline was busy, quiet or failing is not visible without scrolling.

**Approach:** Board 5's strip above the history list: one bar per time slot of the range read, its height the number of the pipeline's records in that slot, the errors and warnings marked on top; clicking a bar shows that slot's records. The strip shows for bounded ranges only.

**Decisions (user, 2026-11-06):**
- Bars fit the range: about 30 to 60 per range, the slot size picked from a fixed list (1, 5, 10, 15, 30 minutes; 1, 2, 4, 6, 12 hours; 1 day), and the strip says the slot size ("per 30 minutes").
- The bars count every record of the pipeline in the slot, like the level chips (6.4); with a search, a level filter or a chip on, the matching part of each bar is drawn darker.
- The strip shows for bounded ranges (Last hour, 24 hours, 7 days, Since the last deploy, Custom) and is hidden for Live and Last 15 minutes then live.

## Boundaries & Constraints

**Always:**
- The counts are made on the host while the range is read (as 6.4's level counts), every record of the pipeline counted once, including records left out for the cap; Load older extends the strip to the window it read, re-slotting when the span grows.
- A bar's marks: its ERROR and WARN counts (6.4's levels), drawn on top in the theme's error and warning colours with a text equivalent: each bar is a button whose accessible name says its slot and counts ("Nov 5 14:00–14:30: 120 records, 3 errors, 1 warning").
- Clicking a bar reads that slot as a custom range, keeping the search and filters; the strip stays for the slot's range, re-slotted.
- Theme colours only, no Redpanda branding; 6.2–6.6 rules stand (masking, the cap, reading only while visible, the states).

**Never:**
- A chart library; zoom or brush selection; the strip on live views; export (6.8).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SLOTS | Last 24 hours | 48 bars "per 30 minutes"; heights the pipeline's records per slot | none |
| SHORT_LONG | Last hour; Last 7 days | 60 bars per 1 minute; 42 bars per 4 hours | none |
| MARKS | a slot with 3 errors and 1 warning | red and yellow marks on that bar; its accessible name says so | none |
| FILTERED | a search on, 40 matches in the range | every bar's full height unchanged; its matching part darker | none |
| EMPTY_SLOTS | hours with no records | no bar height (a gap), still a slot | none |
| CLICK | a bar | that slot read as a custom range, filters kept, the strip re-slotted for it | none |
| LOAD_OLDER | Load older on a bounded range | the strip extends to the older window | none |
| LIVE_HIDDEN | Live, or Last 15 minutes then live | no strip | none |
| OVER_CAP | a range with more than 5,000 records | the strip counts all of them, not only those kept | none |

</frozen-after-approval>

## Code Map

- `src/adapters/logs/history.ts` -- add pure slot logic: `slotSize(spanMs)` from the fixed list to give 30–60 slots, `slotOf(time, from, size)`, the labels; unit-tested.
- `src/adapters/logs/filter.ts` -- the level counter (6.4); per-slot counts alongside it: total, ERROR, WARN, matching.
- `src/adapters/vscode/logsPanel.ts` -- count every record of the pipeline per slot while reading (receive, range, Load older), re-slot on a span change, send the strip in the state for bounded ranges; a bar click = a custom range of the slot with the filter kept.
- `src/shared/logsProtocol.ts` -- the strip in the state (from, slot size, counts per slot) and its validator; webview → host `slotChosen(index)`.
- `webview/src/logs/LogsView.tsx`, `logs.css` -- the strip (board 5): bars as buttons in a flex row (no chart library), heights relative to the largest slot, error and warning marks, the darker matching part, the axis labels and "per <size>", keyboard focus.
- Tests: unit tests for the slot logic; `src/test/integration/suites/97-logs.ts` for every matrix row against the fake; webview tests for the bars, marks, accessible names and click.
- `README.md` Pipeline logs section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `history.ts`, `filter.ts` + unit tests -- slots and per-slot counts.
- [x] `logsPanel.ts`, `logsProtocol.ts` -- counting, re-slotting, the click.
- [x] `webview/src/logs/*` + tests -- the strip.
- [x] `97-logs.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a fake pipeline with 20,000 records over 7 days, 30 of them ERROR in one afternoon, when Last 7 days is read, then the strip has 42 bars per 4 hours whose counts sum to 20,000, the afternoon's bars carry the error marks, and clicking one shows that slot's records.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute (vscode-test under `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`, each capped with `timeout`), then all pass.

## Implementation Notes

- The slot rules live in `src/shared/logsProtocol.ts` (`SLOT_SIZES_MS`, `slotSize`, `stripLayout`, `slotOf`, `slotBounds`, `slotSizeText`, `slotTimeText`, `slotLabel`, the `LogStrip` type and its validator), since the webview needs them for the bars' names and the click, as 6.4 did with the levels; `history.ts` holds `stripSpan` (which times a range's strip covers), `filter.ts` a `SlotCounter` beside the `Counter`.
- `slotSize(span)`: the smallest size of the list with `ceil(span / size) <= 60`. Past 60 days (beyond the list: a long custom range, or Load older far back) whole days, `ceil(span / 60 days)` of them, so a strip stays at 60 bars.
- `stripLayout(from, end)`: the size from `end − from`, the start floored to the minute, `ceil((end − from) / size)` slots (Last 24 hours: 48; Last hour: 60; Last 7 days: 42); the last slot runs to `end`. Slots are counted from the range's start, not aligned to the clock (aligning them would give 49 bars for a 24-hour range).
- Re-slotting: the host keeps the counts per minute of each record's Kafka timestamp (total, ERROR, WARN, matching; a sparse map, no records kept), counted in `take` exactly where the level counts are (each record once, those left out for the cap included), and slots them for the current span whenever the state is posted. Every size is whole minutes and the start is on a minute, so the slots fall on whole minutes. A record outside the span counts in the nearest slot.
- The span (`stripSpan`): from the range's start, or the start of the oldest window Load older read (set as each window is read), to the range's `to`; Since the last deploy (it goes on live) to the latest of when it was chosen, the time it was read up to and the newest record counted, so it grows (and is re-slotted) as live records come. `strip` is `null` for Live, the last 15 minutes then live, no log access, and while around the error's search is still to be made.
- The click: webview → host `slotChosen(index)`; the host's `chooseSlot(index)` reads `slotBounds` of its current strip as `chooseRange({ kind: 'custom', from, to })` (`to` inclusive, as the reader's range), which keeps the filter; an index outside the strip is ignored. Counted by the Kafka timestamp, a slot's click shows exactly its bar's records.
- The bars' names: "Nov 5 14:00–14:30: 120 records, 3 errors, 1 warning" (errors and warnings only when some; "no records" for an empty slot; with a filter on, ", 40 match"). The strip's title says "Records per minute", "per 30 minutes", "per 4 hours", "per day" (one unit without the "1"). Board 5's hint: "Click a bar to show its records"; the axis has four times from the strip's start to its end.
- Webview: a flex row of buttons (one tab stop; the arrow keys, Home and End move), the bar `--vscode-charts-blue` (falling back to `--vscode-focusBorder`), the marks `--vscode-errorForeground` and `--vscode-editorWarning-foreground` (3 px each, on top of the bar); with a filter on, the bar at 30% (`color-mix`) and its matching part in the full colour.
- Test seams: `chooseSlot`, `viewState.strip`.

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass. No floor run.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: `errors.yaml` running a while; Last 24 hours shows the strip with error marks; a search darkens the matching parts; a bar click shows its slot; Live hides the strip.

- After review (2026-11-06), superseding the notes above where they differ: a slot's bounds stay within the span read (the first from the range's start, not the minute before it; the last to the strip's end, never past it), so its name and its click match what its bar counts; the strip carries that `from`. Load older extends the strip only once a window is read (stopped: back to the oldest record read; failed: not at all). The strip is hidden under Sign-in refused, Not allowed, and a lost connection before any record was read. The marks are drawn inside the bar's height. The validator refuses a slot whose errors, warnings or matches exceed its records. `slotChosen` carries the slot's `from` and `to` as drawn (checked on the host: inside the strip, `from < to`), not its index; the seam is `chooseSlot(from, to)`.

**Verification (2026-11-06):** compile, corpus 156, webview 375, multiroot 10, stable 1343 passing (1 pending: the older-VS Code suite, skipped on stable); no floor run.

**Manual check result (user, 2026-11-06):** passed on the 1.143.1 dev host against the real organization: "tested, no issues" (`errors.yaml` on rpc-vilnius: the strip on Last hour, Last 24 hours and Last 7 days with its slot size, the error marks and the bars' names, a search darkening the matching parts, a bar click reading its slot, Load older, Live and Last 15 minutes then live hiding it). Automated: stable 1345, multi-root 10, corpus 156, webview 375; no floor run.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | The last slot runs past the strip's end (and slot 0 starts before the range, by up to a minute), so a bar's click reads records its bar never counted and its name shows the wrong end | medium | `slotBounds` returns `max(layout.end, next - 1)` for the last slot; `stripLayout` floors `start`; 10:00–16:01 gives a last bar named 16:00–16:10 | patch (clamp both to the range read) |
| 2 | Load older extends the strip before its window is read; a stop or failure leaves empty bars over an unread span | medium | `olderFrom` set before `reader.range(...)` | patch |
| 3 | Under Sign-in refused, Not allowed, and Connection lost before any read, the strip shows a row of clickable zero bars, saying the pipeline was quiet | low | the `strip` getter hides it only for `noAccess` | patch |
| 4 | Bars with error or warning marks shrink by up to 6 px, so heights stop being proportional | low | `logs.css`: marks `flex: 0 0 3px`, the bar `flex: 0 1 auto` with a % height | patch |
| 5 | The strip validator does not check `matched`, `errors`, `warns` <= `total` | low | `isStrip` | patch |
| 6 | The manual check is not done | false | it is the user's step, not a defect of the change | reject |
| 7 | (triage) A bar click sends only the slot's index; a re-slot between drawing and clicking (Since the last deploy, Load older) reads a neighbouring slot (the implementer's risk note) | low | `slotChosen(index)` | patch (send the slot's from and to) |
