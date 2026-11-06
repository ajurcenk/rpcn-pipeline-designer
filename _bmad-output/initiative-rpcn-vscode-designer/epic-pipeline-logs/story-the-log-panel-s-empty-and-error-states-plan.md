---
title: 'The log panel''s empty and error states'
type: 'feature'
ticket: '6'
created: '2026-11-06'
status: 'in-review'
baseline_revision: '2f0ae49891b1b2b02ea040d672bcd3448bc4b478'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-open-the-log-from-the-command-the-row-menu-and-an-error-plan.md
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - src/adapters/logs/logReader.ts
  - src/adapters/vscode/logsPanel.ts
  - src/adapters/vscode/cloudView.ts
  - src/shared/logsProtocol.ts
  - webview/src/logs/LogsView.tsx
  - src/test/helpers/fakeLogs.ts
  - src/test/integration/suites/97-logs.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** When reading the log fails, the Pipeline Logs tab shows a one-line "Reading stopped: <reason>" and never tries again; an empty range, a refused sign-in, a missing permission and a dropped connection look alike and say nothing about what to do.

**Approach:** Board 6's six states fill the panel's list area (the toolbar stays), each with its title, its text and its actions: **No log access** (Set up log access…), **Sign-in refused** (Set up log access again…, Retry), **Not allowed** to read the topic (Retry, Use another user…), **No records** in the range (Last 24 hours, Show every level), **Reading** a range with progress and **Stop reading**, and **Connection lost**, retried with a growing wait while the tab is visible (Retry now).

**Decisions (user, 2026-11-06):**
- A lost connection is retried after 5 s, then 10, 20, 30 and 60 s, and every 60 s after that, while the tab is visible; the wait counts down in the state; Retry now tries at once; records already shown stay; a resumed Live read continues from where it stopped.

## Boundaries & Constraints

**Always:**
- AD-24's error kinds decide the state: `signIn` (Kafka 58) → Sign-in refused; `notAllowed` (authorization errors) → Not allowed; `connection` → Connection lost; no access stored → No log access. A sign-in refusal or a missing permission is never retried by itself.
- "No records" is a range read to its end with none of the pipeline's records (before any filter: a filter with no match is 6.4's "No records match"); its "Show every level" clears 6.4's level filter when one hides records, else is not offered.
- "Reading" shows while a bounded range or Load older reads: the records so far (newest first as 6.3 shows them), a progress line ("2,140 records so far"), and Stop reading, which keeps what was read and ends the read.
- "Use another user…" and "Set up log access again…" run 6.2's Set up log access for the shown pipeline's cluster and, on success, read the same range again.
- Texts as board 6 (masked like every panel text); no credential or broker host in any of them.
- 6.2–6.5 rules stand.

