---
title: 'Metrics access for a cluster'
type: 'feature'
ticket: '4'
created: '2026-11-19'
status: 'built'
baseline_revision: 'ab11e3f182521d3069f76d03590eb7ff6c9338a6'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/spike-7-1-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A pipeline deployed to Redpanda Cloud exports its metrics only through the cluster's Prometheus endpoint, behind a password shown in the Cloud UI. The extension has no way to hold that password or to read that endpoint.

**Approach:** Copy epic 6's per-cluster log access for metrics, following AD-25's Cloud source:
- A cluster-row action asks for the Prometheus user and password.
- One test read of the endpoint (`prometheus.url` from the cluster details) checks them. Accepted credentials are kept in `context.secrets` and shown on the row; a clear action removes them.
- A Cloud `MetricsSource` (basic auth, gzip, the body filtered to one `pipeline_id`) is built behind 7.2's interface, ready for entry 5.
- An in-memory fake Cloud Prometheus endpoint is added for entries 5 and 8.

## Boundaries & Constraints

**Always:**
- AD-25's Cloud source rules:
  - Address: only from the cluster details, never asked; `https://` required when `endpoints.requireHttps`, as `dataplaneUrlOf` does.
  - Request: user default `prometheus`; `Accept-Encoding: gzip`; a 15 s timeout; one read in flight.
  - Answers: 200 accepted; 401/403 `refused`, not retried.
  - Filtering: sample lines whose `pipeline_id` is another pipeline's are dropped before parsing, and `#` lines are kept.
- Secrets: the password lives only in `context.secrets` under its own per-cluster key prefix. It is never in a setting, a file, argv, a message, a log line, a view item or the panel. Error text is masked with `maskCredentials`, and passwords join `CloudView.secrets()`.
- Copy `CloudLogs`' structure (a sibling class reached through `CloudContext`): the per-cluster lock, Escape at any step stores nothing, the `writing` counter, `store.onDidChange` on the prefix, `accountGone` clears it.
- The cluster row shows the access in its description and tooltip, through a contextValue suffix. Every existing cluster-row `when` still matches with `logs` and `metrics` in any combination.
- Theme only, no Redpanda branding. Build to design board 3 (the access part only).

