# Spike 7.1 findings: the Cloud Prometheus endpoint on a real cluster

Probed 2026-11-18 with `scripts/spike/metrics-probe.sh` on `rpc-vilnius` (Dedicated, AWS, Connect 4.118.0). The probe used the user's service account (one Cloud token) and the Prometheus access in `~/.config/rpcn-spike/metrics.env` (the default user `prometheus`). It made one run (`captures/`: 52 step captures + summary.tsv + run.json; about 9 to 13 minutes are planned for a run). The run created the test pipeline `vscode-spike-metrics-<run>` (`generate` every 100 ms → `mapping` `fast` → `sleep` 5 ms `slow` → `mapping` `erratic` that fails every tenth message → `drop`, 0.1 CPU). It read the endpoint 40 times with the right password (06, 09, 10, 25 regular reads, 5 burst, 4 after the stop, 3 after the delete), then stopped and deleted the pipeline (`run.json`: `leftovers_this_run: []`, `errors: []`).

**Exit 1 was a false positive of the probe's leak self-scan.** The scan reported 56 hits of "other pipelines' label values" (`run.json` `leak_scan`). That scan collected the label values of *every* series that was not the probe's own, cluster series included. The coordinator checked the hits with one extra read-only GET (values compared in memory, never printed). All 7 matched values come from non-Connect cluster series (labels `area`, `redpanda_topic`, `group_id`, `redpanda_region`, `redpanda_domain`, `redpanda_namespace`). Each is a word that also occurs in a public metric family name the captures list, the public auth domain, the namespace `redpanda`, or the cluster's region in `03` (spike 6.1's committed captures keep the region too). No other pipeline's id or label value is in any capture.

The check's result, values not shown: 7 matched values, under the label keys `area`, `redpanda_topic`, `group_id`, `redpanda_region`, `redpanda_domain` and `redpanda_namespace`. All come from non-Connect cluster series, and none is a pipeline's. Where each appears: as words of public family names in the family lists of `06` and `09`, in the public token URL (`01`), and as the cluster's region in `03`.

The scan now collects values only from other pipelines' Connect series (those carrying `pipeline_id`): values of 3 or more characters, except quantile and `le` numbers, `root.` paths and words of the public family and label names. `run.json`'s `leak_scan` still shows the run's unclean result. The run also kept `created_by` (the creating account's id at a cluster host) in `07`, `08`, `41` and `42`. Those values are now `<redacted>` in the captures (rewritten offline) and in the probe. A dry-run case holds a cluster series whose label value is a word of a listed family name, and that value must not count as a hit. The cluster was not probed again.

Captures hold no password, token, service-account value, Prometheus or Data Plane host, cluster or organization id. A scan of this folder for the endpoint host and its long host labels, the password and its first characters, and the cluster ids and Data Plane hosts in the user's `rpk.yaml` found no match (values read in memory, never printed). Other pipelines appear only as counts. The test pipeline's series are kept, with its id as `<pipeline-id>` and the `instance` and `pod` values by form only.

**Not proven, open for the stories:**
- A pipeline with more than one instance (here one pod, one label set).
- A pipeline restart: the `pod` label should change and the counters reset; not observed.
- Resources (`processor_resources`, `cache_resources`) and nested processors: their `path` form in the Cloud. Another pipeline on the cluster has `cache_*` series, but only its counts were kept.
- Larger clusters: the body grows with the whole cluster's metrics.
- BYOC.
- How long the server's short cache lasts exactly.
- Whether a much shorter interval than 1 s is ever limited.
- A wrong *user* (only a wrong password was tried).
- Serverless (out of scope).

## Answers

### 1. Address

- The cluster's details (`GET /v1/clusters/{id}`, `03`) carry `prometheus: {url}`, a string of 108 characters, and no other field.
- `prometheus.url` equals `PROMETHEUS_URL` exactly: same scheme, host and path (`https://<prometheus-host>/api/cloud/prometheus/public_metrics`, 4 path segments, no query; `run.json` `prometheus`). The extension takes the address from the cluster's details and never asks for it.

