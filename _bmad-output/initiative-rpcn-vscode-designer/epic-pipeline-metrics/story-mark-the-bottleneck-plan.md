---
title: 'Mark the bottleneck'
type: 'feature'
ticket: '7'
created: '2026-11-20'
status: 'built'
baseline_revision: '780d06be0b88c3844f5c3af3bd6f27c167e8589a'
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

**Problem:** The tab and the graph show each component's figures, but the user still has to find the component that holds the pipeline back, the ones with errors, and whether messages are lost between the input and the output (E7 R6). With many columns the component names also scroll out of view.

**Approach:** From 7.6's windowed figures, compute each component's share of the pipeline's time and mark the slowest in the tab (a "Slowest" summary line, a Share column, the row highlighted) and on its graph node (board 2's "SLOWEST · N% of the time" band). Components with errors over the window are marked in both. A summary line names the input's and the output's rates and any gap between them. The tab's Component column stays pinned on the left while the other columns scroll sideways, and the header row stays fixed.

## Boundaries & Constraints

**Always:**
- The input is never a candidate and has no share (its latency is end-to-end, AD-25).
- Computed in `src/core/metrics.ts` (pure) over the same window as the figures; the host sends the marks, the webview only renders (AD-17, AD-25).
- Nothing is marked until the window has a share to compare (no rates yet: no mark); ties: the first in config order.
- Theme colours only: the slowest mark uses a warning-like theme colour, errors an error-like one; the metrics marks never reuse AD-17's lint marker classes (`pipeline-node-error`/`-warning`), so a lint error and a metrics mark stay distinct.
- Graph node boxes keep 7.3's size rule (taller only while figures show); the band fits inside it or the layout accounts for it once, never per reading.
- The pinned Component column and fixed header work in light, dark and high-contrast themes (an opaque theme background under them).
- AD-25's Bottleneck bullet is amended to what the Decisions settle.

**Never:**
- No Pause, Show on graph or Metrics on/off buttons (entry 9); no new empty or error states (entry 8).
- No alerts or notifications for a bottleneck or errors.
- No change to reading, the window or the existing figures.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sleep | `mapping` + `sleep 5ms` + output, live | the sleep is marked slowest (tab row, summary "Slowest: <name> <path> · N% of the pipeline's time · p50 …", graph band) | — |
| Nested | a `sleep` inside a `branch` | marked per the Decisions | — |
| Errors | a processor with errors over the window | its row and node marked with errors; summary "Errors: <names> <rate>/s" | — |
| No errors | none | summary "Errors: none"; no marks | — |
| Gap | output rate below the input's per the Decisions | summary names the gap | — |
| No gap | rates equal | "Input X/s → Output Y/s · no gap" | — |
| First reading | no rates | no slowest, no share, no gap; the summary line not shown | — |
| Not live | stopped / not running / Cloud states | graph marks cleared with the figures (as 7.3) | — |
| Sorting | sort by Share | rows sort by share; the input last | — |
| Narrow tab | many columns | the Component column stays visible while scrolling sideways; header fixed while scrolling down | — |

## Decisions

