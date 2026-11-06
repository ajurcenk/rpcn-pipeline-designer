---
title: 'Open the log from the command, the row menu and an Error'
type: 'feature'
ticket: '5'
created: '2026-11-06'
status: 'in-review'
baseline_revision: '291d1a3314cd69612f553350b5a47a43e9cfe6d9'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-filter-and-search-the-log-plan.md
  - src/adapters/vscode/cloudView.ts
  - src/adapters/vscode/logsPanel.ts
  - src/adapters/logs/filter.ts
  - src/shared/logsProtocol.ts
  - package.json
  - src/test/integration/suites/96-cloud.ts
  - src/test/integration/suites/97-logs.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The log opens only from a pipeline's row in the Cloud view; a deploy or start that ends in Error says so in a notification with no way to see why, and an Error pipeline's row gives no quick way to the error itself.

**Approach:** Board 2's three entry points: **Show pipeline logs** in the Command Palette (the active config's mapped pipeline, else a pick of every pipeline); **Show logs** on the Error notification of a deploy, an update and a start; and **Show logs around the error** in an Error pipeline's row menu, which opens the log around the pipeline's newest ERROR record.

**Decisions (user, 2026-11-06):**
- "Around the error" searches the log back up to 24 hours for the pipeline's newest ERROR-level record and shows the 5 minutes before and after it, every level shown and the ERROR records highlighted; with none found, it says so and shows the last hour.
- The palette's pick lists every pipeline on every cluster; one on a cluster without log access says "no log access set", and choosing it offers Set up log access first.

## Boundaries & Constraints

**Always:**
- The palette command: with the active editor's config mapped by its `.cloud.json` to a pipeline (5.3), that pipeline's log at once (as Show logs on its row); otherwise the pick (name, cluster, state, local file), sorted by cluster then name; Escape opens nothing. Not connected: offers Connect first (as Deploy does).
- The Error notifications (deploy create, update, start; 5.2–5.4) gain a **Show logs** action when the cluster has log access, else **Set up log access…**, which then opens the log; choosing it opens the log at the default range (last 15 minutes, then live), the Error records highlighted.
- "Around the error" uses 6.3's range reading and 6.4's level matching (on the host, no new Kafka pattern); the search back stops at the log's first offset; the found record is scrolled to and marked.
- 6.2–6.4 rules stand: one pipeline at a time (an entry point switches the tab to it), masking, the cap, reading only while the tab is visible.

**Never:**
- New states (6.6), the strip (6.7), export (6.8); logs for a pipeline that is not on a cluster the account can see.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PALETTE_MAPPED | Show pipeline logs with `orders.yaml` active and its `.cloud.json` mapping to a pipeline | that pipeline's log, as from its row | the mapped pipeline gone: said so, then the pick |
| PALETTE_PICK | no mapped config active | the pick of every pipeline; choosing one opens its log | Escape: nothing; not connected: Connect offered |
| PALETTE_NO_ACCESS | the pick's pipeline on a cluster without log access | "no log access set" in the pick; choosing it offers Set up log access, then the log | declined: nothing |
| ERROR_NOTIFICATION | a deploy, an update or a start ends in Error | the notification has Show logs; it opens the log, Error records highlighted | no log access: Set up log access… instead |
| AROUND | Show logs around the error on an Error row | the newest ERROR record within 24 hours, ±5 minutes, scrolled to and marked | none within 24 h: "No ERROR record in the last 24 hours" and the last hour |
| AROUND_MENU | the row menu | Show logs around the error only on Error rows | none |
| SWITCH | any entry point while another pipeline is shown | the tab switches to the new pipeline | none |

</frozen-after-approval>

## Code Map