### 2. Auth

- Basic auth with the user `prometheus` and the Cloud UI's password → 200 (`06`).
- No `Authorization` header → **401** with an empty body (`content-length: 0`) and the headers `connection, content-length, date, strict-transport-security, vary, www-authenticate`; `www-authenticate: Basic realm="Redpanda Cloud"` (the redaction masked the word after `Basic`) (`04`).
- A wrong password → the same **401**, the same headers, an empty body (`05`). The answer does not tell a missing password from a wrong one, and neither is retried.

### 3. Response

- `content-type: text/plain; version=0.0.4; charset=utf-8` (Prometheus text). When OpenMetrics is asked for, the same text format comes back: no `# EOF`, no OpenMetrics content type (`09`).
- `content-encoding: gzip` when asked for (`vary: Origin, Accept-Encoding`, chunked); without it the body is plain (`10`).
- Size: **about 1.54 MB uncompressed, about 84 KB gzip** (median 1,544,112 B decoded / 84,277 B on the wire, over the 40 reads with the password; one of them, `10`, uncompressed).
- Time: **median 374 ms** over the same 40 reads, at most 3.4 s (once, `44`; first byte at 3.3 s). The cached answers (`10`, `11`, `43`, `49`; 46–243 ms) pull the median down a little.
- Contents: about 9,400 series in 521 families (gauge 386, counter 97, untyped 24, histogram 9, summary 5) (`09`). This is the **whole cluster**: broker (`redpanda_*`), Kafka Connect (`jvm_*`, `kafka_connect_*`) and every pipeline. No sample carries a timestamp.
- The Connect families: counters `input_received`, `input_connection_up/failed/lost`, `processor_received/sent`, `processor_batch_received/sent`, `processor_error`, `output_sent`, `output_batch_sent`, `output_error`, `output_rejected`, `output_connection_up/failed/lost`; summaries `input_latency_ns`, `processor_latency_ns`, `output_latency_ns`; `cache_*` for cache resources (`09` `family_list`). The names are the same as a local run's (no prefix, no `_total`).

### 4. Labels