**Never:**
- No Cloud figures in the tab or on the graph, and no pipeline-row "Show metrics" (entries 5 and 9).
- No change to the log access key format, its commands, `listClusters`' filtering, or the local metrics path (`localMetricsSource`, the port-keyed `FakeMetrics`).
- No Serverless handling: those rows never exist (`SUPPORTED_TYPES`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Accepted | right user + password; endpoint 200 | stored; row shows "· metrics"; info message names the cluster | — |
| Refused | wrong password → 401 (empty body) | nothing stored; message "refused: the user or password is wrong" (a missing and a wrong password look alike) | not retried |
| Unreachable | timeout / connection error / 5xx | nothing stored; message "Could not read the Prometheus endpoint of <cluster>: <reason>" | masked reason |
| No address | the cluster details have no `prometheus.url` (or not https while required) | action says the cluster serves no Prometheus endpoint; nothing asked | — |
| Escape | Escape at user or password step | nothing stored, no message | — |
| Clear | access set, clear action | secret deleted; row loses "· metrics"; info message | — |
| Other window | another window stores or clears | the row follows | — |
| Disconnect | account signed out | the metrics users map clears | — |
| Second request | action while one runs for the cluster | ignored | — |
| Filter | cluster body with 2 pipelines | the Cloud source's reading holds only the asked `pipeline_id`'s series; `#` lines kept | — |
| Gzip | fake answers gzip | read and parsed | — |
| No leak | after accepted and refused attempts | the password is found only in its secret key | — |

## Decisions

- Decision (user, 2026-11-19): the action asks in two steps, as log access does. First the user name, prefilled with `prometheus` (or the stored one); then the password.
- Decision (user, 2026-11-19): a test read that fails for another reason (timeout, connection error, 5xx) stores nothing. The message gives the masked reason, as log access does.
- Decision (user, 2026-11-19): the actions are "Set up metrics access…" and "Forget metrics access", matching the log access actions.
- Decision (user, 2026-11-19): keep the full plan (about 2,300 tokens) as one slice.

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudLogs.ts` -- the template: `CloudLogs` L54, constants L27-46 (`LOG_ACCESS_PREFIX`, `logAccessKey`, messages), lock L229-245, `setUpLogAccessNow` L247-333 (inputs, progress, refused vs failed, store, `kept` passwords), `passwords()`.
- `src/adapters/vscode/cloudView.ts`:
  - `new CloudLogs(context)` L582; prefix `onDidChange` L600-609; commands L690/692; `secrets()` L719-721; `accountGone` L726-730.
  - `UNREACHABLE_ENDPOINTS` L213-218; `dataplaneUrlOf` L972-977; `readLogAccess` L1003.
  - Cluster row L1216-1233 (description, contextValue, tooltip); pipeline rows L1248; delegates L1344-1376; `LogAccessResult` L487-493.
- `src/adapters/cloud/controlPlane.ts` -- `CloudCluster` L52-68: add `prometheusUrl?`, read in `listClusters` L114-130 as `seedBrokers` is.
- `src/adapters/cloud/errors.ts` -- `maskCredentials`.
- `src/adapters/metrics/source.ts` -- `FetchResponse` L59-63, `MetricsFetch` L65, `readingOf` L98-120, `networkText`. Share them with the new `cloudMetricsSource(url, user, password, pipelineId, fetch)`. Node's fetch un-gzips by itself.
- `package.json` -- the log commands L293-302; palette L448-452; cluster-row menus L624, L634, L693-700 (regexes `cloudCluster( logs)?`: widen them for ` metrics`).
- `src/extension.ts` L115-118 -- the test-mode `cloud` Pick; add the metrics delegates.
- Tests:
  - `src/test/helpers/fakeCloud.ts` -- server L220, `url` L174, `FakeCluster` L70-96, the cluster details L285-302: add `prometheus.url` and a fake Prometheus route (basic auth, gzip, a scripted body of several pipelines; 401 with an empty body).
  - `src/test/integration/suites/97-logs.ts` -- the setup pattern L182-245 and `NO_LEAK` L3071.
  - `96-cloud.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/cloud/controlPlane.ts` -- `prometheusUrl` on `CloudCluster`.
- [x] `src/adapters/metrics/source.ts` -- `cloudMetricsSource` and the `pipeline_id` line filter (pure helper in `src/core/prometheus.ts` or `metrics.ts`); the shared answer handling.
- [x] `src/adapters/vscode/cloudMetrics.ts` -- `CloudMetricsAccess`, from `CloudLogs`: key prefix `redpandaConnect.cloud.metrics.` + cluster id holding {username, password}; the set-up, forget and stored-access logic; the test read through the Cloud source.
- [x] `src/adapters/vscode/cloudView.ts` -- wire it; row description and tooltip, contextValue suffix; `secrets()`; `onDidChange`; `accountGone`; delegates.
- [x] `package.json` -- the two commands (`$(key)`/`$(trash)`, palette as logs), cluster-row menus, widened regexes.
- [x] `src/extension.ts` -- the test seam.
- [x] `src/test/helpers/fakeCloud.ts` -- the fake Prometheus endpoint.
- [x] Tests: unit tests for the filter and the Cloud source (auth header, gzip, 401, timeout, filter, `#` lines); integration suite `99-metrics-access.ts` covering the matrix, with a `NO_LEAK` test as 97-logs'.
- [x] `README.md` -- the Pipeline metrics paragraph: metrics access per cluster.

**Acceptance Criteria:**
- Given a cluster with metrics access set, when VS Code restarts, then its row still shows "· metrics" and no prompt appears.
- Given log and metrics access both set, then the row shows both and every cluster-row action still appears.

## Verification

**Commands:**
- `npm run compile && npm run test:webview && npm run test:corpus` -- expected: all pass.
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable`, then `--label multiroot` -- expected: all pass.
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no matches.

**Manual checks:**
- Signed in to the Cloud view in the dev host, set up metrics access on the user's cluster with the Cloud UI's password: the row shows "· metrics". A wrong password is refused. Forget removes it.

## Review Triage Log

### Pass 1 (quick lens), 2026-11-19: high 0, medium 1, low 4, false 0, maybe-false 0

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `source.ts` `cloudMetricsSource().read`: a shared in-flight read is cancelled by the first caller's abort for every caller; later callers' signals are ignored | medium | patch | Confirmed: `if (inFlight) return inFlight` ignores the caller's signal, and only the first signal is wired into `cloudGet`. Entry 5 gives this source to the tab and the graph feed. Patch: the shared read is bound to no caller's signal (its own timeout only); each caller's signal rejects only its own wait; a unit test with two callers, one aborting. |
| 2 | `source.ts` `cloudGet` (and `localMetricsSource`): a signal already aborted is ignored | low | patch | Confirmed: `addEventListener('abort')` does not fire for a signal aborted before the call. Direct fix: abort at once when `signal.aborted`. |
| 3 | `cloudView.ts` cluster row: board 3's "· no metrics access" on a row without access is not built | low | patch | Confirmed: the description adds nothing without access; the plan says to build to board 3's access part. Direct fix: the description and tooltip say "no metrics access" when the cluster serves a Prometheus endpoint and no access is set. |
| 4 | `cloudMetrics.ts` masking: stored metrics passwords of 1–3 characters are not masked outside the attempt | low | patch | Confirmed: `CloudLogs` masks its kept passwords at any length (`maskCredentials(…, 1)`); the metrics passwords only reach `CloudView.mask` with the default minimum of 4. Direct fix: mask them as `CloudLogs` does. |
| 5 | The "VS Code restarts" acceptance criterion is tested by a reconnect only | low | reject | The restart path ends in the same `loadClusters` → `readAccess` the reconnect test covers; a real restart test needs a second `CloudView` (more than a direct fix). The manual check restarts the dev host. |

All four patches applied by the implementer. Verified after them: `npm run compile`, `test:webview` 401, `test:corpus` 182, stable 1640 passing / 1 pending / 0 failing, multiroot 15 passing; no `vscode` import in `src/core`, `src/shared` or `src/adapters/metrics`.
