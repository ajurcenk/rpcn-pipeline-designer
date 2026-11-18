---
title: 'Probe the Cloud Prometheus endpoint on a real cluster'
type: 'chore'
ticket: '1'
created: '2026-11-18'
status: done
baseline_revision: 'ea09368fd872bd4170bf4c58c21f2f18ad3d8505'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/spike-probe-reading-the-logs-topic-on-a-real-cluster-plan.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/spike-6-1-findings/findings.md
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - scripts/spike/logs-probe.mjs
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 7 reads a Cloud pipeline's metrics from the cluster's Prometheus endpoint, but only the docs say what it serves: nobody has checked the pipeline-id label's name, whether each series keeps its component's `path` and `label`, the latency's form, how fresh the values are, how big and slow a read is, how often it may be read, or how a refused password answers. Entries 4 and 5 and the graph figures (R5, R6) depend on those answers.

**Approach:** A repeatable probe script, like spike 6.1's, run against `rpc-vilnius` with the user's service account and the Prometheus credentials in `~/.config/rpcn-spike/metrics.env`. It runs a test pipeline with known components and reads the endpoint over several minutes, recording the requests and answers (credentials, hosts, ids and other pipelines' series redacted) as captures. A findings file answers the questions, and a proposed AD-25 in the architecture spine fixes how the extension reads metrics (local and Cloud, behind one source interface with an in-memory fake), for the user to approve.

## Boundaries & Constraints

**Always:**
- Credentials only from local files the user owns with mode 0600 (the probe refuses otherwise): `credentials.env` (5.1) and `metrics.env`; never printed, logged, written, put in argv or in a capture. One Cloud token per run.
- `metrics.env` keys are the user's: `PROMETHEUS_USER`, `PROMETHEUS_PWD`, `PROMETHEUS_URL` (read case-insensitively, as `readEnvFile` does).
- Reads only on the Prometheus endpoint (GET); the only Cloud writes are the test pipeline's create, start/stop and delete.
- Captures: no password, token, endpoint or Data Plane host, cluster or organization id; series of pipelines the probe did not create appear by shape only (metric names, label names, counts); the test pipeline's series are kept with ids replaced by placeholders.
- No extension code, `package.json` or `package-lock.json` changes.

**Never:**
- Credentials, tokens, hosts or other pipelines' label values in the repository, the conversation or a capture.
- Serverless clusters (epic Decision, 2026-11-18).

**Decisions (user, 2026-11-18):**
- `metrics.env` must be mode 0600 like the other files; the probe refuses it otherwise, and the user runs `chmod 600 ~/.config/rpcn-spike/metrics.env` before the run.
- The probe creates a test pipeline `vscode-spike-metrics-<run>` (`generate` every 100 ms → `mapping` labelled `fast` → `sleep` 5 ms labelled `slow` → a `mapping` labelled `erratic` that fails every tenth message → `drop`, 0.1 CPU) with the service account, and deletes it at the end, also when a step fails.
- The run takes about 8 minutes: up to 5 to start, reads every 10 s for 4 minutes with one 5-read burst 1 s apart, then reads for up to 3 minutes after the delete.
- The probe is run against `rpc-vilnius` only after the user says so.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | valid files, test pipeline running | captures of each read; findings answer 1–8 | none |
| Refused password | the right user with a changed password (in memory only) | the endpoint's status and body shape recorded | not retried |
| No auth | no Authorization header | status and body shape recorded | none |
| File refused | `metrics.env` or `credentials.env` not 0600, a symlink, missing keys | the probe exits before any request, naming the file and the fix | exit non-zero |
| Step fails mid-run | network error, pipeline never Running | the error captured, the test pipeline deleted in `finally` | `run.json` lists leftovers (none expected) |

</frozen-after-approval>

## Code Map

- `scripts/spike/logs-probe.mjs` -- copy (do not import or change) `readEnvFile` (owner, mode, symlink checks), `readCloudCredentials`, `Redactor`, `shape`, `errInfo`, the token request, the Control Plane cluster GET and the Data Plane pipeline create/wait/delete with `finally` cleanup, `writeCaptures`, `makeFake`, `scanDir` and the `--dry-run` structure.
- New `scripts/spike/metrics-probe.mjs` + `metrics-probe.sh` -- the probe; `--dry-run` runs the whole flow against a fake Cloud and a fake Prometheus endpoint, checking refusals, redaction and cleanup.
- New `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/spike-7-1-findings/` -- `findings.md` and `captures/NN-<step>.json`, `summary.tsv`, `run.json`.
- `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` -- a proposed AD-25 "Reading pipeline metrics" after AD-24, marked [PROPOSED].
- `src/core/args.ts:13` (`RUN_FLAGS`), `src/core/componentId.ts`, `src/adapters/cloud/controlPlane.ts:53-67`, `src/adapters/cloud/dataPlane.ts` -- read only, for AD-25's wording (the local port, the node ids a series must map to, the cluster fields read today).

## Questions the probe answers

1. **Address**: the Control Plane cluster's `prometheus` object (fields by name), and whether `prometheus.url` equals `PROMETHEUS_URL` (compared, never recorded).
2. **Auth**: basic auth with the file's user; no header; a wrong password: status, headers by name, body shape.
3. **Response**: status, content type (Prometheus text or OpenMetrics), compression, size, time, series and metric-family counts; the Connect families present and their types (counter, summary, gauge).
4. **Labels**: the label names on Connect series; which carries the pipeline id; whether `path` and `label` are kept and their form (`root.pipeline.processors.0`); any instance or stream label; how many label sets one pipeline has.
5. **The test pipeline**: its series per component (input, each processor, output), whether summaries carry p50/p90/p99 and `_sum`/`_count`, and whether the `sleep` processor's latency stands out, as it did locally.
6. **Freshness**: across reads 10 s apart, how often counters move (the export's update interval); across 5 reads 1 s apart, whether answers are cached or limited (429, `Retry-After`).
7. **Start and end**: how long after Running the series appear, and how long after the pipeline is stopped and deleted they go.
8. **Read interval**: the interval entries 4 and 5 should use, from 3, 6 and 7.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/spike/metrics-probe.mjs`, `metrics-probe.sh` -- the probe and its dry run.
- [x] Run it against `rpc-vilnius` (the user present); keep the captures.
- [x] `spike-7-1-findings/findings.md` -- answers 1–8 with the captures they rest on; what was not proven.
- [x] Proposed AD-25 in the architecture spine.

**Acceptance Criteria:**
- Given the probe's run, when the captures are read, then the test pipeline's series were found by its id with their labels, read at least 20 times over the run, and no capture holds a credential, a host, an id or another pipeline's label values.
- Given the findings and AD-25, when the user reads them, then they approve or amend AD-25.

## Implementation Notes

- The probe is written and checked offline only; the run against `rpc-vilnius` waits for the user's go-ahead (Decision), and the findings and AD-25 are written from its captures. `~/.config/rpcn-spike/metrics.env` is already mode 0600 (checked by `ls`, not read).
- `--dry-run` (241 checks): both files' refusals (0644 and 0640 with the `chmod 600` fix named, a symlink, a missing file, each missing key, an http URL, a URL with a user; keys read case-insensitively; `loadInputs` refuses before any request); redaction samples (Basic headers included); the Prometheus text parser (escapes, commas in values, exponents, timestamps, `+Inf`, `# EOF`, families); and seven flows on a fake Cloud plus a fake Prometheus endpoint on 127.0.0.1 (served under a cluster-like host name through a custom DNS lookup, basic auth, gzip, OpenMetrics): normal, burst refused with 429 + `Retry-After`, a cluster `prometheus.url` that differs from the file's, a failure mid-read, a lost create reply, a pipeline that never runs, an unreachable endpoint. Each is checked for leaked values (credentials, the Basic header, the password's first characters, hosts, ids, the run tag, other pipelines' label values, a topic name, 127.0.0.1) and leftovers.
- The probe reads Prometheus with `node:http(s)` (not `fetch`) so the compressed size and the content encoding are seen. Reads on the real run: 3 auth reads, 2 variants (OpenMetrics, identity), 25 every 10 s + a 5-read burst after the 13th, then after the stop (up to 1 minute) and after the delete (up to 3 minutes); the stop and the delete phases end early after 3 reads without the series. Expect 9 to 13 minutes, depending on the start.
- Not in the plan, added: the probe scans its own output for every secret value and for other pipelines' label values (in memory only) and records the result by name in `run.json` (`leak_scan`); a hit makes it exit non-zero. The test pipeline's input and output are unlabelled (the plan names labels for the processors only), so their `label` is seen as empty.
- Run 1 (2026-11-18, user approved, `captures/`): every step passed (`errors: []`), 40 reads with the password, the test pipeline's series in 33, nothing left on the cluster. The probe exited 1 only through its leak self-scan ("other pipelines' label values", 56 hits). One extra read-only GET (values compared in memory, never printed) showed all 7 matched values were labels of non-Connect cluster series (`area`, `redpanda_topic`, `group_id`, `redpanda_region`, `redpanda_domain`, `redpanda_namespace`). Each also occurs in public family names, the public auth domain, the namespace `redpanda` or the cluster's region in `03`, so all were false positives. Fixed: the scan collects values only from other pipelines' Connect series (with `pipeline_id`); a dry-run cluster series whose label value is a word of a listed family name (and a region) must not count. Not re-run against the cluster. The dry run now has 242 checks.
- Review fixes (2026-11-18): `created_by` / `updated_by` redacted in the probe (a dry-run check with a fake creator) and rewritten to `<redacted>` in captures 07, 08, 41 and 42 offline. The auth read (06) and the variants (09, 10) are now in the probe's read sequence, so first-seen and cached reads include them. `run.json`'s answers were corrected by hand from the captures (`corrected_offline`): 40 reads, 33 with the series, cached 10, 11, 43, 49, first seen at 09. The self-scan checks other pipelines' Connect label values of 3+ characters (not quantile/le numbers, `root.` paths or public family/label words). A dry-run check keeps the `realm=` of `www-authenticate`. Findings, AD-25 and the counts were corrected; the dry run has 257 checks.
- Also fixed after the run: the redaction of `Basic <base64>` caught `Basic realm="…"` in `www-authenticate` (capture `04`/`05` show `Basic <redacted>"Redpanda Cloud"`; the findings name the realm).
- Findings: `pipeline_id` picks a pipeline; `path` and `label` survive as locally; latency summaries p50/p90/p99 + `_sum`/`_count` in ns; values fresh at every read (a server cache of about a second); about 1.54 MB (84 KB gzip) and 0.4 s per read, the whole cluster's series; 10 s proposed for the Cloud. `input_latency_ns` is end-to-end, so AD-25 leaves it out of the bottleneck.
- AD-25 [PROPOSED] is in the architecture spine after AD-24, waiting for the user's approval.

## Plan Change Log

## Review Triage Log

### Pass 1 (quick lens, 2026-11-18): high 1, medium 6, low 5, false 0, maybe-false 0

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `created_by` keeps the creating account's id (`<id>@<cluster-host>`) in captures 07, 08, 41, 42 | high | patch | Confirmed in all four files; `created_by` matches neither `SECRET_KEY` nor `OTHER_ID_KEY`. Patch: redact `created_by`/`updated_by` in the probe and rewrite the four captures. The same value is in four committed spike 5.1/6.1 capture files: pre-existing, deferred and reported to the user. |
| 2 | read-01 was the server's cached copy of 09/10, so "first seen 0.8 s after Running" and the cached-read list are wrong | medium | patch | Confirmed: 09, 10 and 11 all 1544112 bytes, 11 in 49 ms. Patch: `summarise` counts the variant reads; findings §6 and §7 corrected. |
| 3 | "37 reads with the right password" should be 40 | low | patch | Follows from row 2 (06, 09, 10 left out). Corrected in findings. |
| 4 | AD-25 sums pods per path + label, but quantiles cannot be summed | medium | patch | AD-25 wording: counters and `_sum`/`_count` are summed; quantiles are taken per pod and the worst shown. |
| 5 | AD-25 maps a duplicate label to the first node, against AD-7 | medium | patch | `componentId` gives a later duplicate its `path:` id; AD-25 to map by label only when unique, else by path. |
| 6 | The `pipeline_id` line pre-filter drops `# TYPE` lines | medium | patch | AD-25 and findings §8: keep `#` lines, or type from the family. |
| 7 | "the user is always `prometheus`" is untested | low | patch | Marked unproven; the user name stays a value with default `prometheus`. |
| 8 | AD-25's free port can be taken between close and the child's bind | medium | patch | AD-25: a failed bind (the run exits with the address in use) retries once with a new port, then shows the error. |
| 9 | The `realm=` redaction fix has no dry-run check | low | patch | Add the check on the fake's `prom-auth-none` capture. |
| 10 | Committed `run.json` shows the self-scan unclean with nothing committed to show why | medium | patch | Findings record the check's result: 7 values, their label keys, all from non-Connect cluster series, none a pipeline's; values not shown. |
| 11 | The narrowed self-scan skips other pipelines' values under 8 characters | low | patch | Direct change: check Connect label values of 3 or more characters. |
| 12 | Capture count and run length differ between findings, plan and launcher | low | patch | Wording aligned: 52 step captures + `summary.tsv` + `run.json`; 9 to 13 minutes. |

## Verification

**Commands:**
- `bash scripts/spike/metrics-probe.sh --dry-run` -- every refusal, redaction and cleanup check passes.
- a scan of the findings folder for the endpoint host, the Data Plane host, the cluster id and the password's first characters -- no match.

**Manual checks:**
- The user runs (or watches) the probe against `rpc-vilnius` and reads the findings and AD-25.

- 2026-11-18: run 1 done with the user's approval (see Implementation Notes); `--dry-run` passes 257 checks after the self-scan and review fixes; the scan of `spike-7-1-findings/` (52 step captures + summary.tsv + run.json, and `findings.md`) for the endpoint host and its long host labels, the password and its first 6 characters, and the cluster ids and Data Plane hosts in `~/.config/rpk/rpk.yaml` (read in memory, never printed) found no match. Awaiting: the user's approval or amendment of AD-25.


**Result (user, 2026-11-18):** findings accepted and AD-25 adopted when the user said "AD-25 approved and mark 7.1 done".