- **The pipeline id is the label `pipeline_id`**, its value exactly the Data Plane pipeline id (`11` onwards, `id_label`).
- **`path` and `label` are kept** on every component series, in the local form: `root.input`, `root.pipeline.processors.0` … `.2`, `root.output`. `label` is the component's label, or `""` when it has none (`11`).
- The other labels on a Connect series: `instance` (form `<ip>:9`, the pod's address and port) and `pod` (form `a-<pipeline-id>-9a9a9a-9a9a`, a Kubernetes pod name holding the pipeline id). Summaries add `quantile`. There is no `stream` label on Connect series.
- One pipeline has **one label set** besides the component labels (one pod) (`11`: `non_component_label_sets: 1`).
- A pipeline also exports one non-component gauge, `redpanda_cluster_features_enterprise_license_expiry_sec`, with `pipeline_id` but no `path`; the extension ignores it.
- The cluster had one other pipeline (82 Connect series); 9,354 series carry no `pipeline_id` (`11` `others`).

### 5. The test pipeline

- 52 series (`11`):
  - input: `input_received`, connection counters, `input_latency_ns`
  - each processor: `processor_received`, `processor_sent`, `processor_batch_received`, `processor_batch_sent`, `processor_error`, `processor_latency_ns`
  - output: `output_sent`, `output_batch_sent`, `output_error`, `output_rejected`, connection counters, `output_latency_ns`
- Each summary has `quantile` 0.5, 0.9 and 0.99 plus `_sum` and `_count`, in nanoseconds.
- **The `sleep` processor stands out**, as it did locally. Its p50 was 5.15 ms (p99 5.27 ms, mean 5.15 ms), against 4.7 µs for `fast`, 10.7 µs for `erratic` and 0.36 µs for the output (`43`, the last read with the series; `run.json` `latency_ns`).
- **`input_latency_ns` is the whole pipeline's time**, from read to acknowledgement: p50 5.21 ms, just above `slow`. Without that rule, the probe's own "slowest by p50" picked the input. The bottleneck mark (R6) compares processors and outputs, never the input's latency.
- `erratic` counted `processor_error` 4 of 47 at the first read (every tenth message). `processor_sent` still counts the failed messages (47), so the error share is `processor_error / processor_received`. Batches equal messages here (batch size 1).

### 6. Freshness

- Across the 25 reads 10 s apart, `input_received` moved on **every read** by about 100 (the 10 messages a second generated): 47, 155, 254 … 2454; it never went back (`run.json` `counter`). The values are current at each read, so the export updates far more often than every 10 s.
- The 5-read burst 1 s apart (`24`–`28`): all 200, no `Retry-After`, no limit, and every answer differed (the counter moved by 13 each time; 193–297 ms).
- Four reads came less than 0.5 s after the previous one and got its answer back unchanged: same size, same counter values (`10` after `09`, 243 ms, uncompressed this time; `11` after `10`, 49 ms; `43` after `40`, 74 ms; `49` after `46`, 46 ms). The server keeps a short cache, under about 1.3 s, and it serves it in either encoding. `run.json`'s `cached_reads` was corrected by hand from the captures, because the run's probe left `09` and `10` out of its read sequence.

### 7. Start and end

- The pipeline was Running 10.5 s after the create (`08`). Its series were in the first read after Running, `09` (counters already at 47), under 0.5 s after Running. That time is estimated (`09` took 415 ms, plus its parse); the run did not time it, and `11`'s 0.8 s is a cached copy of `09`. `run.json`'s `first_seen_after_running_ms` was corrected by hand to that estimate.
- After the stop (Stopped in 0.3 s): the read 0.4 s later was the cached body (`43`); the next one, 13.5 s after the stop, had **no series of the pipeline** (`44`).
- After the delete (gone in 0.3 s, `48`): none either (`49`–`51`). Series go within one read interval of the stop; no stale series linger.

### 8. Read interval

- **Cloud (entries 4 and 5): read every 10 s, one read in flight at a time, a 15 s request timeout.** Each read moves 84 KB gzip and takes about 0.4 s; at 10 s that is about 8 KB/s while the tab is open. The values are fresh at every read, and 1 s reads were not limited.
- Do not read more often than every 5 s: under about 1.3 s the answer is the cached one, and each read is the whole cluster.
- Always send `Accept-Encoding: gzip` (1.5 MB → 84 KB). Before parsing, keep the `#` lines (`# TYPE`, `# HELP`) and only the sample lines with `pipeline_id="<id>"`: 52 of about 9,400 series here. Or drop the `#` lines too and take each type from the family name (`_latency_ns` is a summary, the rest counters).
- A local run's `/metrics` serves only its own pipeline and is tiny, so entry 2 may read it more often (every 2 s, say). Rates come from the difference of two readings over the time between them; with no sample timestamps, that time is the reads' own.

## For the stories

- **2 tracer:** the parser reads Prometheus text 0.0.4 (escaped label values, exponents such as `5.163878e+06`, `+Inf`). Figures are keyed by `path` and `label`. The latency summaries are p50, p90 and p99 plus `_sum` / `_count`, in ns. The input's latency is end-to-end.
- **3 graph:** a series maps to a node by AD-7: a non-empty `label` gives `label:<label>`, else `path:` with Connect's path converted (`root.` dropped, `.N` → `[N]`). The mapping rule is AD-25's.
- **4 access:** the address is `prometheus.url` from the cluster's details. The user was `prometheus` on this cluster (unproven for others), so it is a stored value defaulting to `prometheus`, and the prompt asks for the password. The test read is one GET: 200 is accepted, 401 is refused. A refused password is a 401 with an empty body, the same as a missing one.
- **5 Cloud pipeline:** series filtered by `pipeline_id` equal to the pipeline's id. If several pods ever appear (several `pod` values), their counters are summed per component; unproven.
- **9 states:** "no series yet" covers the first seconds after Running and a stopped pipeline (series gone within one read). An unreachable endpoint is a network error, retried.
