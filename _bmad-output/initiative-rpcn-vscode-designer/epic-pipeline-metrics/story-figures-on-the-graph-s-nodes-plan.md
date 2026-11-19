---
title: "Figures on the graph's nodes"
type: 'feature'
ticket: '3'
created: '2026-11-18'
status: 'built'
baseline_revision: 'cc0f23c9001630b00b63ab5e43557e2aaa4c3c1b'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/story-metrics-of-a-local-run-in-the-pipeline-metrics-tab-plan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Pipeline Metrics tab (7.2) shows each component's figures. The pipeline graph shows none, so a developer cannot see on the picture where messages slow down or fail.

**Approach:**
- The host maps each reading's figures onto the graph's node ids, reusing 7.2's `metricRows` / `pathToNodeId` (AD-25 mapping).
- It sends them in a new `nodeFigures` message beside `nodeStatus`, which amends AD-17.
- Each input, processor and output node shows one figures line while its config's local run is live, and nothing when none is.
- Entries 5 and 7 will send their figures and marks through the same message.

## Boundaries & Constraints

**Always:**
- The host computes and maps everything; the webview only renders (AD-17, AD-25). `src/shared/protocol.ts` imports nothing.
- One figures line per component node, built to design board 2:
  - processors and outputs: `<out>/s · <p50> / <p99> · <errors>/s errors`;
  - the input: `<out>/s` only (its latency is end-to-end, AD-25);
  - the formatting reuses `formatRate` / `formatNs` from `src/shared/metricsProtocol.ts`.
- Nodes with no matched series show no line. Route and group nodes show none.
- Figures never go into the live-region announcements, and never re-lay out the graph on each reading.
- Keep 7.2's tab behaviour, its states and its constants (`METRICS_INTERVAL_MS`, `QUIET_FAILURES`, `NO_SERIES_READS`) unchanged.

**Never:**
- No bottleneck or error marks (entry 7).
- No graph toolbar "Metrics on" / "Open Pipeline Metrics" (entry 9).
- No Cloud figures (entry 5), no trend.
- Do not change the `nodeStatus` dedup/race logic, `markStatus` identity semantics or the existing marker icons.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Live | graph of a running config open | every matched node shows its line; figures follow the tab's (same reading, same numbers) | — |
| Labelled / resource / nested | `label: slow_one`; a `resource:` processor; a `branch` child | each gets its own figures on its own node | — |
| Not running | graph open, no run | no figures line on any node | — |
| Run stops | run stops while the graph shows figures | lines cleared | — |
| First reading | one reading so far | latencies shown, rates "—" | — |
| Unmatched series | a series with no node | not on the graph (still in the tab) | — |
| Edit while live | the YAML changes, nodes re-id | figures re-mapped on the next reading; a node gone loses its line | — |
| Broken YAML | YAML does not parse | figures frozen as for `nodeStatus` | — |
| Graph reopened | graph hidden then shown (`ready`) | the snapshot carries the current figures | — |

## Decisions

