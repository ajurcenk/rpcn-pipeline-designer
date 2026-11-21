---
title: "The tab's empty and error states"
type: 'feature'
ticket: '8'
created: '2026-11-20'
status: done
baseline_revision: 'd7eebfd3bc62813a8aa374815447447d907a5d8c'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Pipeline Metrics tab's states are one plain line of text; most tell the user to go elsewhere (the Cloud view, the editor) and none offers the action that leads on (E7 R9).

**Approach:** Build board 5: each non-live state shows a title, a body saying what happened and what to do, and its action buttons, which the host carries out: Run the file, Open the metrics section, Set up metrics access…, Forget metrics access, Read again, Retry now, Show output. The Pipeline Logs tab's state panel (`stateActions`, `StatePanel`, `*Requested` messages) is the template.

## Boundaries & Constraints

**Always:**
- The states and their actions (board 5):
  - **Not running** (local): "Run <file>" (`redpandaConnect.run` on the bound file); a second action per the Decisions.
  - **No metrics served** (the config's `metrics` section is not `prometheus`, or the endpoint answers 404 / JSON): "Open the metrics section" reveals the config's top-level `metrics:` key in the editor (the file's start when it has none); "Read again" for the 404 / JSON reasons.
  - **No series yet** (local and Cloud): "Read again" (a fresh read cycle; the 5-answer rule starts over).
  - **No access** (Cloud): "Set up metrics access…" on the bound cluster; once stored the tab reads (7.5).
  - **Password refused** (Cloud): "Set up metrics access…" and "Forget metrics access" on the bound cluster.
  - **Unreachable** (local and Cloud): "Retry now" (reads at once, within the Cloud 5 s floor) and "Show output" (the "Redpanda Connect" output channel); the body says when the next retry is and, when figures show, the time of the last reading.
  - **Stopped**: the last figures stay; "Run <file>" again.
  - **Waiting / none**: text only (none's binding is entry 9's).
- Actions are webview → host `*Requested` messages, validated; the host acts on the tab's current binding only (never a file, cluster or pipeline id from the webview).
- While a set-up flow runs for the bound cluster its buttons are disabled (as the Logs tab's `settingUp`).
- The figures table stays under the state panel while it has rows (stopped, unreachable); otherwise the panel stands alone.
- No password or secret in any state's text, message or log line (texts masked as today).
- Theme colours only; the state's colour classes as today (warning, error, description).

**Never:**
- No palette command or pick of runs and Cloud pipelines, no status-bar or graph-toolbar entry, no change to the `none` state's binding (entry 9).
- No change to when states are entered, the read intervals or the backoff, beyond "Read again" and "Retry now".
- No override of a config's own `metrics` section (7.2's decision stands).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Not running | file bound, no run | "Not running", body, "Run <file>"; Run starts it and the tab goes waiting → live | — |
| Not served (type) | `metrics: none` | "No metrics served", body names the type; "Open the metrics section" reveals the `metrics:` line | — |
| Not served (404) | fake answers 404 | body with the reason; "Read again" reads again | — |
| No series | 5 answers with no series | "No figures yet"; "Read again" restarts the count and reads | — |
| No access | Cloud, no access | "Set up metrics access…" opens the prompt; stored → reads | — |
| Refused | 401 | "Password refused", both actions; Forget → no-access state | — |
| Unreachable | 3 failures | body with the next retry and last reading time; "Retry now" reads at once; "Show output" shows the channel | Cloud floor kept |
| Stopped | run ended | last figures kept; "Run <file>" | — |
| Setting up | set-up prompt open | set-up buttons disabled until it ends | — |
| Forged message | an action not offered by the current state | ignored | — |
| No leak | refused / unreachable with a secret in the error | no secret in posted messages or the output | — |

## Decisions

- Decision (user, 2026-11-20): Not running's second action is the file's mapped Cloud pipeline: when the file has a `.cloud.json` mapping, "Show <pipeline> on <cluster>" (7.5's Show metrics on that pipeline); with no mapping, no second action. The general pick of runs and Cloud pipelines stays with entry 9.
- Decision (user, 2026-11-20): keep the full plan (about 2,300 tokens) as one slice.

</frozen-after-approval>

## Code Map

- `src/shared/metricsProtocol.ts` -- `MetricsPanelState` L115-124 (`cluster` is the name), `isState` L382; `stateText` L217-239 and `NO_FILE_TEXT` L164, `NOT_RUNNING_TEXT` L165, `STOPPED_TEXT` L166, `noMetricsAccessText` L207, `refusedText` L212; `show` L132-151 (add what the body needs: next retry time, last reading time, setting-up flag); `MetricsWebviewMessage` L153-158 + `parseMetricsWebviewMessage` L421-436 (add the `*Requested` variants). Replace the single line with {title, body} texts (as `panelStateTexts`, `src/shared/logsProtocol.ts` L632).
- `src/adapters/vscode/metricsFeed.ts` -- states set at L387 (notRunning/stopped), L401 (type), L629 (404/JSON), L652 (local no series), L618 (Cloud no series, `CLOUD_NO_SERIES_HINT` L56), L655/L621 (unreachable), L416 (noAccess), L591/L418 (refused). `restart()` L324 does not clear a local `notServedReason` (only a new port, L395): "Read again" must. Retry timing: Cloud `retryDelayMs` L566, local interval L519 — expose the next retry time. Distinguish the no-series notServed from the others (a field on the state) so the title is "No figures yet".
- `src/adapters/vscode/metricsPanel.ts` -- `receive` L184-208; binding: `this.uri`, `this.update.source` (cloud: `clusterId`, `pipelineId`), `this.subscription.feed`.
- Commands: `RUN_COMMAND` `redpandaConnect.run` (`run.ts:28`, `(uri)`); `SET_UP_METRICS_ACCESS_COMMAND` (`cloudMetrics.ts:33`, `{kind:'cluster', id}`, returns `{kind:'stored'}`); `FORGET_METRICS_ACCESS_COMMAND` (same file); the output channel is passed to the adapters from `src/extension.ts` (show it).
- Mapping: `src/adapters/vscode/cloudShared.ts` `readMapping` L58, `findMapping(config, folders, tagOf?)` L110, `mappedPipeline(ctx, m)` L289 (`found|clusterGone|pipelineGone|failed`); `src/adapters/cloud/sidecar.ts` `DeployMapping {clusterId, pipelineId, clusterName?, pipelineName?}` L13. The action runs `SHOW_CLOUD_METRICS_COMMAND` (`cloudMetrics.ts:37`, `{kind:'pipeline', clusterId, id}`); a gone cluster or pipeline, or not signed in, says so as Show metrics does.
- Template: `webview/src/logs/LogsView.tsx` `stateActions` L234, `StatePanel` L258-297 (`rpcn-logs-state`, `rpcn-logs-state-actions`, `rpcn-logs-primary`); `src/adapters/vscode/logsPanel.ts` `receive` L651-656, `retry` L1107, `setUpAccess` L1799 with `settingUpFor` L435.
- `webview/src/metrics/MetricsView.tsx` -- the state line L174-178 (role `alert`/`status`); `metrics.css` L56-74.
- Tests: `webview/src/metrics/MetricsView.test.tsx` ('shows the state lines' L162, 7.5 states L192, messages L312: update the texts); `src/test/integration/suites/98-metrics.ts` (`open` L61, `runAndWait` L70, `stop` L76, 'NOT_RUNNING / NOT_SERVED / UNREACHABLE' L227); `99b-cloud-metrics.ts` (`setUpAccess` L86, `showMetrics` L67, `cloud().ui` L129-135, state tests L301-421); `src/test/helpers/fakeMetrics.ts` `fail` L112.
- `README.md` L72 (the states sentence), L76.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/metricsProtocol.ts` -- state texts {title, body}, the action list per state (shared by host and webview), the `*Requested` messages, the new `show` fields, validators.
- [x] `src/adapters/vscode/metricsFeed.ts` -- "Read again" (clears a stopped state's reason and counts), "Retry now", the next retry time, the no-series flag.
- [x] `src/adapters/vscode/metricsPanel.ts` (+ `src/extension.ts` wiring) -- carry out each action on the current binding; ignore one the state does not offer; the setting-up flag.
- [x] `webview/src/metrics/*` -- the state panel and buttons (board 5); the table kept under it with rows.
- [x] Tests: webview (each state's title, body, buttons, the posted message; disabled while setting up); integration 98-metrics and 99b (each matrix row reached through the fakes and the run, its action leading on; NO_LEAK).
- [x] `README.md` L72, L76.

**Acceptance Criteria:**
- Given each state reached through the fakes and the run, when its action is clicked, then it leads on: Run starts the run, Set up metrics access… opens the prompt, Read again and Retry now read again.

## Implementation Notes

- The buttons per state are one shared function, `metricsStateActions(state, {file, cloud, mapped})` (`metricsProtocol.ts`); the host checks a `*Requested` message against it with its own context and ignores one the state does not show (`MetricsPanel.act`, logged). The messages carry no field.
- `notServed` carries `cause` (`type` | `answer` | `noSeries`); `noSeries` is titled "No figures yet". "Open the metrics section" is offered for a local run only (a Cloud 404 is the cluster endpoint's, and the deployed config's section is not checked); "Read again" for `answer` and `noSeries`.
- `MetricsUpdate.nextReadAt` (the feed schedules the next read before it emits) gives `show.retryAt`; `show.lastReadingAt` is the reading time while rows show; `show.settingUp` is the tab's own set-up of the bound cluster (as the Logs tab's `settingUpFor`); `show.mapped` is the not-running file's `.cloud.json` pipeline (read with `findMapping` on each entry into not running; names from the mapping, else ids).
- Read again is the feed's `restart()` (which now always drops the not-served reason); Retry now clears the timer and resumes (a Cloud read waits for its floor).
- Show <pipeline> on <cluster> runs Show metrics on `{kind: 'pipeline', clusterId, id}`; Show metrics now loads the cluster's pipelines first when they are not cached (the cluster not expanded yet).
- `CLOUD_NO_SERIES_HINT` is now "Read again once the pipeline runs."; `stateText`, `noMetricsAccessText`, `refusedText` and `NOT_RUNNING_TEXT` are replaced by `metricsStateTexts`.

## Plan Change Log

## Review Triage Log

### Pass 1 (quick lens), 2026-11-20: high 0, medium 2, low 5, false 0, maybe-false 0

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `metricsProtocol.ts` `retryingText(null)` + the sentence end give "Retrying…." (locked in by a webview test) | low | patch | Confirmed. Direct fix: no extra `.` after the ellipsis; fix the test. |
| 2 | Show output hides the tab, so the feed drops the figures and resets an unreachable state to waiting | low | reject | Confirmed, but it follows from the board's Show output (the channel takes the bottom panel) and 7.3's rule that hiding drops the readings; shown again, the tab reads on and the state comes back after the quiet failures. Keeping figures while hidden would change 7.3's rule, more than a direct fix. |
| 3 | `metricsPanel.test.ts` UNREACHABLE: `reads > before \|\| retryAt === null` passes with no read | low | patch | Confirmed. Direct fix: assert the read. |
| 4 | NO_LEAK not extended to the ticket's paths; `metricsPanel.ts` `act` logs `${type} failed: ${errorText(err)}` unmasked | medium | patch | Confirmed: the Set up flows from the tab type `PASSWORD` and no test checks posted/output; the catch logs whatever a command throws. Patch: mask the log line with the bound source's mask; add the password check to the tab's Set up / Forget tests. |
| 5 | `MetricsPanel.actions` grows for the session | low | patch | Confirmed: unlike `posted`, never capped. Direct fix: cap it as `posted`. |
| 6 | Set-up buttons stay enabled while a set-up for the bound cluster runs from elsewhere (Show metrics' info message) | medium | patch | Confirmed: `settingUp` follows only the tab's own flow; the Always rule says "while a set-up flow runs for the bound cluster". `CloudMetricsAccess` already holds the per-cluster lock (`settingUp`, cloudMetrics.ts L93/L251-262), so no second prompt opens, but the buttons are not disabled. Patch: expose that lock and its change to the panel and disable from it. |
| 7 | Show <pipeline> on <cluster> when not signed in says "That pipeline is no longer in the Cloud view" | low | patch | Confirmed: `showMetrics` skips the pre-load with no account; the Code Map says not signed in "says so". Direct fix: with no account, a message saying to connect to Redpanda Cloud first. |

The six patches applied by the implementer (#2 rejected). Verified after them: `npm run compile`, `test:webview` 418, `test:corpus` 182, stable 1696 passing / 1 pending / 0 failing, multiroot 15 passing; no `vscode` import in `src/core`, `src/shared` or `src/adapters/metrics`.

## Design Notes

- Board 5 texts, e.g. refused: title "Password refused", body "rpc-staging refused the Prometheus password (401). Copy it again from the cluster's Overview › Prometheus."; unreachable: "The last read failed (timed out). Retrying in 15 s; the figures shown are from 10:42:05."

## Verification

**Commands:**
- `npm run compile && npm run test:webview && npm run test:corpus` -- expected: all pass.
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable`, then `--label multiroot` -- expected: all pass.
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no matches.

**Manual checks:**
- In the dev host: open Pipeline Metrics on `metrics_a.yaml` not running → Run from the tab; `metrics_none.yaml` → Open the metrics section; a Cloud pipeline with a wrong password → Set up metrics access… from the tab.


## Manual Check

- 2026-11-21, the user, in the dev host (VS Code 1.143.1 from `.vscode-test`, extension at `7570a39`, restarted on the build) on the not-running, stopped, no-metrics-served and Cloud access states: "tested, no issues".
