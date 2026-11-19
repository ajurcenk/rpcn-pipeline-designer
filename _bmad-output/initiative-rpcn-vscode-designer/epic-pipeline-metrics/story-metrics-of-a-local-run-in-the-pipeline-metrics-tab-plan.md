---
title: 'Metrics of a local run in the Pipeline Metrics tab'
type: 'feature'
ticket: '2'
created: '2026-11-18'
status: done
baseline_revision: '58023558752269c6b4494bd08dbd13fdf095c824'
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

**Problem:** A local Run passes `--set http.enabled=false`, so Redpanda Connect serves no metrics. A developer cannot see each component's throughput, errors or latency without leaving VS Code.

**Approach:** This story builds the tracer of epic 7, following AD-25.
- Each run gets a free 127.0.0.1 port with the HTTP server turned on.
- A pure core parses the Prometheus text into per-component figures.
- A `MetricsSource` reads the run's `/metrics`.
- A new **Pipeline Metrics** bottom-panel tab, opened by **Show pipeline metrics**, shows one row per component of the active config's run, live, while the tab is visible.

## Boundaries & Constraints

**Always:**
- AD-25 is the contract: the source interface, its failures (`refused`/`unreachable`/`notServed`), the flags, the bind retry, the series names, the rates and counter resets, and the path→node mapping.
- AD-15 layering: the parser and the figures go in `src/core`, the protocol in `src/shared`, and the source in `src/adapters/metrics` with no `vscode` import.
- The server listens on 127.0.0.1 only. Parallel runs each get their own port.
- Rows come in config order from `buildPipelineModel`, with nested processors and resources indented under their parent. A series with no node is listed last.
- Reading happens only while the tab is visible: stopped when it is hidden or disposed. Nothing is kept after it closes.
- Theme colours only (`--vscode-*`), no Redpanda branding. Build to design board 1, but leave out the window buttons, the trend, Slowest, the share and Show on graph (entries 3, 6 and 7).

**Never:**
- No Cloud source, no graph figures, no bottleneck mark and no trend or window (entries 3–7).
- No new entry points besides the command (entry 9).
- Do not change the Run's session map, terminal, Stop or restart logic, apart from adding a port, an event and the bind retry.
- Do not change `LINT_FLAGS`, the blobl argv or `LogsPanel`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | generate input → 2 processors → drop output, running, tab open | 4 rows: input out/s; each processor in/s, out/s, errors/s, p50, p99; output out/s, errors/s, p50, p99; updated every read | — |
| First reading | only one reading so far | latencies shown, rates "—" | — |
| Counter reset | a counter lower than in the previous reading | that rate restarts from this reading, never negative | — |
| Two runs | a.yaml and b.yaml running | different ports; the tab shows the file it was opened for | — |
| Not running | command on a config with no run | tab names the file and says "Run this file to see its metrics" | no read |
| Run stops / reruns | the run stops while the tab is open | last figures kept, marked stopped, reading stops; a rerun of the same file resumes on its new port | — |
| Port taken | the child exits with "address already in use" at start | restarted once with a new free port; a second failure shows the run error | — |
| Not served | 404 / not Prometheus text, or the config's `metrics` is not `prometheus` | "no metrics served" line naming the cause | `notServed`, no retry loop |
| Unreachable | connection refused while running (start-up) | keeps reading at the interval | `unreachable`, quiet until 3 failures |
| Hidden tab | tab hidden | the timer stops; on show, an immediate read | — |

## Decisions

- Decision (user, 2026-11-18): a config's own `http` section is always overridden for the run: `--set http.enabled=true --set http.address=127.0.0.1:<port>`. A `metrics` section whose type is not `prometheus` (`none`, `json_api`, a `mapping`) is not overridden. The tab then shows "no metrics served: this config's `metrics` section is `<type>`" (`notServed`), and entry 8 polishes the wording.
- Decision (user, 2026-11-18): a local run is read every 2 s, and each rate is over the last two readings.
- Decision (user, 2026-11-18): keep the full plan (about 2,900 tokens) as one tracer slice.

</frozen-after-approval>

## Code Map

