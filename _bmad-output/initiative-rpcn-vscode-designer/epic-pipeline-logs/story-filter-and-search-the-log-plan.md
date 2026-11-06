---
title: 'Filter and search the log'
type: 'feature'
ticket: '4'
created: '2026-11-06'
status: 'in-review'
baseline_revision: 'eb81bc67e74fae4beaa1d061747638c9f6a32732'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-read-back-the-log-s-history-plan.md
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - src/adapters/vscode/logsPanel.ts
  - src/adapters/logs/records.ts
  - src/adapters/logs/history.ts
  - src/shared/logsProtocol.ts
  - webview/src/logs/LogsView.tsx
  - src/test/helpers/fakeLogs.ts
  - src/test/integration/suites/97-logs.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Pipeline Logs tab shows every record of a range in order; finding the one error among thousands of INFO lines, or what one instance did, means scrolling.

**Approach:** Board 4's controls in the panel: **level chips** with counts (Error, Warn, Info, Debug, and Other for records without a known level), a **search** box over the message and every field (Match case, regular expression; matches highlighted), **filter chips** made by clicking a field's value in a record (removable), a count "N of M records match", and a record's **whole JSON** expanded in place with **Copy JSON** and **Show records around this one**.

**Decisions (user, 2026-11-06):**
- Filtering happens on the host while the range is read: only records that match are kept, so the 5,000 cap counts matches and a search over the last 7 days finds every match; changing the search, a level or a filter reads the range again (Load older and Live apply the same filter).

## Boundaries & Constraints

**Always:**
- Matching is on the shown (masked) text: the message, the level, the instance and each further field's name and value; `license_org` never shown, never matched.
- The level counts are of every record of the pipeline read in the range (matching or not), so a hidden level still shows how many it has; "N of M" uses the same M.
- A search is applied after typing pauses (about 300 ms); an invalid regular expression is refused at the box with its error and reads nothing.
- Filters stay when the range changes and are cleared when another pipeline is shown.
- **Show records around this one** shows the 5 minutes before and after that record (a custom range), with the search and filters cleared and Live off.
- **Copy JSON** copies the record as shown (masked, `license_org` left out), pretty-printed.
- 6.2 and 6.3 rules stand (one pipeline, masking, the cap, reading only while the tab is visible, Load older, gaps).

**Never:**
- Saved searches; filters across pipelines; the per-hour strip or export (6.7, 6.8); changing how records are read from Kafka.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LEVELS | Info turned off | Info records hidden; the chip shows its count still; "N of M records match" | all levels off: an empty list with "No records match" |
| SEARCH | "secret" | records whose message or any field contains it (case-insensitive), the matches highlighted | none |
| CASE_REGEX | Match case on; `.*` on with `fail(ed)?` | case-sensitive; regular-expression match | `(` alone: refused at the box with the error, nothing read |
| FIELD_FILTER | click `instance_id`'s value in a record | a chip "instance …c1gjg"; only that instance's records; × removes it | none |
| COMBINED | levels, search and a chip together | records matching all of them | none |
| OVER_CAP_MATCHES | a 7-day range with 20,000 records, 40 matching | all 40 shown (the cap counts matches) | none |
| LIVE | a filter on while Live follows | only matching new records appended; counts updated | none |
| LOAD_OLDER | a filter on, Load older | older matching records only | none |
| JSON | expand a record | its whole record as JSON; Copy JSON copies it | none |
| AROUND | Show records around this one | ±5 minutes around it, filters cleared, Live off | none |
| SWITCH | another pipeline | filters cleared | none |

</frozen-after-approval>

## Code Map