- Decision (user, 2026-11-18): one shared reader (feed) per file. It reads while that file's Pipeline Metrics tab *or* its graph is visible (AD-25). The tab and the graph show the same reading. 7.2's reading logic moves out of `MetricsPanel` into the feed unchanged, and the graph panel gains a visibility seam.
- Decision (user, 2026-11-18): component nodes are taller only while the graph has a live source (figures to show). The graph is re-laid out once when the figures start or stop, never on each reading.
- Decision (user, 2026-11-18): keep the full plan (about 2,400 tokens) as one slice.

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/metricsPanel.ts` -- 7.2's tab.
  - The reading state to move into a per-file feed: `port`, `prev`, `failures`, `noSeriesReads`, `notServedReason`, `timer`, `inFlight`, `generation`, `factory`, `reads`; and `refreshState`, `runChanged`, `reading`, `resume`, `pause`, `readNow`, `failed`, `dropReadings`, `setSourceFactory`.
  - Keep in the tab: `view`, `ready`, `uri`, `sort`, `configRows`/`rows()`, `postShow`, `title`, `show`/`showFor`.
- `src/core/metrics.ts` -- `figures`, `metricRows` (rows carry `nodeId`), `pathToNodeId`. Reuse as is.
- `src/extension.ts` L276-290 -- `configFor` (the model, paths, and the `metrics` type from disk); move it where both consumers get it. Wiring: `GraphPanels` L295-307; test-mode `metrics` L130/L409.
- `src/adapters/graphPanel/panels.ts` -- `GraphPanels` L180 (`panels` map keyed by `uri.toString()`, re-keyed on rename); `GraphPanelsOptions` L105 (add the metrics option as `diagnostics` is); panel creation ~L820-860 (`retainContextWhenHidden: false`, `onDidDispose` L847). No visibility tracking today: add `onDidChangeViewState` / `panel.visible`. `panelFor` L1082 is the test seam.
- `src/adapters/graphPanel/graphPanel.ts` -- `receive` L129 (`ready` → `postSnapshot` L163); `post` L331 (`posted`, `MAX_POSTED` 50); `sendStatus`/`postStatus` L358-388 (do not change); `sendModel` L391.
- `src/shared/protocol.ts` -- `HostMessage` L112-123; `nodeStatus` L121; `SnapshotMessage` L102; validators `isNodeStatusById` L214, `isValidHostMessage` L226-247. Add `nodeFigures` {byId: nodeId → {inRate,outRate,errorRate,p50,p99} | the input's out only} and a snapshot field.
- `src/test/shared/protocol.test.ts` -- `HOST_MESSAGES` L26-48, `HOST_SHAPES` L69, `MALFORMED` L83.
- `webview/src/state.ts` -- `ViewModel` L23, `INITIAL_VIEW` L36, `reduce` L81 (`case 'nodeStatus'` L95); `liveAnnouncements` L180 (figures excluded).
- `webview/src/Graph.tsx` -- props L86; `markStatus` L155. Add a parallel figures memo that keeps node identity when a node's line is unchanged.
- `webview/src/layout.ts` -- `NODE_HEIGHT = 48`, `nodeWidth` L79, ELK heights L458/478/528, `ViewData` L34, `markStatus` L227.
- `webview/src/nodes.tsx` -- `ComponentView` L52: add `.rpcn-node-figures` after `.rpcn-node-name` L62. `webview/src/graph.css` `.rpcn-node` L23. Theme colours only.
- Tests: `webview/src/{layout,state,style}.test.ts`; `src/test/integration/graphHelpers.ts` (`withGraph`, `testPanels`, `live`, `settle`); `82-graph-markers.ts` L15 (the `posted` filter pattern); `98-metrics.ts` (fake source through `setSourceFactory`, `runAndWait`); `src/test/helpers/fakeMetrics.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/metrics/feed.ts` (vscode-free) or `src/adapters/vscode/metricsFeed.ts` -- the per-file feed (Decisions): subscribers with a visible flag, reads while any is visible, emits {state, figures, time}; the 7.2 logic moved, not changed.
- [x] `src/adapters/vscode/metricsPanel.ts` -- consume the feed; same states and messages.
- [x] `src/shared/protocol.ts` + `protocol.test.ts` -- the `nodeFigures` message, the snapshot field, validators.
- [x] `src/adapters/graphPanel/{panels,graphPanel}.ts` -- visibility seam; subscribe its file's feed; map rows with a `nodeId` to `byId`; post `nodeFigures` (deduped as `nodeStatus` is); include in the snapshot; empty on stop or when not running.
- [x] `webview/src/{state,Graph,layout,nodes}.ts(x)`, `graph.css` -- store and render the line (Decisions: taller while live); no announcement.
- [x] `src/extension.ts` -- the wiring; one `configFor`; the test seam reaches the feed.
- [x] Tests: unit tests for the mapping to `byId` and the feed's subscriber visibility; webview tests (line text, the input's form, no line without figures, identity kept); integration `98-metrics.ts` or a new `87-graph-figures.ts` (fake source: live lines that match the tab's rows, labelled/resource/nested nodes, stop clears, hidden graph stops reads when the tab is closed too).

**Acceptance Criteria:**
- Given a running config with its graph and its metrics tab both open, when a reading arrives, then each node's line shows the same numbers as its row in the tab.
- Given only the graph is open, when the run is live, then the graph shows figures; when the graph is hidden too, no read happens.

## Design Notes

- The figures line, example: `200.0/s · 7.7 µs / 21 µs · 0.0/s errors`; input: `200.0/s`. The node's tooltip carries the same text.
- A rename re-keys the panel; the feed follows the panel's current URI.

## Verification

**Commands:**
- `npm run compile && npm run test:webview && npm run test:corpus` -- expected: all pass.
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable`, then `--label multiroot` -- expected: all pass.
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no matches.

