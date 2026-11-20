---
title: 'The live window, trend lines and the full figures'
type: 'feature'
ticket: '6'
created: '2026-11-20'
status: 'built'
baseline_revision: '529a89a767581f45425005763501e28a04a2ac6c'
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

**Problem:** The tab's rates come from the last two readings only, so they jump with every read; it has no batches, error share, p90 or mean latency, and no way to see a trend (E7 R3, R7).

**Approach:** The metrics feed keeps the readings of the last 15 minutes in memory while something showing them is visible. The tab offers a 1, 5 or 15 minute window (board 1) and computes each figure over it: messages and batches in and out per second, errors per second and as a share of received, p50, p90, p99 and the mean latency from `_sum`/`_count`. Each row gets a trend line of its messages out per second over the window. A counter that goes back, or a new `pod`, starts a new count, never a negative rate.

## Boundaries & Constraints

**Always:**
- AD-25 Figures: counters and `_sum`/`_count` summed across pods per path + label; quantiles kept per pod and the highest shown; error share = `processor_error / processor_received` (processors only, as AD-25 defines it); mean = Δ`_sum` / Δ`_count` over the window. The input's latency is end-to-end and is never compared with the others.
- A rate over the window sums the increments between consecutive readings, per pod; a decrease, or a pod not in the previous reading, is a restart, and that interval counts per the Decisions; never negative.
- Readings are kept only in memory, at most 15 minutes, compactly (per component, not the whole text); dropped when nothing showing them is visible and when the source changes (restart, rebind to Cloud or local). Nothing is written to disk.
- The pure computation lives in `src/core/metrics.ts` (no `vscode`); the webview only renders.
- The trend line is inline SVG drawn by the webview from the host's points, theme colours only, with an accessible text (e.g. its min and max); no chart library.
- Sortable by every figure column; existing sort and row behaviour kept.

**Never:**
- No bottleneck mark, no "share of the pipeline's time" column, no Slowest line (entry 7); no Pause or Show on graph buttons (later entries); no new empty or error states (entry 8).
- No history across tab closes, no export.
- No change to how readings are read (intervals, sources, states).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Windows | fake readings over a simulated 15 min, 100/s for 10 min then 300/s | 1 min shows 300/s, 5 min 300/s, 15 min the mean of both; each its own trend | — |
| First reading | one reading only | latencies (latest) and no rates | — |
| Reset | a counter goes back mid-window | no negative rate; the interval counted per the Decisions | — |
| New pod | Cloud reading with a new `pod` value for a path | treated as a restart for that pod | — |
| Batches / errors | batch and error counters served | batches in/out per second; errors per second and error % (none when nothing received) | — |
| Mean | `_sum`/`_count` served | mean = Δsum/Δcount over the window; none when Δcount is 0 | — |
| p90 | quantile 0.9 served | p90 shown (latest, highest across pods) | — |
| Window change | 5 → 1 min | rows and trends recomputed at once, no new read | — |
| Older than 15 min | readings past 15 min | dropped | — |
| Closed | the tab closed and the graph hidden | readings dropped; reopening starts empty | — |

## Decisions

- Decision (user, 2026-11-20): the graph's node figures are computed over the same window as the tab (one window choice for the session, 5 min when the tab was never opened), so each node matches its row.
- Decision (user, 2026-11-20): every figure is a sortable column, in this order: In/s, Out/s, Batches in/s, Batches out/s, Errors/s, Error %, p50, p90, p99, Mean, Trend (out/s; not sortable); the table scrolls sideways when the tab is narrow.
- Decision (user, 2026-11-20): the window is 5 min by default; a choice holds until VS Code restarts (in memory, no setting, no workspace state).
- Decision (user, 2026-11-20): a reset interval (a counter that goes back, or a new `pod`) counts the new value as the increase, as Prometheus's `rate()` does.
- Decision (user, 2026-11-20): keep the full plan (about 2,300 tokens) as one slice.

</frozen-after-approval>

## Code Map