- `package.json` -- `redpandaConnect.cloud.showLogs` visible in the palette (`when`: connected), titled "Show pipeline logs"; a new `redpandaConnect.cloud.showLogsAroundError` in the row menu on `/^cloudPipeline state-error\b/`, hidden from the palette.
- `src/adapters/vscode/cloudView.ts` `showLogs` (~:2474) -- with no node: the active editor's `.cloud.json` (the 5.3/5.5 mapping readers) else a quick pick on `CloudUi` (replaceable in tests); `report()`'s Error branches (~:1836 deploy/update, ~:2030 start) add the action and its follow-up; the no-access path offers Set up log access then opens the log.
- `src/adapters/vscode/logsPanel.ts` -- an entry point with options: the default range with Error highlighting, or "around the error" (search back up to 24 h with the Error level, then a ±5 min custom range, the found row's id to scroll to); `src/adapters/logs/filter.ts` for the level match.
- `src/shared/logsProtocol.ts` + `webview/src/logs/LogsView.tsx` -- a "highlight Error" flag and a row id to scroll to and mark; the "No ERROR record in the last 24 hours" note.
- Tests: `src/test/integration/suites/97-logs.ts` (palette, around) and `96-cloud.ts` (the notifications' actions) for every matrix row; webview tests for the scroll and mark.
- `README.md` Pipeline logs section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `cloudView.ts` -- the palette command, the pick, the notifications' actions.
- [x] `logsPanel.ts`, `logsProtocol.ts`, `webview/src/logs/*` -- around the error, the highlight, the scroll.
- [x] Tests for every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a deploy that ends in Error on a cluster with log access, when Show logs is chosen on its notification, then the Pipeline Logs tab shows that pipeline's last 15 minutes with its ERROR records highlighted.
- Given an Error pipeline whose newest ERROR record is 3 hours old, when Show logs around the error is chosen, then the tab shows the 5 minutes around it with that record marked.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute (vscode-test under `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`), then all pass.

## Implementation Notes

- `LogsPanel.show(source, options)` takes `{ highlightErrors?, aroundError? }` (`LogsShowOptions`); `LogsViewState` gains `highlightErrors`, `focusId` and `note` (validated on both sides). Highlighting lasts for the pipeline shown; `focusId` and `note` until the next range (`reset`).
- Around the error: a pending search (`pendingAround`) run by `start()` only while the tab is visible, as a session (so hiding stops it and showing runs it again): `logStart`, then `range` reads back from now in `errorWindowMs` windows (1 hour; a test seam), newest first, up to `ERROR_SEARCH_MS` (24 h) or the window that starts at the log's first offset (`atLogStart`); the newest ERROR-level row (`levelOf`, the chips' rule: ERROR/FATAL/PANIC/CRITICAL) of the first window holding one wins. Then a custom range of its row time ±5 min (`focusId`: its row id), else Last hour with `NO_ERROR_NOTE`. While searching the menu shows Last 24 hours and the status "Looking for the newest ERROR record in the last 24 hours…".
- The palette: `SHOW_LOGS_COMMAND` with no argument (`logsTarget`): Connect offered first; the active detected config's mapping read now (`readPipeline`); a 404 or a cluster gone: said so, then the pick; another read failure: shown, nothing opened. The pick: clusters with a pipeline API sorted by name, then pipelines by name; description `cluster · state · local file · no log access set`. Choosing one without access goes through the row's no-access path (Set up log access offered, then the log).
- The notifications: `showErrorWithLogs` on the Error branches of `report()` (create and update) and `startOrStop()`: **Show logs** when the cluster has log access, else **Set up log access…** (stored, then the log); no action when the cluster has no Kafka address, the Node is too old, or there is no panel. The follow-up is `errorFollowUp` (a test seam). It opens the default range with `highlightErrors`.
- `package.json`: the command `redpandaConnect.cloud.showLogs` is titled "Show pipeline logs" (VS Code has one title per command, so the row menu says it too; the inline icon's tooltip as well); `redpandaConnect.cloud.showLogsAroundError` in the row menu (`0_open@5`) on `/^cloudPipeline state-error\b/`, hidden from the palette.
- After review (2026-11-06), superseding the notes above where they differ: the palette entry has no `when` (Connect is offered first when not connected); the search keeps only the newest ERROR candidate per window (shaped and masked) in the read's callback, not its records; ties by time are broken by offset only within one partition (else the first found stays); an around read over the cap leaves out the oldest only up to the marked row and drops the newest past it (`newerDropped`), and the status says "The ERROR record of <time> could not be shown." if it is still not kept; the palette path checks for the panel first; a `.cloud.json` that is not a mapping is said ("<name>.cloud.json could not be read: <reason>"), then the pick.
- Webview: an ERROR-level row gets `rpcn-logs-error-row` with `highlightErrors`; the `focusId` row gets `rpcn-logs-focus` and `aria-current`, and is scrolled into view (centred) once when it arrives, after which the view no longer follows the bottom; `note` shows above the records.

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass. No floor run.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: Show pipeline logs from the palette with `vscode-tracer.yaml` active, then with no config (the pick); a pipeline that ends in Error (e.g. a config with a missing secret's reference at runtime) offers Show logs on its notification; Show logs around the error on its row.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | AC1 untested: no test chooses Show logs on a deploy's (or update's) Error notification with log access set | medium | 96-cloud checks only that Set up log access… is offered without access; the follow-through is tested for a start only | patch |
| 2 | The palette's "not connected: Connect offered" cannot happen: the command is hidden unless connected | low | `package.json` `when: redpandaConnect.cloud.connected`; Boundaries says Connect first, as Deploy does (Deploy is not gated) | patch (drop the gate) |
| 3 | Around the error keeps a whole hour of every pipeline's records per window in memory, uncapped | medium | `findError` pushes every record into `got`, then shapes them | patch (keep only the newest ERROR candidate while reading) |
| 4 | The found ERROR record can be left out by the cap in the ±5 min read, so nothing is marked and nothing says why | medium | the around range is read with the newest-5,000 rule | patch |
| 5 | `newestError` breaks time ties by offset across partitions | low | offsets are ordered within a partition only; a direct correction | patch |
| 6 | `logsTarget()` duplicates `actionTarget()`'s palette path (connect, mapping, gone handling, the pick) | low | two copies already differ | defer (to 6.9, the refactor sweep) |
| 7 | The palette path with no logs panel does the whole connect-and-pick, then opens nothing and says nothing | low | `openLogs` returns `LOGS_NOT_STARTED` when `!this.options.logs` | patch (check first, as the row path does) |
| 8 | An invalid or unreadable `.cloud.json` falls through to the pick with no message | low | only `read.kind === 'ok'` handled | patch (name the file and why, then the pick) |
