---
title: 'Entry points for metrics'
type: 'feature'
ticket: '9'
created: '2026-11-21'
status: 'built'
baseline_revision: '36a1d131388f5606c9089086dd2ca318adcba9f4'
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

**Problem:** The Pipeline Metrics tab opens only from the palette command (active editor only, no run or mapping lookup) and the Cloud row's menu; the Run's status bar item, the Cloud row's inline icons and the graph offer nothing, and a tab opened by clicking it shows "No pipeline chosen" even while a run serves metrics (E7 R8; deferred work, story 7.2 manual check).

**Approach:** Build board 5 (`project/Entry.dc.html`): Show Pipeline Metrics resolves the active config's local run, else its mapped Cloud pipeline, else a pick; the Cloud pipeline row gains an inline Show metrics icon; the Run's status bar item offers Show pipeline metrics beside Stop; the graph panel gets a toolbar with Open Pipeline Metrics; every entry opens the tab through the existing `show(uri)` / `SHOW_CLOUD_METRICS_COMMAND` paths, never a new binding path.

## Boundaries & Constraints

**Always:** One resolver in the metrics panel host decides the source for the command, the status bar and the graph button (uri → its run → its mapping → pick); the Cloud row and the tab's mapped action keep going through `SHOW_CLOUD_METRICS_COMMAND`. Theme only (codicons, `--vscode-*`), no Redpanda branding. No secret in any argument, label or message. The layering grep stays clean.

**Never:** No new binding logic in `metricsFeed.ts` beyond what the resolver needs; no extra metrics reads to label the status bar; no terminal link provider; no change to the graph's node figures.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| RUNNING_FILE | Active config is running | Command opens the tab on its local run | — |
| MAPPED_NO_RUN | Active config not running, own `.cloud.json` mapping | Command opens the tab on the mapped Cloud pipeline | Gone cluster/pipeline or not signed in: the message Show metrics gives |
| NEITHER | Active config neither running nor mapped | Tab opens on that file, Not running with its Run button | — |
| NO_EDITOR | No active config, one or more runs | Pick of the running files | Empty pick: `NO_CONFIG_MESSAGE` |
| ROW_INLINE | Click the inline pulse icon on a pipeline row | Same as its menu item | — |
| STATUS_BAR | Click the item while running | Menu Stop / Show pipeline metrics; the latter opens the tab on that run | — |
| GRAPH_BUTTON | Click Open Pipeline Metrics in a graph panel | Tab opens on the graph file's source (as the command for that file) | — |
| DIRECT_OPEN | Tab opened by clicking it, nothing bound | Binds: active config's run, else its mapping, else the only running file; else "No pipeline chosen" | — |

## Decisions