- `src/core/metrics.ts` -- `ComponentReading` L27, `ComponentFigures` L42, `COUNTERS` L56, `LATENCIES` L65 (add `processor_batch_received/_sent`, `output_batch_sent`, quantile 0.9 at L109, `_sum`/`_count` — today unmatched by name), `componentReadings` L82 (sums pods; keep per-pod values for the window), `rate` L123, `figures(prev, cur)` L135 (replace with a windowed `figures(readings, windowMs)`; keep the two-reading case as the 1-interval special case), `figuresByNode` L199, `nodeFiguresOf` L221, `metricRows` L243, `EMPTY_FIGURES` L236, `sortRows` L291.
- `src/core/prometheus.ts` -- `PromSample {name, labels, value}` L11; `familyOf` L159 strips `_sum`/`_count`.
- `src/adapters/vscode/metricsFeed.ts` -- `prev` L157 / `last` L158; updates at local L493-494 and Cloud L546-547; cleared in `restart` L315, `dropReadings` L357, `accessChanged` L257, new port L383. Replace `prev` with the window's compact readings; `MetricsUpdate` L114 carries what the tab needs to recompute per window (the window of readings or a function of it).
- `src/adapters/vscode/metricsPanel.ts` -- `updated()` L254-267 (`metricRows` when figures change), `postShow()` L282; holds the chosen window; handles the window message.
- `src/adapters/graphPanel/graphPanel.ts` -- `sendFigures` L203-216 (`nodeFiguresOf` on `update.figures`): per the Decisions.
- `src/shared/metricsProtocol.ts` -- `MetricRow` L16 (add the figures and the trend points), `isRow` L219, `MetricsColumn` L35, `METRICS_COLUMNS` L37, `COLUMN_LABELS` L39, `nextSort` L204, `show` L72 (add the window), `MetricsWebviewMessage` L89 + `parseMetricsWebviewMessage` L270 (add `{type:'window', minutes}`), `KEPT_TEXT` L101 (board 1's footer: "Figures over the last N minutes · readings kept only while this tab is open").
- `webview/src/metrics/MetricsView.tsx` -- header L63-69 (add the 1/5/15 min segmented control, `aria-pressed` buttons), columns L80-110, `cellText` L25; `metrics.css`; tests `MetricsView.test.tsx` (`send`, `row`, `SHOW`, `texts`).
- Tests: `src/test/core/metrics.test.ts` (`reading(time, text)` L18, COUNTER_RESET L64, pods L80); `src/test/helpers/fakeMetrics.ts` `connectText` L31 (extend: batches, errors, quantile 0.9, `_sum`/`_count`, `pod`); `src/test/adapters/vscode/metricsFeed.test.ts`; `98-metrics.ts`.
- `README.md` L72: "Rates are over the last two readings…" — rewrite for the window and the new columns.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/metrics.ts` -- compact component samples (per pod), the new families, windowed figures and trend points; unit tests for every matrix row with simulated times.
- [x] `src/adapters/vscode/metricsFeed.ts` -- the 15-minute window of compact readings in place of `prev`; same clearing points.
- [x] `src/shared/metricsProtocol.ts` -- row figures, trend points, columns and labels, the window in `show`, the window message, validators, footer text.
- [x] `src/adapters/vscode/metricsPanel.ts` -- the chosen window, recompute on change; `src/adapters/graphPanel/graphPanel.ts` per the Decisions.
- [x] `webview/src/metrics/*` -- the window control, the new columns, the SVG trend; webview tests.
- [x] `src/test/helpers/fakeMetrics.ts` + `98-metrics.ts` -- the new families; an integration test that the window control changes the figures and the footer.
- [x] `README.md` -- L72.

**Acceptance Criteria:**
- Given a live local run, when the user picks 1, 5 or 15 min, then the rows, trends and footer follow at once and the next read is not brought forward.
- Given the 98-metrics and 99b-cloud-metrics suites, when run, then they pass (rates now over the window).

## Implementation Notes

- The session's window lives in `MetricsFeeds` (`windowMinutes`, `setWindowMinutes`), the one object the tab and every graph panel share; the tab's `window` message sets it. Each feed computes its update's `figures` over that window (`figures(readings, windowMs)` over the kept `CompactReading[]`), so the graph needs no change of its own: a window change re-emits every feed's figures at once (no read) and each node matches its row. `MetricsUpdate` keeps its shape (`figures` is now windowed and carries `trend`).
- `ComponentReading` keeps counters (and `_sum` / `_count`) per `pod` (`""` without one); `keepReading` keeps at most 15 minutes relative to the newest reading and ignores a reading older than the last.
- A rate needs the counter in the latest reading; the error share is processors only and none when nothing was received over the window; the mean is none when Δcount is 0. The input's and output's latency-free fields stay `null` as before.
- `MetricsPanel.receive` is the webview message handler, exposed on the test API (with `windowMinutes`) so the integration test can choose a window. `FakeMetrics` gained `clock` (simulated reading times) and `serve(port, (i) => text | undefined)` (per-read texts; `undefined` holds the read open).

## Plan Change Log

## Review Triage Log

### Pass 1 (quick lens), 2026-11-20: high 0, medium 2, low 4, false 0, maybe-false 0

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `98-metrics.ts` and `metricsFeed.test.ts` WINDOW: "no read brought forward" can't fail (a never-resolving read stays in flight, and `readNow` returns while `inFlight`) | medium | patch | Confirmed: `fakeMetrics.ts` L135-136 returns a promise pending until abort; `readNow` exits on `inFlight`. The acceptance criterion is not shown. Patch: let the in-flight read complete (no never-resolving read) and assert the read count across a window change against the interval. |
| 2 | `98-metrics.ts` WINDOW: the footer check calls `keptText` on the posted window (circular) | low | patch | Confirmed. Direct fix: assert the posted `windowMinutes` changes to 1 and 15 and the rows change; the footer text itself stays covered by `MetricsView.test.tsx`. |
| 3 | `98-metrics.ts` WINDOW: the session window is reset only on the test's last lines; a failure leaks 1 or 15 min into later suites | low | patch | Confirmed: `MetricsFeeds` is per session. Direct fix: reset to 5 in `teardown`. |
| 4 | `metricsPanel.ts` `receive('window')`: one change posts `show` twice and fires `changed` twice when the feed has readings | low | patch | Confirmed: `windowChanged` emits → `updated` posts; `receive` posts again. Direct fix: post from `receive` only when the feed emitted nothing (no readings). |
| 5 | `metrics.ts` `figures()`: a component missing from one reading counts its whole running total when it comes back | medium | patch | Confirmed: `intervalIncrease(undefined, b)` gives each pod's cumulative value. The Decision counts a new value only for a counter going back or a new `pod`; a whole component absent from the reading before (a Cloud export missing it once) is neither. Patch: an interval whose earlier reading lacks the component adds nothing for it (a new pod of a component that was present still counts its new value); a unit test. |
| 6 | `metrics.ts` processor `errorShare`: `has('errors')` checked twice | low | patch | Confirmed, same result. Direct fix: drop the outer check. |

All six patches applied by the implementer. Verified after them: `npm run compile`, `test:webview` 405, `test:corpus` 182, stable 1673 passing / 1 pending / 0 failing, multiroot 15 passing; no `vscode` import in `src/core`, `src/shared` or `src/adapters/metrics`.

## Design Notes

- Prometheus summaries' quantiles are the process's own (not computable per window): p50, p90 and p99 come from the latest reading; the mean is the only windowed latency. The tooltip of the latency columns says so.
- Memory: 15 min at 2 s is 450 readings; keep per component `{time, pod → counters, sum, count}` and the latest quantiles only.
- Trend: one point per reading interval (out rate), drawn as a polyline scaled to its own min/max; flat when constant.

## Verification

**Commands:**
- `npm run compile && npm run test:webview && npm run test:corpus` -- expected: all pass.
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable`, then `--label multiroot` -- expected: all pass.
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no matches.

**Manual checks:**
- In the dev host, run `metrics_a.yaml` and open Pipeline Metrics: the window control switches 1/5/15 min, each row has a trend line, and the new columns show batches, error %, p90 and mean.

