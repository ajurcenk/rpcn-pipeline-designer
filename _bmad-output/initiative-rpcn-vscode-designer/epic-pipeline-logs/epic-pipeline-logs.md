---
type: epic
title: "Pipeline logs"
parent: initiative-rpcn-vscode-designer
covers: []
after: []
assignee: ""
risk: high
status: done
---

# Pipeline logs

## Description

A developer reads the log of a pipeline deployed to Redpanda Cloud (epic 5) without leaving VS Code: live, searched and filtered, and back through its history. The log is the cluster's `__redpanda.connect.logs` topic, read through the cluster's Kafka API with a Redpanda user (SASL) that may consume it; each record's key is the pipeline id and its value a JSON object (`benthos_version`, `instance_id`, `level`, `message`, `path`, `pipeline_id`, `time`, and further fields). The log shows in a **Pipeline Logs** tab in the bottom panel, next to Output. The spec lists debugging and Cloud work as non-goals; the user brought this into scope on 2026-11-05 (Notes), so this epic's requirements are its own lines below.

## Outcome

A developer whose Cloud pipeline misbehaves finds why from VS Code, the deploy's "Error, the cluster gave no reason" included, without the Cloud UI or a Kafka tool.

## Requirements

Source: the user's request and decisions of 2026-11-05 in this conversation, and the design boards (References); no parent capability (covers is empty, as for epic 5).

- E6 (R1) Log access: per cluster, a Redpanda user (username, password, SASL mechanism) kept in VS Code's secret storage, checked by a test read of the logs topic; the cluster's Kafka address comes from Redpanda Cloud; no password in a setting, a file, argv, a message or a log line.
- E6 (R2) Live log: a pipeline's records (those whose key is its id) in a Pipeline Logs tab in the bottom panel, newest at the bottom, following new records as they are written; time, level, message, instance; extra fields shown.
- E6 (R3) Entry points: the pipeline row in the Cloud view (inline and menu), a command for the active config's mapped pipeline (else a pick), and the notification of a deploy, an update or a start that ends in Error. The notification's Show logs opens the last 15 minutes (then live) with the ERROR records highlighted; the Error pipeline row's menu item "Show logs around the error" opens the 5 minutes before and after the pipeline's newest ERROR record, searched back up to 24 hours (none found: it says so and shows the last hour) (amended 2026-11-11, epic 6 retrospective AI-3).
- E6 (R4) Filter and search: levels (with counts), text or regular-expression search over the message and every field, filters by a field's value, a record's whole JSON (copy), records around one.
- E6 (R5) History: time ranges (last 15 minutes … 7 days, since the last deploy, a custom range), older records loaded on request, gaps shown, a records-per-time strip for the bounded ranges (about 30 to 60 bars, each slot from 1 minute to 1 day as the range needs, the slot size named; a bar's click shows its slot) (amended 2026-11-11, epic 6 retrospective AI-3); limited by the topic's retention.
- E6 (R6) States: no access set, sign-in refused, reading not allowed, no records, reading in progress (stoppable), connection lost (retried); each says what to do.
- E6 (R7) Export: the shown records as a file (JSON lines).

## Done when

1. With log access set for a cluster, Show logs on one of its pipelines shows that pipeline's records live in the Pipeline Logs tab, and only that pipeline's.
2. A deploy that ends in Error offers Show logs, which opens the pipeline's last 15 minutes with its ERROR records highlighted; on the Error pipeline's row, Show logs around the error opens the log around its newest ERROR record (searched back up to 24 hours) (amended 2026-11-11, epic 6 retrospective AI-3).
3. Searching, a level filter and a field filter narrow the shown records, and the last 7 days can be read back within the topic's retention.
4. A wrong password, a user without read access, and a lost connection each show their state with what to do; no password or secret value appears in a setting, a file, a message, a log line or the panel.
5. Integration tests pass in CI without a real cluster, and a manual check on the user's cluster passes.

## Boundaries

A new `logs` adapter (the Kafka client and the record reader) beside the `cloud` adapter, and a panel webview; the Cloud view and the deploy only gain entry points. Not this epic: metrics, logs of local runs (the terminal has them), writing to topics, other topics, logs of Serverless clusters, a consumer group or committed offsets.

- Touch point: the Cloud view's cluster and pipeline rows and the deploy's Error notifications (epic 5) — entry points only; owner: this epic.
- Touch point: the webview bundle and CSP of the graph and Bloblang panels (epics 3, 4) — reused for the panel; owner: this epic.

## References

- parent — _bmad-output/initiative-rpcn-vscode-designer/initiative-rpcn-vscode-designer.md
- design — https://claude.ai/artifact/XCmLson6MPFe2y9SzrfjVH (boards 1–6: set up log access, entry points, live log, search and filter, history, empty and error states)
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-23 (the Cloud API contract: the token and the cluster's details)
- constraint — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, section Constraints (theme only, no Redpanda branding, stable APIs, `^1.100.0`)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud.md (the Cloud view, the deploy and its secrets rules this epic follows)

## Notes

- Source conflict: spec Non-goals — "debugging" and "BYOC or Cloud deployment" vs the user's 2026-11-05 request for Cloud pipeline logs. Settled by the Decision below; the spec is not amended (offer `bmad-spec`).
- Decision (user, 2026-11-05): the log shows in the bottom panel, a Pipeline Logs tab next to Output.
- Decision (user, 2026-11-05): a new epic, built before epic 5's refactor sweep (5.9).
- Decision (user, 2026-11-05): Export (R7) and the records-per-hour strip (R5) are in this epic.
- Decision (user, 2026-11-05): the integration tests read the log through an interface with an in-memory fake (as the Cloud fake does for HTTP); the real Kafka client is covered by the spike and the manual checks, so CI needs no cluster or Docker.
- Decision (user, 2026-11-05): the epic opens with a spike on rpc-vilnius, with a Redpanda user the user creates that may read `__redpanda.connect.logs`, its password kept in a local file only the user reads (as the service account's in spike 5.1).
- Decision (user, 2026-11-05): the breakdown: 1 spike; 2 tracer (log access, Show logs on a row, the live panel); then the panel lane 3 history → 4 filter and search → 6 states, 7 the strip, 8 export; 5 entry points beside the panel lane; 9 refactor sweep.
- Decision (user, 2026-11-11): Done when 2 and R3 follow the build: the Error notification's Show logs opens the last 15 minutes with the ERROR records highlighted (not the log at the error's time); only the row menu's "Show logs around the error" opens the log around the newest ERROR record, searched back up to 24 hours (epic 6 retrospective AI-3, finding S1).
- Decision (user, 2026-11-11): R5's strip is the one built: about 30 to 60 bars sized from 1 minute to 1 day by the range (6.7's Decision of 2026-11-06), not one bar per hour (epic 6 retrospective AI-3, finding S2).
- Waits on epic 5 because: the cloud adapter, the Cloud view's rows, the `.cloud.json` mapping and the deploy's Error notifications are its entry points (5.2–5.5, done).
- Unknown: the cluster's Kafka address in the Control Plane's cluster (`kafka_api`, seen by name in spike 5.1's capture 07), TLS and the SASL mechanisms offered; the spike answers it.
- Unknown: the ACL a reader needs (Read on the topic; whether Describe or a group is needed without a consumer group), the topic's partitions and retention, and whether one pipeline's records share one partition (key-hashed), which decides how history is read; the spike answers it.
- Unknown: the Kafka client library (the extension's first runtime dependency): pure JavaScript, bundled by esbuild, maintained, with SASL/SCRAM, TLS and seeking by time; the spike chooses it.