- `src/core/args.ts` -- `RUN_FLAGS` L13, `ArgvInput` L17, `buildRunArgs` L59, `build` L107. Add an optional `httpPort`: present → the two `http.*` flags; absent → keep `http.enabled=false`, so lint, blobl and test callers are unchanged. Update the header comments L6 and L12.
- `src/adapters/redpandaConnect/args.ts` -- `ArgsRequest` L60, `buildRunCommand` L71. Pass the port through.
- `src/adapters/vscode/run.ts` -- `Session` L195; `RunController` L226 with `sessions` keyed by `uri.toString()`; `phaseOf` L271; `start()` L370 (build hook, spawn L408, exit L415); `refreshUi` L494; `registerCommands` L251. Add the port to `Session`, a free port before `build`, `portOf(uri)`, an `onDidChangeRun` event, and the bind retry.
- `src/adapters/vscode/logsPanel.ts` -- the template only. `register` L449; `resolveWebviewView` L613 (`webviewHtml(…, 'logs', …)`); visibility start/stop L672; `show()` L705 via `${VIEW_ID}.focus`; test seams `posted[]` and `onDidChange`.
- `src/adapters/logs/logReader.ts` L49-62, L85, L147 and `src/test/helpers/fakeLogs.ts` -- the error-kind and fake pattern to mirror.
- `src/adapters/graphPanel/html.ts` -- reuse `webviewHtml` and the CSP.
- `src/shared/logsProtocol.ts` L846-1018 -- the pattern for message types and their parse validators.
- `webview/src/logs/*`, `esbuild.js` L106-156 -- the bundle pattern. Add a `metrics` context building `webview/src/metrics/main.tsx` → `dist/metrics.js`.
- `src/core/graph.ts` `buildPipelineModel` L101, `src/core/componentId.ts`, `PipelineNode` in `src/shared/protocol.ts` L23 -- the row order, nesting and node ids.
- `package.json` -- the panel container L734 and view L757 (copy as `redpandaConnectMetrics` / `redpandaConnect.pipelineMetrics`, title "Pipeline Metrics"); commands L105; `menus.commandPalette` L312.
- `src/extension.ts` -- `RunController` L259, `LogsPanel` L335, the `ExtensionApi` L363 (expose `metrics` in test mode as `logs` is).
- Tests that assert `http.enabled=false`: `src/test/core/args.test.ts` L17/22/33; `src/test/adapters/redpandaConnect/args.test.ts` L75–314; `bloblang.test.ts` L63; `process.test.ts` L153; `src/test/adapters/vscode/run.test.ts` L181/195/381; `src/test/integration/suites/60-run.ts` L70–184; `90-bloblang-panel.ts` L1229. Keep those whose callers pass no port; update the Run ones.
- `src/test/integration/suites/61-run-real.ts`, `test/corpus/fixtures/run_generate.yaml` -- the real-binary pattern (`.cache/redpanda-connect/<ver>/`, skipped locally when missing, failing in CI).
- `scripts/spike/blobl-probe.mjs` L111 `freePort()` -- prior art for the port helper.
- `README.md` L68 -- the Run sentence naming `http.enabled=false`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/args.ts` + adapter `args.ts` -- add the optional `httpPort` and its flags -- AD-25 R1.
- [x] `src/core/prometheus.ts` -- a pure Prometheus text parser: families and types from `#` lines (else from the name), samples with labels and escapes; ignore timestamps, comments and bad lines -- R3.
- [x] `src/core/metrics.ts` -- pure: `MetricsReading` → per-`path`+`label` raw counters and quantiles; `figures(prev, cur)` gives in/s, out/s, errors/s, p50, p99 (ns), with counter resets; `pathToNodeId` (AD-25 mapping); `metricRows(model, figures)` gives ordered rows with depth, kind, name and path, and unmatched series last -- R3, R4.
- [x] `src/adapters/metrics/source.ts` -- the `MetricsSource` interface and `MetricsReadError` kinds; `localMetricsSource(port, fetch)`: GET `http://127.0.0.1:<port>/metrics` with a 5 s timeout. ECONNREFUSED → `unreachable`; a 404 or no Connect series → `notServed`; parse via core. Add `freePort()` (listen on 0 at 127.0.0.1, read the port, close) -- AD-25.
- [x] `src/adapters/vscode/run.ts` -- port per session, `portOf`, `onDidChangeRun`, and the bind retry (stderr or exit text matching `address already in use` within the first output → one restart with a new port).
- [x] `src/shared/metricsProtocol.ts` -- host→webview `show` {source label, file, port, state, rows, interval} and webview→host `ready`/`sort`/`reveal?`, with validators -- AD-15.
- [x] `src/adapters/vscode/metricsPanel.ts` -- the `WebviewViewProvider`: bound to one file; follows `onDidChangeRun`; reads every 2 s while visible, one read in flight; detects a non-`prometheus` `metrics` section from the YAML (Decisions); posts rows.
- [x] `webview/src/metrics/{main.tsx,host.ts,MetricsView.tsx,metrics.css,MetricsView.test.tsx}` -- source line, table (Component with indent, Path, In/s, Out/s, Errors/s, P50, P99), click a header to sort (asc/desc, config order by default), state lines; ns formatted as µs/ms/s.
- [x] `package.json`, `esbuild.js`, `src/extension.ts` -- the container, view and command `redpandaConnect.showPipelineMetrics` ("Redpanda Connect: Show Pipeline Metrics", palette-gated on a detected config); the bundle; the wiring.
- [x] `src/test/helpers/fakeMetrics.ts` -- an in-memory `MetricsSource` that records calls and scripts readings and errors -- AD-25.
- [x] Unit tests: `src/test/core/prometheus.test.ts`, `metrics.test.ts` (rates, reset, first reading, mapping incl. nested and duplicate labels, ordering), `src/test/adapters/metrics/source.test.ts` (freePort binds 127.0.0.1, distinct ports, error kinds against a local http server), args and run tests updated -- matrix.
- [x] `src/test/integration/suites/98-metrics.ts` (fake source: command opens the tab, rows, hidden stops reads, run stop/rerun) and a real-binary case in `61-run-real.ts` (generate → 2 processors → drop: 4 rows with rates rising; two runs at once on different ports; the argv address is `127.0.0.1:<port>`).
- [x] `README.md` L68 -- describe the metrics port and the new tab.

