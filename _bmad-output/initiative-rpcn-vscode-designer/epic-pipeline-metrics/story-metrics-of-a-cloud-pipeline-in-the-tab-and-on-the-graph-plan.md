---
title: 'Metrics of a Cloud pipeline in the tab and on the graph'
type: 'feature'
ticket: '5'
created: '2026-11-19'
status: 'built'
baseline_revision: '19c8dfd12a09b72323e57418c456124e68ab2970'
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

**Problem:** Metrics access for a cluster is stored (7.4) and a Cloud `MetricsSource` exists, but nothing reads it: a deployed pipeline's figures can't be seen in the Pipeline Metrics tab or on its file's graph.

**Approach:** A **Show metrics** item on the Cloud pipeline row's context menu points the metrics feed at that pipeline's Cloud source (AD-25: every 10 s while the tab or a graph showing figures is visible, one read in flight, 15 s timeout, unreachable retried 5, 10, 20, 30, 60 s, then every 60 s). The tab shows its rows and names its source ("Cloud · <cluster> · <pipeline>", the endpoint host, the interval, the mapped file). The graph of the pipeline's local file gets the same figures through `nodeFigures`.

## Boundaries & Constraints

**Always:**
- AD-25 Cloud rules: the address is only `prometheusUrlOf(cluster)`; the user and password only from `CloudMetricsAccess.accessOf`; `refused` (401/403) is its own state and is never retried until access is set again or Show metrics runs again; never read more often than every 5 s.
- The pipeline's local file is found as other row actions find it (`localFileFor`: the `rpcn-vscode/config` tag, a pick when ambiguous). Rows follow that file's config order (`configFor`); the deployed config's own `metrics` section is not checked (the Cloud serves Connect's series).
- One reader per source: the tab and the file's graph share it (7.3's feed), reading only while either is visible; hiding both drops the readings.
- The password never reaches the panel, the graph, a message, a log line or `posted`; error text is masked (`CloudView.secrets()`).
- The local path keeps working unchanged: a file with no Cloud source still binds to its local run, with its texts and tests.
- Theme only, no Redpanda branding; build to board 3's tab header (its "15 s" is superseded by AD-25's 10 s).

**Never:**
- No inline row icon, no Run status-bar or graph-toolbar entry, no palette fallback to the mapped pipeline (entry 9).
- No change to the access commands, keys or messages (7.4), to the log panel, or to `cloudMetricsSource`'s request rules.
- No figures for Serverless clusters; no several-pods handling beyond what `figures` already does.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Live | access set; fake endpoint serves pipelines A and B; Show metrics on A | tab: "Cloud · <cluster> · A", only A's components in A's file's config order; A's file's graph shows the same figures | — |
| Interval | tab visible | reads every 10 s, one in flight | — |
| Hidden | tab and graph hidden | no read; readings dropped | — |
| No access | cluster without access | tab shows the no-access state naming the cluster, with what to do | no read |
| Refused | endpoint answers 401 | refused state ("the user or password is wrong…"); no further read | not retried |
| Unreachable | 5xx / timeout | unreachable state with the masked reason after the quiet failures | retried 5, 10, 20, 30, 60, 60… s |
| No series | the body holds no series with A's id | "no series yet" state as the local one | as 7.2 |
| Access set later | no-access state, then Set up metrics access succeeds | the tab starts reading | — |
| Access forgotten | live, then Forget metrics access | no-access state; reading stops | — |
| No leak | after live, refused and unreachable | the password is in no `posted` message, no log line, no view item | — |

## Decisions