**Never:**
- Retrying a refused sign-in or a missing permission automatically; the strip (6.7) or export (6.8); new reading patterns.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| NO_ACCESS | Show logs where the cluster has no log access | the No log access state with Set up log access… | none |
| SIGN_IN | the stored password is no longer accepted | Sign-in refused: "<user> could not sign in to <cluster>"; Set up log access again…, Retry | not retried by itself |
| NOT_ALLOWED | the user may not read the topic | Not allowed, naming the topic; Retry, Use another user… | not retried by itself |
| NO_RECORDS | a range with none of the pipeline's records | No records for <pipeline> in <range>; Last 24 hours; Show every level when a level filter hides records | none |
| READING | a bounded range or Load older in progress | the records so far, "<n> records so far", Stop reading | Stop: the read ends, records kept |
| CONNECTION_LOST | the connection drops during a live read | Connection lost: "Trying again in 5 s"; retries 5, 10, 20, 30, 60, then every 60 s while visible; Retry now; records kept | the tab hidden: no retries until shown again |
| RECOVERED | a retry succeeds | the state goes; Live continues from where it stopped; no duplicate rows | none |
| AFTER_SETUP | Set up log access again… or Use another user… succeeds | the same range read again | cancelled: the state stays |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/logsPanel.ts` `failed()` (~:966) and its callers (~:634, :662, :717, :873) -- replace "Reading stopped" with a state per error kind; the retry scheduler (timer, the backoff steps, a countdown sent to the webview, cancelled on hide, dispose, another pipeline or range, and on Retry now); Stop reading for bounded reads; the resume positions 6.2 already keeps.
- `src/adapters/logs/logReader.ts` -- `LogReadError` kinds (`signIn`, `notAllowed`, `connection`) as they are; no change expected.
- `src/adapters/vscode/cloudView.ts` -- Set up log access for a given cluster, callable from the panel (the 6.2 flow), returning success.
- `src/shared/logsProtocol.ts` -- a `panelState` (none | noAccess | signIn | notAllowed | noRecords | reading{count} | connectionLost{retryAt}) in the state; webview → host: `stopReading`, `retryNow`, `setUpAccess`, `useAnotherUser`, `showEveryLevel`, `last24h`.
- `webview/src/logs/LogsView.tsx` -- board 6's six panels in the list area, the countdown, the buttons; existing "No records match" (6.4) kept distinct.
- `src/test/helpers/fakeLogs.ts` -- failures by kind on demand, a dropped connection that recovers after N tries, slow reads.
- Tests: `src/test/integration/suites/97-logs.ts` for every matrix row (with a fake clock or short backoff via a seam); webview tests for each state's text and buttons.
- `README.md` Pipeline logs section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `logsPanel.ts`, `cloudView.ts` -- the states, the retry, Stop, the setup actions.
- [x] `logsProtocol.ts`, `webview/src/logs/*` + tests -- board 6.
- [x] `fakeLogs.ts`, `97-logs.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a live read whose connection drops twice and then recovers, when the panel is visible, then it shows Connection lost with "Trying again in 5 s", then 10 s, then continues Live from where it stopped with no duplicate rows.
- Given a stored password the fake refuses, when Show logs is chosen, then Sign-in refused shows with its two actions and no retry happens by itself.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute (vscode-test under `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`), then all pass.

## Implementation Notes

- Protocol: `LogsViewState.panelState: LogsPanelState` (none | noAccess{cluster, topic} | signIn{user, cluster} | notAllowed{user, topic} | noRecords{pipeline, range, hiddenLevels} | reading{what, count} | connectionLost{cluster, live, retryInS, retryAt}), validated on both sides; `panelStateTexts` (shared) builds board 6's label, title and text; `RETRY_DELAYS_MS` and `retryDelayMs`. Webview → host: `stopReading`, `retryNow`, `setUpAccess`, `useAnotherUser`, `showEveryLevel`, `last24h`.
- Host: a `failure` (noAccess, signIn, notAllowed, connectionLost) set by `failed()` from `LogReadError.kind` (anything not a `LogReadError` counts as `connection`, AD-24); reading, No records and none are derived in the `panelState` getter. The status line says the state's title; the cluster's reason goes to the output channel only (masked), so no broker host reaches the panel. `start()` never reads with noAccess, signIn or notAllowed; with connectionLost it only (re)schedules the timer. `retry()` (Retry, Retry now, the timer) reads at once; the state goes once a read delivers (`recovered`). Hidden: the timer stops (`cancelRetry`, `retryAt: null`); shown again: the wait starts again at the current step. `retryDelaysMs` is the test seam; `retryInS` always says the real wait.
- No records: `done`, not stopped short, no row kept, and either no record of the pipeline read, or records read but every one of a level the filter hides with no search or chip on (then `hiddenLevels`, for Show every level). With zero records the level filter hides nothing, so Show every level is offered only in the second case; a search or chip with no match stays 6.4's "No records match". Live ranges never end, so only bounded ranges (and a live range read up to now with Live off) reach it.
- Stop reading: a bounded range's read is aborted, its rows kept, `done` and Live off, status `stoppedReadingStatus`; Load older keeps the window it was reading (prepended), then ends.
- Set up access: `LogSource` gains `pipelineName`, `clusterName`, `username`, `noAccess` and `setUpAccess` (the Cloud view's `logSource()`: 6.2's `setUpLogAccess` for the cluster, then a source with the new access). The panel replaces its source and reads the same range again (around the error: searches again; a live range with Live off: up to now); cancelled or failed: the state stays.
- No access: `openLogs` shows the tab with a `noAccess` source before the existing notification (6.2's and 6.5's offer stand), so a declined notification leaves the tab in its No log access state rather than showing nothing.
- Board 6 deviations: Sign-in refused's text does not quote the cluster's answer (it could name a broker); Reading says "The list fills as the records come." (records show oldest first, newest at the bottom, as 6.3 does) and its progress bar is indeterminate (no total is known).

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass. No floor run.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: Set up log access with a wrong password stored (Sign-in refused, then Set up log access again…); a range with no records; Last 7 days (Reading, Stop reading); a dropped network while Live (Connection lost, the countdown, recovery).

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | A lost connection during a bounded range or the around-error read empties the list on the retry, while the state says the records stay | medium | `retry()` → `readRange()` clears `kept` and posts before reading; breaks the Decision and CONNECTION_LOST | patch (resume the range from its saved positions) |
| 2 | Retry keeps the old credentials after log access is set up again from the Cloud view row | medium | `logSource()` fixes `target.access` when built; the README tells users to set it up again from the row | patch |
| 3 | Stop reading before any record arrives shows "No records <from> – <to>" | low | the webview's `emptyText` falls back to `noRecordsText` when `done` | patch |
| 4 | The Connection lost panel is a `role="alert"` whose countdown text changes every 250 ms, so screen readers re-announce it | low | `StatePanel` | patch |
| 5 | AFTER_SETUP's successful Use another user… and the countdown value after re-showing are untested | low | 97-logs covers only the failing path and `retryAt !== null` | patch |
| 6 | Show every level names every hidden level, not those holding the records read | low | `panelState` lists `LOG_LEVELS` minus the filter's | patch (only hidden levels with a count) |
| 7 | Two Set up log access flows can run at once (the tab's button while the notification's is awaited, or a double click) | low | no in-flight guard in `LogsPanel.setUpAccess()` or `openLogs` | patch |

**Manual check result (user, 2026-11-06):** passed on the 1.143.1 dev host against the real organization: "tested, no issues" (the empty and error states as reachable on rpc-vilnius: No log access, Sign-in refused, No records, Reading and Stop reading, Connection lost with the countdown and recovery). Automated: stable 1332, multi-root 10, corpus 156, webview 369; no floor run.
