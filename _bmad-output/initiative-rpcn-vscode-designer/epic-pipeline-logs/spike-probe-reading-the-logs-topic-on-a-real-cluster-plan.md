---
title: 'Probe reading the logs topic on a real cluster'
type: 'chore'
ticket: '1'
created: '2026-11-05'
status: 'done'
baseline_revision: '735d93f622c84c9c721ded1b83de28152c181ff7'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-probe-the-redpanda-cloud-apis-on-a-real-cluster-plan.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-5-1-findings/findings.md
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - scripts/spike/cloud-probe.mjs
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 6 reads a Cloud pipeline's log from the cluster's `__redpanda.connect.logs` topic through its Kafka API, but nothing is known yet about how: where the Kafka address comes from, the TLS and SASL it takes, the ACL a reader needs without a consumer group, the topic's partitions and retention, whether one pipeline's records share one partition, how to seek by time, and which Kafka client the extension can bundle. Building the tracer on guesses means rework in every story.

**Approach:** A repeatable probe script, like spike 5.1's, run against `rpc-vilnius` with the user's service account (for the cluster's details) and a Redpanda user the user creates for reading the logs topic. It answers each question by doing it, with each candidate client, and records the requests and answers (credentials, hosts and other tenants' data redacted) as captures. A findings file answers the questions, and a proposed AD-24 in the architecture spine fixes how the extension reads the log, for the user to approve.

## Boundaries & Constraints

**Always:**
- Credentials only from local files the user owns with mode 0600 (the probe refuses otherwise): the service account's `~/.config/rpcn-spike/credentials.env` (5.1) and the Redpanda user's file; never printed, logged, written, put in argv or in a capture. One Cloud token per run.
- Read only on Kafka: no consumer group joined, no offset committed, nothing produced, no topic or ACL changed.
- Captures: no password, token, broker host, cluster or organization id; records of pipelines the probe did not create appear by shape only (field names, counts, sizes); records of the probe's own pipeline are kept with ids replaced by placeholders.
- The candidate clients are installed only for the probe, in a git-ignored folder; the extension's `package.json` and `package-lock.json` do not change; no extension code changes.

**Never:**
- Credentials, tokens, broker hosts or other tenants' log contents in the repository, the conversation or a capture.

**Decisions (user, 2026-11-05):**
- The user creates a Redpanda user on `rpc-vilnius` with only Read on the topic `__redpanda.connect.logs`, and the file `~/.config/rpcn-spike/logs.env` (`username=`, `password=`, `mechanism=SCRAM-SHA-256` or `SCRAM-SHA-512`), owned by the user, mode 0600. The probe records what that grant allows and what it refuses.
- The probe may create and then delete a test pipeline (`vscode-spike-logs-*`: `generate` every second → a `log` processor at INFO and WARN → `drop`, 0.1 CPU) with the service account, deleted at the end also when a step fails.
- The probe may install `kafkajs` and `@platformatic/kafka` in the git-ignored `.cache/logs-probe/` and bundle each with esbuild; the extension's `package.json` does not change.
- The probe is run against `rpc-vilnius` only after the user says so.
- Decision (user, 2026-11-05): the file's keys are the user's own: `redpanda_user` (the username), `repanda_user_pwd` (the password; spelled so) and `auth_mechanism` (`SCRAM-SHA-256` here); the probe also accepts `username`, `password` and `mechanism`. The file is the user's, mode 0600 (checked).
- Decision (user, 2026-11-05): the extension reads the log with a JavaScript Kafka client (the two candidates above), not through the local Redpanda Connect binary's `redpanda` input, which was considered (it cannot start from a time; no new dependency) and declined.

</frozen-after-approval>

## Code Map