- Decision (user, 2026-11-19): last chosen wins. Show metrics on a pipeline switches its file's tab and graph to the Cloud source; Show Pipeline Metrics on the file, or a local run of it starting, switches them back to the local run. One reader per file.
- Decision (user, 2026-11-19): a pipeline with no local file (no tag, outside the workspace) shows in the tab only, rows by path, the header saying it is not mapped to a file; no graph gets figures. An ambiguous file asks for a pick, as other row actions do. Such a feed is keyed by a synthetic per-pipeline key, not a file.
- Decision (user, 2026-11-19): no access opens the tab in a no-access state naming the cluster, and an info message offers "Set up metrics access…", as Show logs does; once access is set, the tab starts reading.
- Decision (user, 2026-11-19): keep the full plan (about 2,300 tokens) as one slice.

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/metricsFeed.ts` -- `MetricsFeeds` (map keyed by `uri.toString()` :386/397, `release` :412), `MetricsFeed` (`refreshState` :209 → `run.portOf`, `reading` :254, read via `factory(port)` :284, fixed `setTimeout(intervalMs)` :305, `failed()` :309: `refused` today folds into `unreachable` after `QUIET_FAILURES`), `MetricsUpdate` :49 (`{state, port, figures, time}`), `restart()` :163. Generalise the feed's source binding (local port vs Cloud pipeline) and its schedule (2 s fixed vs 10 s with backoff); keep the local branch's behaviour exactly.
- `src/shared/logsProtocol.ts:614-617` -- `RETRY_DELAYS_MS`, `retryDelayMs`: reuse for the Cloud backoff.
- `src/adapters/vscode/metricsPanel.ts` -- `show(uri)` :168, `showFor` :155, `title` :105 (`localSourceLabel`), `updateDescription` :226, `postShow` :235. Add a Cloud show path.
- `src/shared/metricsProtocol.ts` -- `MetricsPanelState` :53 (add `noAccess`, `refused`), `stateText` :103, `isState` :187, `localSourceLabel` :93, `show` message (`port` must be valid or null; add the Cloud address/source fields), `parseMetricsHostMessage`.
- `webview/src/metrics/MetricsView.tsx` :58-63 (header, `addressText(port, intervalMs)`), state CSS classes `rpcn-metrics-state-${kind}`; tests `MetricsView.test.tsx`.
- `src/adapters/graphPanel/graphPanel.ts` -- `subscribeMetrics` :182 subscribes by its own file URI; `sendFigures` :203 shows figures only for `live`. A Cloud source on the same file key reaches it with no change, provided the feed emits `live`.
- `src/adapters/vscode/cloudView.ts` -- pipeline row :1291-1306 (`CloudNode` pipeline `{clusterId, id}`, contextValue `cloudPipeline state-<key>[ hasFile][ logs]`); `localFileOf` :1330; `SHOW_LOGS_COMMAND` :179 registered :724 (template); `prometheusUrlOf` :1012; `metricsTimeoutMs` :529; `metricsAccess` private :586 (expose an access lookup and its change event through `CloudContext`); `CloudViewOptions.logs` ~:493 (add `metrics`); `secrets()`.
- `src/adapters/vscode/cloudActions.ts` -- `localFileFor(pipeline, what)` :525.
- `src/adapters/vscode/cloudMetrics.ts` -- `accessOf(clusterId)` :103, `readAccess` :79; the store `onDidChange` already refreshes rows.
- `src/adapters/metrics/source.ts` -- `cloudMetricsSource(url, user, password, pipelineId, {fetch, now, timeoutMs})` :227.
- `package.json` -- logs command :317, palette :474, pipeline-row context menu `/^cloudPipeline\b/` `0_open@4` :737. Add `redpandaConnect.cloud.showMetrics` (`$(pulse)`) at `0_open@5` (shift around-error if it clashes), hidden from the palette.
- `src/extension.ts` -- wiring :313/:400; test API `cloud` Pick :116-119 and `metrics` Pick :133-134.
- Tests: `src/test/helpers/fakeCloud.ts` (`prometheus: true`, `metricsBody`, `prometheusFailure`, `cloudMetricsBody(ids, n)` :618); `98-metrics.ts` (graph `figuresOf`/`lastFigures` :227-229); `99-metrics-access.ts` (`connectAndRead`, `setUpAccess`). New suite `99b-cloud-metrics.ts` or extend `99-metrics-access.ts`.
- `README.md` :74 ("The Cloud figures themselves come with a later release.") and :116 ("Metrics are in the Redpanda Cloud UI."): rewrite for Show metrics.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/vscode/metricsFeed.ts` -- a feed source binding: local (today's) or Cloud {clusterId, pipelineId, names, a source factory}; the Cloud schedule (10 s, backoff after failures, stop on `refused` and on no access); `MetricsUpdate` carries the source description; follow access changes.
- [x] `src/shared/metricsProtocol.ts` -- `noAccess` and `refused` states with their texts, the Cloud source label and address in `show`, validators.
- [x] `src/adapters/vscode/metricsPanel.ts` + `webview/src/metrics/*` -- render the Cloud header (board 3) and the new states.
- [x] `src/adapters/vscode/cloudView.ts`, `cloudActions.ts` -- the `showMetrics` command on a pipeline row: resolve the local file, bind the feed, open the tab; expose the access lookup and change event.
- [x] `package.json`, `src/extension.ts` -- the command, menu, wiring, test seams (a Cloud fetch/source seam reaching `fakeCloud`).
- [x] Tests: unit (protocol states, feed schedule and refused stop, label); webview tests (header, states); an integration suite covering the matrix with `FakeCloud` serving two pipelines, including the graph of A's file and NO_LEAK.
- [x] `README.md` -- lines 74 and 116.

**Acceptance Criteria:**
- Given A's file's graph is open and the tab is closed, when Show metrics ran on A and the graph is visible, then the graph shows A's figures; hiding the graph stops the reads.
- Given a file running locally, when nothing Cloud is shown for it, then its tab and graph behave exactly as in 7.3 (the 98-metrics suite passes unchanged).

## Implementation Notes

- The feed (`metricsFeed.ts`) keeps its local branch as it was; a Cloud binding (`CloudMetricsBinding`, built by `CloudMetricsAccess.binding`) adds `noAccess` / `refused` states, its own schedule (`CloudTiming`: 10 s, a 5 s floor from the last read's start, `RETRY_DELAYS_MS` after unreachable reads) and follows `CloudMetricsAccess.onDidChangeAccess`, which fires only when a cluster's held user or password really changes (set, replaced, forgotten, cleared by a disconnect). `MetricsUpdate` carries `source` and `intervalMs`.
- Last chosen wins: `MetricsPanel.show` (Show Pipeline Metrics) calls `bindLocal` on a Cloud-bound feed; a `RunChange` with phase `running` on the file does the same. A pipeline with no file is keyed `redpanda-cloud-metrics:/<cluster>/<pipeline>` (`cloudMetricsKey`), never read as a config.
- A file's feed stays Cloud-bound while anything holds it (the tab or the file's graph), so a graph opened later on that file shows the Cloud figures until the local run is chosen.
- The test seam for the Cloud timing is `api().metrics.feeds.cloudTiming` (test mode only); the Cloud reads in the integration suite go through the real `fetch` to the Cloud fake. New suite: `src/test/integration/suites/99b-cloud-metrics.ts`.
- Show metrics sits at `0_open@5`; Show logs around the error moved to `0_open@6`.

## Plan Change Log

## Review Triage Log

### Pass 1 (quick lens), 2026-11-20: high 0, medium 1, low 6, false 0, maybe-false 0

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `metricsFeed.ts`: the 5 s floor is per feed (`lastReadAt`), lost on `unbindCloud`/release, and two feeds on one cluster (the tab on B, A's graph on A's file) each read the whole cluster on their own cycle | medium | patch | Confirmed: `lastReadAt` is a `MetricsFeed` field reset by `unbindCloud`; nothing is shared per cluster. AD-25 says never more often than every 5 s per endpoint. Patch: keep the last read start per cluster in `MetricsFeeds`, and wait on it for every Cloud feed of that cluster. |
| 2 | `metricsFeed.ts` `accessChanged`: access replaced while live/waiting leaves an in-flight read with the old password; its 401 sets `refused` after the change event, stuck | low | patch | Confirmed: the live/waiting branch does nothing; the cached source with the old password answers into the current generation. Direct fix: any change with access held drops the in-flight read (`pause`, `generation++`) and reads again. |
| 3 | `cloudMetrics.ts` `hold`: Set up metrics access with the same user and password fires no change, so a `refused` tab stays refused | low | patch | Confirmed: `hold` compares and skips the event; the REFUSED test forgets first. Direct fix: a successful set up always fires the change; a test sets up again with the same values from `refused`. |
| 4 | `metricsFeed.ts` Cloud "no series" is terminal and its text says nothing to do | low | patch | Confirmed: only `bindCloud`/`bindLocal` clear `notServedReason`; the matrix says "as 7.2", so stopping is planned, but E7 R9 says each state says what to do. Direct fix: the Cloud no-series reason ends with "Use Show metrics again once the pipeline runs." |
| 5 | `metricsFeed.ts` `runChanged`: a local run started without a metrics port does not take the file back from the Cloud | low | patch | Confirmed: the condition requires `portOf(uri) !== undefined`; `run.ts` can run "without metrics". The decision is unconditional. Direct fix: drop the port condition. |
| 6 | Disconnect drops the held access and the tab says "No metrics access is set … Use Set up metrics access…", though it is still stored | low | patch | Confirmed: `clear()` fires for every held cluster; `source()` is then undefined → `noAccess`. Direct fix: the no-access text also says to connect to Redpanda Cloud when signed out (or reads "No metrics access is held for <cluster>: connect to Redpanda Cloud, or use Set up metrics access…"). |
| 7 | `99b-cloud-metrics.ts` NO_LEAK does not check the graph's posted messages | low | patch | Confirmed: the graph handle's `posted` is not collected. Direct fix: add it to NO_LEAK. |

All seven patches applied by the implementer. Verified after them: `npm run compile`, `test:webview` 403, `test:corpus` 182, stable 1665 passing / 1 pending / 0 failing, multiroot 15 passing; no `vscode` import in `src/core`, `src/shared` or `src/adapters/metrics`.

## Verification

**Commands:**
- `npm run compile && npm run test:webview && npm run test:corpus` -- expected: all pass.
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable`, then `--label multiroot` -- expected: all pass.
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no matches.

**Manual checks:**
- In the dev host, signed in, with metrics access set on the user's cluster: Show metrics on a running pipeline shows its figures in the tab, and on its file's graph when the file is open.