- (user, 2026-11-21) Neither run nor mapping: the command opens the tab on that file (its Not running state with Run); the pick shows only when no config is active.
- (user, 2026-11-21) Status bar while running: click opens a menu Stop / Show pipeline metrics; the item shows " · N/s" (the output rate) only while the tab already reads that run, no reads of its own. After exit it keeps Show terminal.
- (user, 2026-11-21) The pick lists the running local files plus the Cloud pipelines the Cloud view has already loaded; no extra listing call. Empty: `NO_CONFIG_MESSAGE`.
- (user, 2026-11-21) Clicking the tab with nothing bound binds as the command does, without a pick: the active config's run, else its mapping, else the only running file; else "No pipeline chosen" stays. A re-run does not bring the tab forward.
- (user, 2026-11-21) Graph toolbar: Open Pipeline Metrics only; no Metrics on toggle; node figures unchanged.
- (user, 2026-11-21) Plan over 1600 tokens: keep the full plan.

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/metricsPanel.ts` -- `SHOW_METRICS_COMMAND` L60, `NO_CONFIG_MESSAGE` L61, `register()` L121-125; `showFor` L368 (today: arg ?? active editor, else message) → add the resolver here; `show(uri)` L382 → `bind`; `opened()` L438 focuses `${METRICS_VIEW_ID}.focus`; `resolveWebviewView` L184-213 (nothing binds when unbound; `onDidChangeVisibility` L192); `mappingOf` option, used by `refreshMapping` L348 and `showMappedRequested` L283 (runs `SHOW_CLOUD_METRICS_COMMAND` with `{kind:'pipeline', clusterId, id}`) — reuse for the resolver's Cloud step.
- `src/extension.ts` L300-315 -- wires `MetricsPanel` (`mappingOf` = `findMapping(uri.fsPath)`, own + ok only); pass run lookups to the panel here.
- `src/adapters/vscode/run.ts` -- sessions Map L262 (keyed by uri string), `phaseOf` L310, `portOf` L315, `onDidChangeRun` L272 (fired L381); no list of running sessions → add `runningUris()`. Status item L249/L266, `refreshUi` L627-655 (running: command = Stop; after exit: `REVEAL_RUN_COMMAND`); `statusBarText` seam L305; `terminalName` L86.
- `src/adapters/vscode/cloudMetrics.ts` -- `SHOW_CLOUD_METRICS_COMMAND` L38, impl L365. `package.json` -- the command L329 (`$(pulse)`), view/item/context L751-754 (`0_open@5`); inline icons repeat the command with `group: inline@N` (openDeployed @0, start @1, stop @2, showLogs @3 gated on `\blogs\b` L741-745, delete @9) → add `inline@4`, `when: view == redpandaConnect.cloud && viewItem =~ /^cloudPipeline\b/`.
- Graph: `src/adapters/graphPanel/graphPanel.ts` (message dispatch L228-253; metrics subscription L174-207); `src/shared/protocol.ts` `WebviewMessage` L161-169 + `parseWebviewMessage` L309 → add `metricsRequested`; `webview/src/Graph.tsx` L416-419 (the only button, `.rpcn-fit-view`), `webview/src/host.ts` `post()` L23. The panel calls `SHOW_METRICS_COMMAND` with its file uri.
- `src/adapters/vscode/cloudView.ts` -- the loaded pipelines cache `pipelines` Map L577 (`Loaded<CloudPipeline[]>` per cluster), `cachedChildren` L1208 and its walk L1373 (read the cache, never load); prompt seams `pickChoice` L314 (the pattern for the pick's seam).
- `src/shared/metricsProtocol.ts` -- `NO_FILE_TEXT` L261, `metricsStateTexts` `'none'` L331.
- Tests: `src/test/integration/suites/98-metrics.ts` (`open` L66, `runAndWait` L75, `stop` L81), `99b-cloud-metrics.ts` (`showMetrics`, `setUpAccess` L94, `pipelineNode`); seams `api().metrics` (`file`, `state`, `show`, `actions`, `visible`), `api().run.phaseOf/portOf/statusBarText`, `GraphPanelHandle.posted/receive`. A pick needs a seam (as other quick picks in the repo do: find one and reuse its pattern).
- `README.md` -- the metrics section: list the entry points.

## Tasks & Acceptance

**Execution:**
- [ ] `src/adapters/vscode/run.ts` -- add `runningUris()`; status item per the Decisions -- the resolver and the pick need the running files.
- [ ] `src/adapters/vscode/metricsPanel.ts` + `src/extension.ts` -- the resolver in `showFor` (uri or active editor → running → mapped → pick per the Decisions), the direct-open behaviour, a pick seam -- one source rule for every entry.
- [ ] `package.json` -- inline `redpandaConnect.cloud.showMetrics` at `inline@4` on pipeline rows; any new command (status-bar menu) with `when: false` in the palette.
- [ ] `src/shared/protocol.ts`, `src/adapters/graphPanel/graphPanel.ts`, `webview/src/Graph.tsx` (+ css) -- the toolbar with Open Pipeline Metrics (codicon `pulse`), `metricsRequested` → `SHOW_METRICS_COMMAND` with the panel's uri.
- [ ] Tests -- integration: running file, mapped file with no run (99b), row inline (menu contribution asserted from package.json) and menu, graph button via `receive({type:'metricsRequested'})`, status bar, the pick when neither; webview test for the toolbar button posting `metricsRequested`.
- [ ] `README.md` -- the entry points.

**Acceptance Criteria:**
- Given any entry point, when it is used, then the tab is focused and names the source the matrix gives.
- Given the graph webview, when Open Pipeline Metrics is clicked, then exactly one `metricsRequested` is posted and nothing else in the graph changes.

## Implementation Notes

- Palette: the `commandPalette` entry that hid Show Pipeline Metrics without a detected active editor is removed, so NO_EDITOR's pick is reachable from the palette. "Active config" = the active editor's file when the DetectionRegistry accepts it (`isConfig`); a non-config editor counts as none (the pick).
- Status bar: the running text stays "$(debug-stop) Stop pipeline" (plus " · N/s" from the tab's summary `outputRate`, `formatRate`, only while the tab is visible and live on that local run); its click is the new `redpandaConnect.runMenu` (`when: false` in the palette), a quick pick through the `RunController.ui` seam. While stopping the item still kills at once (no menu); after exit it keeps Show terminal.
- Resolver: `MetricsPanel.showFor`, with new options `runningUris` (`RunController.runningUris()`), `isConfig`, `cloudPipelines` (`CloudView.loadedPipelines()`, cache only); the pick seam is `MetricsPanel.ui`. The mapped step runs `SHOW_CLOUD_METRICS_COMMAND`, so its failures give Show metrics' messages. DIRECT_OPEN is `bindOnOpen` on resolve / visible with nothing bound.
- Graph: `metricsRequested` runs `SHOW_METRICS_COMMAND` with the panel's uri; the toolbar sits top right (under the invalid-YAML banner while it shows), after Fit to view in the DOM.
- 99b's two ticket 8 NOT RUNNING, MAPPED tests now bind with `metrics().show(uri)` (the command would now go to the mapped pipeline).

## Plan Change Log

## Review Triage Log

Pass 1 (quick lens, 2026-11-21): 7 findings — high 0, medium 3, low 4, false 0, maybe-false 0. 6 patched, 1 rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `bindOnOpen` re-runs Show metrics on every reveal when it binds nothing (signed out, gone pipeline), repeating the notification; a failed Cloud step skips the only-running-file step | medium | patch | `cloudMetrics.ts:374` / `:388` show info and return without `showCloud`, so `this.uri` stays unset and `onDidChangeVisibility` calls `bindOnOpen` again. Patch: the mapping is tried once per active URI, then fall through. |
| 2 | Palette `resourceScheme == file` guard removed and not moved into the resolver: an untitled or `redpanda-cloud:` active config, or an untitled graph, binds a non-file URI | medium | patch | `activeConfig()` checks only `isDetected`; `showMapped` is false for non-file schemes, so `show(target)` runs. Patch: file URIs only; non-file → pick. |
| 3 | Toolbar hidden behind the invalid-YAML banner | medium | patch | `.rpcn-banner` is top 0, z-index 10, full width; `.rpcn-toolbar` is top 8px, z-index 5. Patch: place it below the banner. |
| 4 | `WEBVIEW_MESSAGES` in `protocol.test.ts` lacks `metricsRequested` | low | patch | Confirmed at `protocol.test.ts:65-74`. Added. |
| 5 | NO_EDITOR integration test asserts nothing in the empty case | low | reject | The unit test NO_EDITOR asserts `NO_CONFIG_MESSAGE`; the integration fix needs a new info-message seam on the extension API. |
| 6 | No test for the removed palette `when` | low | patch | No contribution assertion exists; one assertion added. |
| 7 | Pick labels local runs by basename only; same-named runs in a multi-root workspace look identical | low | patch | `pick()` uses `path.basename` with 'Local run'. Patch: the folder in the description. |

The six patches applied by the implementer (#5 rejected); a full-run ordering race in 99b (a late secret-storage delete after a sign-out undoing the next test's stored access) fixed in the suite teardown (a 1 s settle after a disconnect, as the 7.4 suite does), assertion unchanged. Verified after them: `npm run compile`, `test:webview` 421, `test:corpus` 182, stable 1719 passing / 1 pending / 0 failing, multiroot 15 passing; no `vscode` import in `src/core`, `src/shared`, `src/adapters/metrics`.

## Design Notes

Resolver order mirrors board 5's command card: "its local run when one runs, else its mapped Cloud pipeline, else a pick of runs and Cloud pipelines". The graph button reuses the command with the file uri so the graph and the command can never disagree.

## Verification

**Commands:**
- `npm run compile` -- expected: no errors.
- `npm run test:webview` and `npm run test:corpus` -- expected: all pass.
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` -- expected: all pass; then `--label multiroot`.
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no matches.

**Manual checks:**
- Dev host: run `metrics_a.yaml`, use the status bar item → tab live; Show Pipeline Metrics with no editor → pick; graph toolbar button; a Cloud row's inline icon.


## Manual Check

- 2026-11-21, the user, in the dev host (VS Code 1.143.1 from `.vscode-test`, extension at `a355618`, restarted on the build) on the status bar menu of a local run, the command (Cloud pipeline of the mapped `metrics_a.yaml`, Not running, the pick), the graph toolbar and the Cloud row: "tested, no issues".