- `scripts/spike/cloud-probe.mjs` + `.sh` -- the 5.1 probe: the credentials file checks (owner, mode), the token request, the Control Plane cluster GET, the capture writer and its redaction; reuse its helpers by copying into the new probe (5.1's probe stays as it is).
- New `scripts/spike/logs-probe.mjs` + `logs-probe.sh` -- the probe; `--dry-run` checks every redaction and the refusal paths without the network, as 5.1's does.
- New `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/spike-6-1-findings/` -- `findings.md` and `captures/NN-<step>.json`.
- `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` -- a proposed AD-24 "Reading pipeline logs", after AD-23, marked [PROPOSED] until the user approves.
- `.gitignore` -- `.cache/logs-probe/`.

## Questions the probe answers

1. **Address**: the Control Plane cluster's `kafka_api` (seed brokers, its other fields by name); TLS required, its certificate chain (public CA or not).
2. **SASL**: which mechanisms the cluster offers and which the user's mechanism needs.
3. **ACL**: what the user's ACL allows: metadata for the topic, ListOffsets, Fetch, DescribeConfigs (retention); each refusal with its Kafka error.
4. **The topic**: partitions, retention (or why it cannot be read), records per hour, record size, key and value format (JSON fields across records, by shape).
5. **Placement**: for the probe's pipeline (and, by shape, others), whether all of a key's records are in one partition, and whether that partition is the default murmur2 partitioner's for the key.
6. **Seeking by time**: ListOffsets with a timestamp (now − 15 minutes, now − 7 days, before the oldest record) on the key's partition and every partition, and reading forward from it.
7. **Live**: a fetch from the end that returns the probe's pipeline's new records, and how fast.
8. **Clients**: for each candidate, the above done through it, its esbuild bundle size, whether it bundles without native modules, its last release, and SCRAM, TLS and ListOffsets-by-time support.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/spike/logs-probe.mjs`, `.sh`, `.gitignore` -- the probe and its dry run.
- [x] Run it against `rpc-vilnius` (the user present, as for 5.1); keep the captures.
- [x] `spike-6-1-findings/findings.md` -- answers 1–8 with the captures they rest on; what was not proven.
- [x] Proposed AD-24 in the architecture spine.

**Acceptance Criteria:**
- Given the probe's run, when the captures are read, then a pipeline's records were read by key, live and from a time, with each candidate client, and no capture holds a credential, a broker host, an id or another pipeline's log text.
- Given the findings and AD-24, when the user reads them, then they approve or amend AD-24.

## Implementation Notes

- An earlier implementer was stopped before writing the probe; it left `scripts/spike/logs-probe.sh` (partial) and `.cache/logs-probe/` (probably the candidate clients). Reuse or replace them; `.gitignore` the folder as planned.
- The probe is written and checked offline only; the run against `rpc-vilnius` waits for the user's go-ahead, and the findings and AD-24 are written from its captures. `--dry-run` (128 checks): both credentials files' refusals (mode, symlink, missing keys, a non-SCRAM mechanism) and both key spellings; redaction samples; murmur2 against kafkajs's; the raw ApiVersions / SaslHandshake framing against a local fake broker; four flows on a fake Cloud and fake clients (clean; DescribeConfigs refused plus kafkajs without a Snappy codec; a failure mid-flow; a lost create reply), each checked for leaked values, foreign records and leftovers.
- Also checked, outside the repository, against a throwaway local Redpanda 26.1 (TLS with a self-signed CA, SASL SCRAM-SHA-256, a user with Read on the topic only): the whole `probe()` with a fake Cloud and the real bundled clients and raw TLS. Both clients signed in, read metadata, ListOffsets (earliest, latest, by time), a live read from the end, the 15-minute read and the seeks; a wrong password and DescribeConfigs (TOPIC_AUTHORIZATION_FAILED with Read only) were recorded with their Kafka errors; no consumer group was created. Local only, so not evidence for the cluster: kafkajs 2.2.4 cannot decode Snappy batches (`Snappy compression not implemented`); the probe then borrows @platformatic/kafka's Snappy, LZ4 and ZSTD decoders for kafkajs and records both answers. @platformatic/kafka 2.15.0 does not load from a plain CommonJS esbuild bundle (`import.meta.url` is empty: its wasm file and `createRequire` fail); the probe records each bundle attempt and loads it with an `import.meta.url` shim and `native.wasm` beside the bundle. kafkajs reads without a group only through its internals (`Kafka[private:createCluster]`, `Broker.fetch`).

## Verification

**Commands:**
- `scripts/spike/logs-probe.sh --dry-run` -- every redaction and refusal check passes.
- `git grep` over the captures for the broker host, the cluster id, the username and the password's first characters -- no match.

**Manual checks:**
- The user runs (or watches) the probe against `rpc-vilnius` and reads the findings and AD-24.

- Run 1 (2026-11-05, `captures-run-1/`): two probe bugs — a seek fetched the record before the log's first offset (OFFSET_OUT_OF_RANGE), and the clients read live one after the other while the test pipeline wrote in one burst (kafkajs saw none). Fixed in the probe: both clients read live in the same window; the record before is fetched only inside the log; seeks added at now − 24 h and read forward from 24 h and 7 d (tiered storage). The dry run still passes its 128 checks.
- Run 2 (2026-11-05, `captures/`): every step passed with both clients; nothing left on the cluster. A scan of the 91 files (captures, findings and the run log) found no username, password, service-account value, cluster id, Data Plane host or broker domain.

**Result (user, 2026-11-05):** findings accepted and AD-24 adopted when the user said "mark 6.1 done".