**Manual checks:**
- Run `.vscode-test/story-7-2/metrics_a.yaml` with its graph open. Each node, including `slow_one` and the nested `mapping`, shows a line matching the tab, and stopping the run clears the lines.

## Review Triage Log

### Pass 1 (quick lens), 2026-11-18: high 0, medium 3, low 1, false 2, maybe-false 0

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `Graph.tsx` `figured` memo / `markFigures`: node identity not kept for unchanged lines | medium | patch | Confirmed: `markFigures(marked, …)` starts from `markStatus`'s nodes, which never carry `data.figures`, so every node with figures is a new object on each reading; the plan asks for identity kept. Patch: compare with the previous figured nodes (by id and base node), keep the old object when base and line are unchanged; a test through the same path `Graph.tsx` uses. |
| 2 | `graphPanel.ts` `sendFigures` only on feed updates; `state.ts` `model` keeps figures: after a re-id edit, old figures sit on the wrong nodes until the next reading | medium | patch | Confirmed: `changed()`/`sendModel` never re-map, and the webview keeps `nodeFigures` across `model`. Patch: after a new model is sent, re-map the last update's figures onto it (`sendFigures`). |
| 3 | `metricsPanel.ts` `show()` → `feed.restart()`: Show Pipeline Metrics wipes a live graph's figures and re-lays it out twice | medium | patch | Confirmed: `restart()` clears `last` and emits, the graph posts `{}` and shrinks, then grows on the next reading with rates "—". Against the shared-feed Decision. Patch: Show does not restart a feed (the tab takes the feed's current update); update the test that expected the restart. |
| 4 | `nodeFiguresOf`: the `- resource: res_one` flow node shows no line; figures only on `res:processor:res_one` | false | reject | Connect reports a resource processor's series under the resource (its label), not under the `resource:` reference. AD-25 maps a unique label to `res:<kind>:<label>`, so the resource's own node is "its own node" in the matrix row. |
| 5 | `metricsPanel.ts`: hiding the tab drops nothing while the graph is visible | false | reject | Intended by the shared-feed Decision (one reader per file, reading while either is visible). The readings are in use by the visible graph, and the tab gets the feed's current update when shown. |
| 6 | `layout.ts` `toElkGraph`: every leaf grows while live, to 250 px, above `MAX_NODE_WIDTH` 220 | low | reject | Consistent with the "taller while live" Decision (one uniform re-layout, none per reading). The width is what the line needs; cosmetic. |

All three patches applied by the implementer. Verified after them: `npm run compile`, `test:webview` 401, `test:corpus` 182, stable 1614 passing / 1 pending / 0 failing, multiroot 15 passing; no `vscode` import in `src/core`, `src/shared` or `src/adapters/metrics`.

## Manual Check

- 2026-11-19, the user, in the dev host (VS Code 1.143.1 from `.vscode-test`, workspace `.vscode-test/story-7-2/`, extension at `b27b060`): "tested, no issues".
