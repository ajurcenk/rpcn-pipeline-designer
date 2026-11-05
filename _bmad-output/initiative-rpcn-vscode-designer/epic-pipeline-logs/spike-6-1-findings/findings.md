# Spike 6.1 findings: reading the pipeline logs topic on a real cluster

Probed 2026-11-05 with `scripts/spike/logs-probe.sh` on `rpc-vilnius` (Dedicated, AWS), with the user's service account (one Cloud token per run) and a Redpanda user the user created with Read on `__redpanda.connect.logs` (SCRAM-SHA-256). Two runs: run 1 (`captures-run-1/`) found two probe bugs (a seek checked the record before the log's first offset; the two clients read live one after the other while the test pipeline wrote in one burst); run 2 (`captures/`), after the fixes, completed every step and is the evidence. Each run created a test pipeline `vscode-spike-logs-<run>` (`generate` every second → `log` at INFO and WARN → `drop`, 0.1 CPU) and deleted it (`run.json`: `leftovers_this_run: []`).

Captures hold no password, token, service-account value, broker or Data Plane host, cluster or organization id (checked by a scan of every capture and the run log for each value); records of other pipelines are shapes and counts only; the test pipeline's records are kept with ids replaced.

**Not proven, open for the stories:** a topic with more than one partition (this cluster's has one, so key placement was trivially one partition); a BYOC cluster; a user with less than the grant used here (DescribeConfigs succeeded, so the user's grant may be wider than Read alone; check the ACL in the Cloud UI); high log volume (54 records in the 24 h before the run, cluster-wide); kafkajs or @platformatic/kafka on Windows and macOS.

## Answers

### 1. Address and TLS

- `GET https://api.redpanda.com/v1/clusters/{id}` → `cluster.kafka_api.seed_brokers`: one seed broker on port 9092 (`03`); `kafka_api` also reports `sasl.enabled: true` and `mtls.enabled: false`. The cluster has 3 brokers (metadata, `11`).
- TLS is required: TLS 1.3, a Let's Encrypt certificate the system CAs trust (`05`); the broker closes a plaintext connection.

### 2. SASL

- The broker offers SCRAM-SHA-256 and SCRAM-SHA-512 (`05`). The user signs in with the mechanism they were created with; the other one is refused (`09`).
- A wrong password: kafkajs `KafkaJSSASLAuthenticationError` "SASL authentication failed: security: Invalid credentials", not retriable (`08`); @platformatic/kafka an `AggregateError` "Cannot connect to any broker." whose nested cause is `SASL_AUTHENTICATION_FAILED` (Kafka error 58) (`21`): the extension must unwrap it to tell a refused sign-in from a network failure.

### 3. What the grant allows

- Sign-in, topic metadata, the list of all topics (24, `12`), DescribeConfigs on the topic (`13`), ListOffsets by time, and Fetch, all without a consumer group: no group was joined and no offset committed.

### 4. The topic

- `__redpanda.connect.logs`: **one partition**; `cleanup.policy: delete`, `retention.ms` 604800000 (**7 days**), `retention.local.target.ms` 21600000 (**6 hours on the brokers**, the rest in tiered storage: `redpanda.remote.read/write: true`), `message.timestamp.type: CreateTime` (`13`).
- 203 records kept at run 1 (offsets 4489–4692), 54 in the 24 h before it: low volume, cluster-wide.
- Records are **Snappy**-compressed (`18`). The key is the pipeline id; the value is JSON with `benthos_version`, `instance_id`, `level`, `message`, `path`, `pipeline_id`, `time`, and per record `label`, `custom_source`, the `log` processor's fields (`probe_n` here), and **license fields** (`license_org`, `license_type`, `expires_at`) (`34`, `39`).

### 5. Placement

- With one partition every key is on partition 0, which is also its murmur2 (default partitioner) partition (`34`, `39`). Whether a multi-partition logs topic places a pipeline's records by key is not proven.

### 6. Seeking by time

- ListOffsets with a timestamp returns the first offset at or after it, with both clients (`35`–`38`, `40`–`43`): now − 15 min → 4692, now − 24 h → 4638, now − 7 d and before the oldest → 4489 (the log's first offset). In each case the record at that offset is at or after the time and the one before it (when there is one) is older.
- Reading forward from 4489 (Nov 2, three days back, past the 6 h local retention) returns records from **tiered storage** transparently, with both clients. A fetch below the log's first offset fails with `OFFSET_OUT_OF_RANGE` (run 1): history must start at the log's first offset at the earliest.

### 7. Live

- Fetching from the end with a 2 s wait returns each new record of the test pipeline: 38 of 38 with both clients, the first after about 70 ms; from the record's timestamp to its arrival: median 38 ms, at most 133 ms (`32`, `33`).
- In run 1 the test pipeline went to `STATE_ERROR` after 57 s with no reason (the spike 5.1 behaviour), after writing its records once; in run 2 it ran.

### 8. The clients

| | kafkajs 2.2.4 | @platformatic/kafka 2.15.0 |
|---|---|---|
| Last release | 2023-02-27 | 2026-11-04 |
| License, dependencies | MIT, none | Apache-2.0, 9 (`ajv`, `avsc`, `fastq`, …); optional `@node-rs/crc32` (native), `protobufjs` |
| Snappy (this topic's records) | not decoded ("Snappy compression not implemented"); decoded with codecs borrowed from @platformatic/kafka (`18`, `19`) | decoded |
| Reading without a consumer group | only through internals (`Kafka[private:createCluster]`, `Broker.fetch`) | its own Consumer and Admin API |
| Offsets by time, DescribeConfigs | yes (public admin API for offsets by time too, `20`) | yes |
| esbuild bundle, as the extension bundles today (CommonJS) | loads: 270 KB minified, 71 KB gzip | does not load (`import.meta.url` is undefined); loads with `import.meta.url` defined from `__filename` and its `native.wasm` copied beside the bundle: 719 KB minified, 171 KB gzip (`07`) |
| Native modules | none | `@node-rs/crc32` loaded when installed (an optional dependency) |

## For the stories

- **6.2 tracer:** the address from `kafka_api.seed_brokers`; TLS on with the system CAs; SCRAM with the user's mechanism (offer both in the prompt); the test read is metadata of the topic plus one fetch. Read without a consumer group: partitions from metadata, the pipeline's partition (murmur2 of its id, or every partition when unsure), keep records whose key is the pipeline id. Live: fetch from the end with a 2 s wait. Decode Snappy.
- **The client:** @platformatic/kafka (maintained, decodes Snappy, a public API for groupless reads), bundled with the `import.meta.url` shim and its `.wasm` beside the bundle; leave out the optional native `@node-rs/crc32` (and check its fallback) so the `.vsix` has no native module. kafkajs is the fallback only with borrowed codecs and internal APIs.
- **6.3 history:** ListOffsets by time, then read forward; the earliest start is the log's first offset; records older than 6 h come from tiered storage (first fetch slower: measure in 6.3); retention 7 days here (read `retention.ms` when DescribeConfigs is allowed; else say "within the topic's retention").
- **6.6 states:** a refused sign-in is `SASL_AUTHENTICATION_FAILED` inside @platformatic/kafka's aggregate error; a plaintext or closed port is a network error.
- **All:** the records carry `license_org`, `license_type`, `expires_at`: the panel does not show `license_org` (ticket 38's rule) and masks secret values in messages, as every Cloud message is.