- `src/adapters/logs/records.ts` -- the shown row; add a pure `matches(row, filter)` and `levelOf(row)` (Error/Warn/Info/Debug/Other) in a new `src/adapters/logs/filter.ts` (the filter: levels, text, case, regex, field chips; regex compiled once; unit-tested), used by the host.
- `src/adapters/vscode/logsPanel.ts` -- keep the filter in the panel state; apply it in `receive`/range/Load older before the cap; count every record per level; re-read the current range on a filter change (debounced on the webview side); clear filters on another pipeline; "around" = a custom range ±5 min of the record's time.
- `src/shared/logsProtocol.ts` -- the filter type and its validator; webview → host: `filterChanged`, `aroundRequested(id)`; host → webview: the counts (per level, matched of total) in the state.
- `webview/src/logs/LogsView.tsx` -- board 4: level chips with counts, the search box with Aa and `.*` toggles and the error, highlighted matches, clickable field values making chips, the "N of M" line, expandable rows with the JSON, Copy JSON (`navigator.clipboard`, or a host message if the webview lacks it), Show records around this one.
- Tests: unit tests for `filter.ts`; `src/test/integration/suites/97-logs.ts` for every matrix row against the fake; webview tests for the chips, box, highlight and JSON.
- `README.md` Pipeline logs section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/logs/filter.ts` + unit tests.
- [x] `logsPanel.ts`, `logsProtocol.ts` -- the filter on the host, counts, re-read, around.
- [x] `webview/src/logs/*` + tests -- board 4.
- [x] `97-logs.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a fake topic with 20,000 of a pipeline's records over 7 days, 40 of them WARN with "secret" in a field, when Last 7 days is read with Warn only and the search "secret", then the panel shows those 40, "40 of 20,000 records match", and the Info chip still shows its count.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute (vscode-test under `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`), then all pass.

## Implementation Notes

- The filter type, its validator (`parseLogFilter`, refusing an invalid regular expression), the levels (`LOG_LEVELS`, `levelOfText`: ERROR/FATAL/PANIC/CRITICAL, WARN/WARNING, INFO, DEBUG/TRACE, else Other) and the search pattern (`searchPattern`, `searchError`) live in `src/shared/logsProtocol.ts`, since the webview needs them too (the box's error, the highlight); `src/adapters/logs/filter.ts` holds `levelOf(row)`, `compileFilter`, `matches`, `sameFilter` and a `Counter`. A search matches within one text (the message, the level, the instance, one field's name or value), not across them.
- Field chips are `[name, value]`; `instance_id` stands for the instance column. Chip text: "instance …c1gjg" (the last 5 characters of an instance longer than 8), else `name=value` cut at 24 characters.
- `LogRow` gains `json`: the whole value, pretty-printed, masked, `license_org` left out (`pipeline_id` kept); absent for a raw value (Copy JSON then copies its text). Copy JSON uses `navigator.clipboard`, falling back to a `copyRequested` message (the host's `vscode.env.clipboard`).
- `LogsViewState` gains `filter`, `counts` (per level, `total`, `matched`) and `olderBefore` (Load older's anchor, for its label). The host posts `state` after each batch that adds counted records.
- Counting once: each partition's counted offsets are a span (reads are contiguous), so a window read again (Load older, records left out for the cap) is not counted twice. Load older's anchor is the oldest kept row when matching ones were left out for the cap, else the oldest record of the pipeline read (so a filter does not re-read the same window); its walk back ends at the first window with any of the pipeline's records, matching or not.
- A filter change that keeps the same rows (Match case or `.*` without a search, the levels' order) reads nothing. Otherwise the range is read again from its `from`; a live range whose Live is off is read as a bounded range up to now and Live stays off; a bounded range whose Live was turned on follows again once read. The status after a bounded read with a filter: "Read M records of <range>; N match."
- Around: `{ kind: 'custom', from: min(time − 5 min, now), to: time + 5 min }` around the row's shown time.
- Test seams: `setFilter`, `around`, `copyJson`, `viewState.counts`/`filter`/`olderBefore`.
- After review (2026-11-06), superseding the notes above where they differ: every string value and key of a record is masked before it is written as JSON (the whole record and a nested field's text), since JSON escapes `"` and `\`; Load older reads back from the oldest shown row whenever records were left out for the cap at any time in the range (`leftOutEver`); a regular expression with a quantified group holding a quantifier or an alternation is refused at the box and on the host ("This pattern could take too long; simplify it"), and at most the first 10,000 characters of each value are searched; another pipeline shown drops the webview's draft search and its timer; with a filter on, Load older reads back until a window adds a match, the log's start, or 24 hours in one click, then says "No matches back to <time>; Load older to search further" (`olderNote` in the state).

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass. No floor run (the user does not test on VS Code 1.100.0).

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: `vscode-tracer.yaml` (INFO every 5 s): Info off, then a search for a message number, a regular expression, an instance chip, a record's JSON and Copy JSON, Show records around this one.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | The JSON view and Copy JSON can show a secret or a `license_org` value in clear: the mask runs on the JSON text, where `"`, `\` and control characters are escaped, so the raw value is not found | high | `records.ts` `toLogRow` masks `JSON.stringify(whole, null, 2)`; `maskCredentials` and `maskOrgs` split on the raw value; checked: `JSON.stringify({p:'pa"ss'})` does not contain `pa"ss` | patch (mask each string, keys too, before stringifying) |
| 2 | Load older can skip records left out for the cap: after one Load older sets `dropped` to 0, the next anchors at the oldest record counted, past every left-out record | medium | `logsPanel.ts` `olderAnchor()` uses `kept[0].ts` only while `dropped > 0`; a live range past the cap; 6.3's rule | patch |
| 3 | A user's regular expression runs synchronously on the extension host over every record read; a catastrophic pattern blocks the host | medium | `filter.ts` `matches` compiles and tests the typed pattern; no time or length guard | patch (refuse nested quantifiers, cap the text tested) |
| 4 | A search still waiting on its 300 ms timer can be posted to the next pipeline after Show logs | low | `LogsView.tsx` `show` handler clears the draft and timer only when the filter differs from `lastPosted` | patch |
| 5 | A hidden level's count is still struck through | low | `logs.css`: a child's `text-decoration: none` cannot undo the parent's | patch |
| 6 | (triage) With a filter on, Load older stops at the first window holding any of the pipeline's records even if none match, so an older match may take many clicks (the implementer's note) | medium | `loadOlder` with a filter | patch (keep reading back until a window has a match, the log start, or 24 h of windows per click, saying how far it searched) |
