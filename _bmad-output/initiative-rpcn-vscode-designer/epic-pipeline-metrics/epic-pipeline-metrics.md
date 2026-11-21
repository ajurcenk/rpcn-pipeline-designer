---
type: epic
title: "Pipeline metrics"
parent: initiative-rpcn-vscode-designer
covers: []
after: []
assignee: ""
risk: high
status: done
---

# Pipeline metrics

## Description

A developer checks how a pipeline performs and finds the component that holds it back, without leaving VS Code, for a pipeline run locally (epic 2's Run) and for one deployed to Redpanda Cloud (epic 5). Redpanda Connect counts every input, processor and output: messages and batches received and sent, errors, and latency (a summary with p50, p90 and p99, in nanoseconds), each series labelled with the component's `label` and its config `path` (`root.input`, `root.pipeline.processors.0`, `root.output`). A local run serves them as Prometheus text at `/metrics` of its HTTP server; today every run passes `--set http.enabled=false` (`src/core/args.ts`), so none is served. In Redpanda Cloud the cluster's Prometheus endpoint (`prometheus.url` in the Control Plane's cluster details) exports every pipeline's series labelled by pipeline id, behind basic auth with the user `prometheus` and a password shown only in the Cloud UI. The figures show in a **Pipeline Metrics** tab in the bottom panel, next to Pipeline Logs, and on the nodes of the pipeline graph (epic 3), with the slowest component marked. The spec lists metrics as a non-goal; the user brought this into scope on 2026-11-18 (Notes), so this epic's requirements are its own lines below.

## Outcome

A developer whose pipeline is slow, locally or in the Cloud, sees which component takes the time or drops the messages, from VS Code, without Grafana, a Prometheus server or the Cloud UI.

## Requirements

Source: the user's request and decisions of 2026-11-18 in this conversation, and the research of the same day (References); no parent capability (covers is empty, as for epics 5 and 6).