**Acceptance Criteria:**
- Given a running config, when the user runs Show Pipeline Metrics, then the Pipeline Metrics tab opens next to Pipeline Logs, names "Local run · <file>" and its address, and shows its rows within one interval.
- Given the tab is open on a run, when the tab is hidden, then no read happens until it is shown again.
- Given the panel and the webview, then no figure is computed in the webview and no `vscode` import exists in `src/core`, `src/shared` or `src/adapters/metrics`.

## Design Notes

- Rates are per second over the time between the last two readings. Latency quantiles are shown as served (Connect's summary over its own window). p90, the mean, batches and the share are entry 6's.
- Input row: Out/s = `input_received`, In/s "—", latency "—" (AD-25: `input_latency_ns` is end-to-end; it is shown in entry 6). Output row: Out/s = `output_sent`, errors = `output_error`.
- The tab is bound to the file chosen when the command ran (active editor), not to whichever editor is active later.

## Verification

**Commands:**
- `npm run compile && npm run test:webview && npm run test:corpus` -- expected: all pass.
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` then `--label multiroot` -- expected: all pass, real-binary cases included.
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no matches.

**Manual checks:**
- In the dev host, run `run_generate.yaml`, then Show Pipeline Metrics: rows update every interval. `ss -ltnp | grep redpanda` shows 127.0.0.1 only.

## Review Triage Log

### Pass 1 (quick lens), 2026-11-18: high 0, medium 3, low 2, false 0, maybe-false 0

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `run.ts` `onOutput`: `ADDRESS_IN_USE` matches any "address already in use", not the metrics port's | medium | patch | Confirmed: the regex has no address in it, so a `socket_server`/`http_server` component failing to bind restarts the run, and the error message wrongly blames the metrics port. Connect's line names `127.0.0.1:<port>`. Patch: match `127.0.0.1:<port>` and "address already in use" together. |
| 2 | `run.ts`: with `logger.level` `none`/`fatal` the bind error is never printed, so no retry | low | reject | Real, but the logger has to be off and the port taken in the gap of milliseconds between pick and bind. Detecting it needs a new probe of the HTTP server (more than a direct fix). |
| 3 | `metricsPanel.ts` `failed()`: one `failures` counter for refused and `noSeries` reads | medium | patch | Confirmed: 2 refused + 3 `noSeries` reaches `NO_SERIES_READS` and marks a starting run "not served" for good; 4 `noSeries` + 1 refused jumps to `unreachable` without its log line. Patch: separate counters, each reset by the other kind and by a good read. |
| 4 | `metricsPanel.ts` hide: `prev` and rows kept while hidden; the first rate after showing spans the hidden time | medium | patch | Confirmed: the hidden branch only calls `pause()`, which leaves `prev` and `configRows`; closing the panel only hides the view. Patch: on hide, drop `prev` and the rows, so rates start again on show. |
| 5 | `extension.ts` `configFor`: the `metrics` type comes from the unsaved buffer, not the file the run started with | low | patch | Confirmed: `parsedDocument(doc)` reads the buffer; Run saves before it starts, so the disk text is what runs. Direct fix: take `metricsType` from the file on disk. |

All four patches applied by the implementer. Verified after them: `npm run compile`, `test:webview` 394, `test:corpus` 182, stable 1606 passing / 1 pending / 0 failing, multiroot 15 passing; no `vscode` import in `src/core`, `src/shared` or `src/adapters/metrics`.

## Manual Check

- 2026-11-18, the user, in the dev host (VS Code 1.143.1 from `.vscode-test`, workspace `.vscode-test/story-7-2/`): "tested, no issues".
- Noted during the check (not a defect of the plan): opening the Pipeline Metrics tab by clicking it, before Show Pipeline Metrics has run, shows only "Run a Redpanda Connect config, then use Show Pipeline Metrics on it."; the tab does not pick the active or running config by itself. Recorded in deferred-work.md for entry 9 (entry points). The user did not choose to change it in 7.2.