- Decision (user, 2026-11-20): from the request after 7.6 (the entry's note): the Component column stays pinned on the left while the path and figure columns scroll sideways, and the header row stays fixed when the rows scroll; only the Component column is pinned.
- Decision (user, 2026-11-20): a component's share is the time it spent over the window (its Δ`_latency_ns_sum`) divided by the total of the top-level processors and the output; the slowest is the largest share. AD-25's Bottleneck bullet ("by p50 (or mean)") is amended to this.
- Decision (user, 2026-11-20): only components with no child components (leaves) can be marked slowest, so a `sleep` inside a `branch` is marked, not the branch; every component still shows its share of the same total.
- Decision (user, 2026-11-20): a gap is named when the output's rate differs from the input's by more than 5%: "Input 200.0/s → Output 150.0/s · gap 50.0/s (25%)", else "no gap"; neutral text, no warning colour.
- Decision (user, 2026-11-20): keep the full plan (about 2,200 tokens) as one slice.

</frozen-after-approval>

## Code Map

- `src/core/metrics.ts` -- `figures(readings, windowMs)` L217-279 keeps `totals.sum` (Δ`_sum`, ns) and `totals.count` local (L237-242): expose what the share needs (Δsum over the window per component). `ComponentFigures` L64-81; `metricRows` L375-420 (pre-order, `depth`); `rowFigures`/`EMPTY_FIGURES` L359-368; `sortRows` L423-454 (`switch` on `MetricsColumn`; nulls last); `nodeFiguresOf` L344-357; `figuresByNode` L322-337. Add a pure `bottleneck(...)`/marks function: shares, the slowest, the error components, the input/output gap.
- `src/shared/metricsProtocol.ts` -- `MetricRow` L19-47 + `isRow` L287-295 (add `share`, `slowest`, `hasErrors`); `MetricsColumn` L49, `METRICS_COLUMNS` L52, `COLUMN_LABELS` L56, `COLUMN_TITLES` L65 (add `share`, after Mean, before Trend, per board 1); `show` L112-129 + `parseMetricsHostMessage` L327-338 (add the summary: slowest, errors, input/output rates and gap); `formatShare` L239, `formatRate` L220, `formatNs` L228.
- `src/shared/protocol.ts` -- `NodeFigures` L95-105 + `isNodeFigures` L249-258 (add the share and the marks to the `component` kind).
- `src/adapters/vscode/metricsPanel.ts` -- rows at L287; post the summary.
- `src/adapters/graphPanel/graphPanel.ts` -- `sendFigures` L205-225 (marks come through `nodeFiguresOf`).
- `webview/src/metrics/MetricsView.tsx` -- header L113-132, `p.rpcn-metrics-state` L133-137 (the summary goes after it, board 1), table L138-182 (first cell `span.rpcn-metrics-component`); `metrics.css` -- `.rpcn-metrics-scroll` L74-77, table L82-87, `th` already `position: sticky; top: 0` L88-99; add `left: 0` sticky to the first column (`th` and `td`, header corner above both), opaque background, a separator edge.
- `webview/src/nodes.tsx` `ComponentView` L53-67 (`.rpcn-node-figures` L65; the band after it); `webview/src/layout.ts` `markFigures` L257-276, `FIGURES_LINE`/`FIGURES_WIDTH` L19-20, `toElkGraph` L524-525; `webview/src/graph.css` `.rpcn-node-figures` L55-62 (AD-17 markers L176-233: do not reuse).
- Tests: `webview/src/metrics/MetricsView.test.tsx` (`send`, `row`, `SHOW`, `texts`); `webview/src/layout.test.ts` L479+, `state.test.ts` L301-315, `keyboard.test.tsx` L492-505; `src/test/core/metrics.test.ts`; `src/test/helpers/fakeMetrics.ts` `connectText` (has `sum`, `count`, `errors`); `98-metrics.ts` `CONFIG` L27-39 (sleep), GRAPH FIGURES ~L256 with exact-shape `nodeFigures` assertions L306-366 (update them); `99b-cloud-metrics.ts`.
- `README.md` L72; architecture AD-25 Bottleneck bullet L273; AD-17 node-figures amendment L179 (the new fields).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/metrics.ts` -- shares, the slowest, error components and the gap per the Decisions; unit tests for each matrix row.
- [x] `src/shared/metricsProtocol.ts`, `src/shared/protocol.ts` -- the row and node fields, the Share column, the summary, validators and texts.
- [x] `src/adapters/vscode/metricsPanel.ts`, `src/adapters/graphPanel/graphPanel.ts` -- send them.
- [x] `webview/src/metrics/*` -- the summary line, the Share column, row marks, the pinned Component column and fixed header.
- [x] `webview/src/{nodes.tsx,layout.ts,graph.css}` -- the slowest band and the errors mark on nodes.
- [x] Tests: webview (summary, column, marks, sticky styles present), layout/state/keyboard, integration 98-metrics (the sleep processor marked in the tab and on the graph; a processor with errors marked).
- [x] `README.md` L72; architecture AD-25 Bottleneck and AD-17 amendment.

**Acceptance Criteria:**
- Given `metrics_a.yaml` running, when the tab and its graph are open, then `slow_one` is marked slowest in both, with the same share.
- Given a Cloud pipeline shown (7.5), when its figures are live, then the same marks show from its readings.

## Implementation Notes

- Top-level and leaf are read from Connect's paths, per kind: a processor (or output) is top-level when no other series of its kind has a path that is a prefix of its own, and a leaf when none is nested in it. So an output's own processors (`root.output.processors.N`) count as top-level processors and do not stop `root.output` from being a leaf.
- Resources: a probe on 4.100.0 showed a `resource:` processor emits no series, so each resource's own series (`root.processor_resources`, with its label) is in the total; its children (`root.processor_resources.…`, no label) are nested in it by path and not added. A resource is a leaf by its config node (no child components); with no config, every resource is.
- An output `broker` has no `root.output` series: the summary then shows the input's rate only and names no gap.
- A share needs Δ`_sum` over the window and a total above 0: a window with no messages has no share and no slowest, but has a summary (rates 0).
- The gap is input − output; its text shows the absolute value and its share of the input's rate rounded to a whole percent; with an input rate of 0 and an output above it, the percent is left out.
- `NodeFigures` `component` gained a required `share` and optional `slowest: true` / `hasErrors: true`; `MetricRow` gained `share`, `slowest`, `hasErrors`; `show` gained an optional `summary` (`MetricsSummary`), computed by `metricsSummary(rows)` in the core.
- Graph layout: a `BAND_LINE` (16 px) is added once to every component box while figures show, so the band can move between nodes without a new layout.
- The fake Cloud body's `processor_latency_ns_sum` now grows with the counters (it was a constant), so 99b can check the marks.

## Plan Change Log

## Review Triage Log

### Pass 1 (quick lens), 2026-11-20: high 0, medium 3, low 4, false 0, maybe-false 0

Probed on the real binary (Redpanda Connect 4.100.0, `--set http.enabled=true`): a `- resource: res_one` processor emits **no** series of its own (only `root.processor_resources{label="res_one"}`); a resource's children are reported as `root.processor_resources.branch.processors.0` with `label=""` (no resource label); an output `broker` emits no `root.output` series, only `root.output.broker.outputs.N`.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `metrics.ts` `figures()`: resources are left out of the total, assuming the `resource:` processor reports their time | medium | patch | Confirmed by the probe: the `resource:` processor has no series, so a resource's time counts in no top-level component and its share can exceed 1 ("SLOWEST · 250%"). Patch: count each resource's time in the total; fix the "0–1" doc comments; a test with the probe's shape. |
| 2 | `metrics.ts` `nestedIn`: a resource's children (path `root.processor_resources.…`, no label) make every resource a non-leaf | medium | patch | Confirmed by the probe: the child's path carries no resource label. Patch: a resource's leaf status comes from its config node (no child components), and series under `root.processor_resources.` never make a resource a non-leaf by path; with no config (an unmapped Cloud pipeline), resources are leaves. A test. |
| 3 | `metrics.ts` `metricsSummary()`: under an output `broker`, "Output Y/s" and the gap use one child's rate | medium | patch | Confirmed by the probe: no `root.output` series under a broker; a 2-way `fan_out` would show a 50% gap. Patch: with no `root.output` series, the flow shows the input's rate only and names no gap; a test. |
| 4 | `graph.css` `.rpcn-node-slowest:not(…)` (0,3,0) beats `.rpcn-node-selected` border | low | patch | Confirmed by specificity. Direct fix: the selected border wins over the slowest border (the band and colours stay). |
| 5 | `metrics.ts` `bottleneck()` is exported and named by AD-25 but production repeats `marksOf(inConfigOrder(…))` inline in `nodeFiguresOf` and `metricRows` | low | patch | Confirmed: two paths that must agree. Direct fix: both call the one function. |
| 6 | `metricsProtocol.ts` `summaryParts()` is tested but unused; `MetricsView.tsx` `Summary` rebuilds the order | low | patch | Confirmed. Direct fix: `Summary` renders from `summaryParts`. |
| 7 | `metrics.css` error-row bar uses `--vscode-editorError-foreground`; every other errors mark uses `--vscode-errorForeground` | low | patch | Confirmed. Direct fix: one token. |

All seven patches applied by the implementer. Verified after them: `npm run compile`, `test:webview` 416, `test:corpus` 182, stable 1683 passing / 1 pending / 0 failing, multiroot 15 passing; no `vscode` import in `src/core`, `src/shared` or `src/adapters/metrics`.

## Design Notes

- Board 1's summary: `Slowest: sleep pipeline.processors[2] · 99.6% of the pipeline's time · p50 5.17 ms` · `Input 200.0/s → Output 199.8/s · no gap` · `Errors: none`. Board 2's band: `SLOWEST · 99.6% of the time` under the figures; the slowest node's border and latency in the warning colour.

## Verification

**Commands:**
- `npm run compile && npm run test:webview && npm run test:corpus` -- expected: all pass.
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable`, then `--label multiroot` -- expected: all pass.
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no matches.

**Manual checks:**
- In the dev host, run `metrics_a.yaml`, open Pipeline Metrics and its graph: `slow_one` is marked slowest in both; narrow the panel and scroll sideways: the Component column stays.


## Manual Check

- 2026-11-20, the user, in the dev host (VS Code 1.143.1 from `.vscode-test`, extension at `688a46e`, restarted on the new build) with `metrics_a.yaml` run locally: "tested, no issues".