- E7 (R1) Local source: each local run serves its metrics on 127.0.0.1 at a port the extension picks free for that run (`--set http.enabled=true`, `--set http.address=127.0.0.1:<port>`), so parallel runs keep working and nothing listens on another interface; the run's port is known to the extension while the run lives.
- E7 (R2) Cloud source: per cluster, the Prometheus password kept in VS Code's secret storage, checked by a test read of the cluster's Prometheus endpoint (its address from the cluster details); a pipeline's series are those labelled with its id; no password in a setting, a file, argv, a message or a log line.
- E7 (R3) The figures: from the Prometheus text, per component (its path and label), messages received and sent per second, batches, errors per second and as a share of received, and latency (p50, p90, p99 and the mean from `_sum`/`_count`); a counter that goes back (a restart) starts a new count, never a negative rate.
- E7 (R4) Pipeline Metrics tab: in the bottom panel next to Pipeline Logs, one row per component in config order (input, processors, output; resources and nested processors under their parent), sortable by each figure; read every few seconds while the tab is open and stopped when it closes; it names its source (the local run of a file, or a cluster's pipeline).
- E7 (R5) Graph figures: each node of the graph shows its rate, latency and errors while a source is live; the host maps a series' path and label to the node id (as AD-17 maps diagnostics), the webview only renders.
- E7 (R6) Bottleneck: the component with the largest share of the pipeline's time is marked as the slowest, in the tab and on the graph; components with errors are marked; a gap between the input's rate and the output's is named.
- E7 (R7) Live window: the last 1, 5 or 15 minutes of readings kept in memory while the tab is open, a trend line per component, nothing kept after it closes.
- E7 (R8) Entry points: a command for the active config (its local run when one is running, else its mapped Cloud pipeline, else a pick), the Run's status bar item or terminal, the pipeline row in the Cloud view (inline and menu), and the graph's toolbar.
- E7 (R9) States: not running, no metrics served (the config's own `metrics` or `http` section turns them off or moves them), no access set, password refused, no series yet for the pipeline, endpoint unreachable (retried); each says what to do.

## Done when

1. Running a config locally and opening Pipeline Metrics shows each input, processor and output with its rate, latency and errors, updated live; two configs run at once both show their own figures, and the run's server listens on 127.0.0.1 only.
2. In a config with a `sleep` processor, that processor is marked the slowest in the tab and on its graph node.
3. With metrics access set for a cluster, Show metrics on one of its pipelines shows that pipeline's components only, and the graph of its mapped file shows the Cloud figures.
4. The last 1, 5 and 15 minutes show trend lines, and restarting the run shows no negative rate.
5. No access, a wrong password, a stopped run and an unreachable endpoint each show their state with what to do; no password appears in a setting, a file, a message, a log line or the panel; integration tests pass in CI without a real cluster, and a manual check on the user's cluster passes.

## Boundaries

A new `metrics` adapter (the scrape of a local run and of the Cloud endpoint) and a pure `src/core` model (the Prometheus text parser and the figures), a panel webview, and figures on the graph; the run gains a port, the Cloud view and the graph only gain entry points and figures. Not this epic: tracing and the `redpanda` tracer, pprof and the debug endpoints, alerts, a stored history or an export, metrics of the cluster itself (brokers, topics), changing the deployed config, Serverless clusters.

- Touch point: the local Run's arguments and sessions (epic 2, `src/core/args.ts`, `src/adapters/vscode/run.ts`) — the port; owner: this epic.
- Touch point: the Cloud view's cluster and pipeline rows (epic 5) — the access and the entry points; owner: this epic.
- Touch point: the graph panel's protocol and nodes (epic 3, AD-17) — a figures message beside `nodeStatus`; owner: this epic.
- Touch point: the webview bundle and CSP of the Pipeline Logs panel (epic 6) — reused for the tab; owner: this epic.

## References

- parent — _bmad-output/initiative-rpcn-vscode-designer/initiative-rpcn-vscode-designer.md
- design — https://claude.ai/artifact/SvTxhp5NAdysThrmB7ZRY9 (boards 1–5: the Pipeline Metrics tab for a local run, the figures on the graph, Cloud metrics access and a Cloud pipeline, the empty and error states, the entry points; example figures are illustrative)
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-3, AD-9, AD-13, AD-15, AD-17, AD-23, AD-24 (the logs reader and its in-memory fake, which the metrics source follows), and Deferred ("metrics … will build on the RedpandaConnect adapter")
- constraint — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, section Constraints (theme only, no Redpanda branding, stable APIs, `^1.100.0`)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs.md (the per-cluster access in secret storage, the bottom-panel tab and its states, which this epic follows)
- research — https://docs.redpanda.com/connect/guides/monitoring/ (the `metrics` and `http` sections, `/metrics`)
- research — https://docs.redpanda.com/cloud-data-platform/develop/connect/configuration/monitor-connect/ and https://docs.redpanda.com/cloud-data-platform/manage/monitor-cloud/ (Connect metrics through the cluster's Prometheus endpoint, basic auth)
- research — https://docs.redpanda.com/cloud-data-platform/reference/public-metrics-reference.md (the Connect series exported by the Cloud)

## Notes

- Source conflict: spec Non-goals — "metrics" (and the architecture's Deferred list) vs the user's 2026-11-18 request for pipeline metrics. Settled by the Decision below; the spec is not amended (offer `bmad-spec`).
- Decision (user, 2026-11-18): a new epic for pipeline metrics from local runs and Cloud deployments, to check performance and find bottleneck components.
- Decision (user, 2026-11-18): the figures show on the graph's nodes and in a Pipeline Metrics tab in the bottom panel next to Pipeline Logs.
- Decision (user, 2026-11-18): the Cloud figures come from the cluster's Prometheus endpoint, with the password kept per cluster in secret storage; the deployed config is not changed.
- Decision (user, 2026-11-18): each local run serves its metrics on 127.0.0.1 at a free port the extension picks, on by default.
- Decision (user, 2026-11-18): live only: readings kept in memory while the tab is open (1, 5, 15 minutes), no stored history and no export.
- Decision: research verified on the pinned 4.100.0 and 4.112.0 binaries (2026-11-18): the series names are the same in both; `--set http.address=…` and `--set http.enabled=true` work on `redpanda-connect run` and `rpk connect run`; latency is a summary (p50, p90, p99, `_sum`, `_count`) in nanoseconds; a 5 ms `sleep` processor stood out (p50 5.17 ms) against a `mapping` (7.7 µs).
- Decision (user, 2026-11-18): the breakdown: 1 spike (proposes the metrics-source decision, AD-25); 2 the tracer (a local run's metrics in the tab, through the core model and the source interface); 3 the graph lane beside 4 the Cloud access; 5 joins them (a Cloud pipeline in the tab and on the graph); 6 → 7 → 8 → 9 one lane, since each touches the metrics panel host and webview; 10 the refactor sweep. After the tracer, the Cloud path (4, 5) is the least certain.
- Decision (user, 2026-11-18): Serverless clusters are out of this epic (BYOC and Dedicated only, as for the logs).
- Decision (user, 2026-11-18): design boards for the tab, the graph figures, the bottleneck mark and the states are drawn before entry 2, and the entries build to them (References, design).
- Waits on epics 2, 3, 5 and 6 because: the Run and its arguments (2), the graph and its status message (3), the cloud adapter, the Cloud view and the `.cloud.json` mapping (5), and the bottom-panel tab, the per-cluster secret access and the in-memory fake pattern (6), all done.
- Unknown: the Cloud series' pipeline-id label name, whether `path` and `label` survive the Cloud export, the endpoint's size and how often it may be read, and whether Serverless clusters serve it the same; the spike answers it.
- Open question: a config whose own `metrics` section is not `prometheus` (`none`, `json_api`, a `mapping` that drops `path`) or whose `http` section sets its own address: override it for the run, or show the "no metrics served" state; entry 2 decides it with the user.
