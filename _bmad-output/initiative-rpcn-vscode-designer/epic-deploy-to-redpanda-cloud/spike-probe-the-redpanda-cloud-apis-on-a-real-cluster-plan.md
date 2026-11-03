---
title: 'Probe the Redpanda Cloud APIs on a real cluster'
type: 'chore'
ticket: '1'
created: '2026-11-02'
status: done
baseline_revision: '452ff63799ad36d252fdda7438d3776dede9bb67'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 5 builds on the Redpanda Cloud Control Plane and Data Plane APIs, whose public docs are thin and partly inconsistent (Dedicated is not listed for the pipeline API; no create or validation details; the update example lacks the id). Building on guesses would mean rework in every story.

**Approach:** A repeatable probe script, run with the user's service account against their real cluster(s), makes each call the epic needs and records the exact requests and responses (secrets, tokens and the license-like values redacted) as captures. A findings file answers the questions, and a proposed AD-23 in the architecture spine fixes the API contract the stories build on, for the user to approve.

**Decisions (user, 2026-11-02):**
- The cluster probed is `rpc-vilnius` (its type, BYOC or Dedicated, is one of the findings).
- The probe may create and then delete a test pipeline (`vscode-spike-*`, `generate` → `drop`, 0.1 CPU) and a test secret (`VSCODE_SPIKE_*`) on it.
- The credentials are read from `~/.config/rpcn-spike/credentials.env` (`client_id=`, `client_secret=`), which the user created; the file must be the user's own and mode 0600, or the probe refuses to run.
- Captures are committed with the organization id, the cluster id and the probe's resource ids replaced by `<org-id>`, `<cluster-id>`, `<pipeline-id>` (and the Data Plane host by `<dataplane-host>`).

## Boundaries & Constraints

**Always:**
- The client ID and secret come only from that file; the script never prints, logs or writes them or the access token; captures redact `Authorization`, `client_secret`, `access_token`, secret values and pipeline secrets.
- Calls that change the cluster use names prefixed `vscode-spike-`; everything the script creates it deletes at the end, also when a step fails; it never touches anything else.
- One token per run (the org's daily token limit).
- No extension code changes; nothing is installed.

**Never:**
- Credentials, tokens or secret values in the repository, the conversation or a capture.

## Questions the findings must answer

1. Token: the request and response (`expires_in`, scope), the error for a bad secret.
2. Clusters: the list call (path, paging), how BYOC and Dedicated are told apart, cloud and region fields, `dataplane_api.url`, and what reports the Connect version.
3. Pipelines on each probed cluster type: list, create (the accepted `resources` and `tags` shapes, the minimum body, the response), get, update (`PUT /{id}`: which fields it takes), start, stop, delete, the states seen and their timing, the error shape for an invalid config and for a cluster without the pipeline API.
4. Secrets: list, create (`scopes`, base64), the error for an existing id, delete; how a pipeline reads one (`${secrets.NAME}`) — proved by a pipeline that uses one.
5. Validation and components: whether any endpoint lints a config or lists a cluster's components or Connect version.
6. Rate limits and errors: status codes and bodies seen (401, 403, 404, 409, 429).

</frozen-after-approval>

## Code Map

- `scripts/spike/` -- earlier probes (`blobl-probe.sh` + `.mjs`): the pattern to follow (a Node script for HTTP and timings, a shell wrapper, header comments on inputs and outputs). New: `scripts/spike/cloud-probe.mjs` (+ `cloud-probe.sh`).
- `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/spike-4-1-findings/` -- the findings and captures layout to follow; new folder `epic-deploy-to-redpanda-cloud/spike-5-1-findings/` with `findings.md` and `captures/`.
- `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` -- the spine; AD-22 is the last; add AD-23 "Redpanda Cloud API contract" marked PROPOSED.
- Docs used: the epic's References (Data Plane API, create pipeline, authentication).

## Tasks & Acceptance

**Execution:**
- [x] `scripts/spike/cloud-probe.mjs`, `cloud-probe.sh` -- the probe: token, clusters, per cluster pipelines and secrets (create, use, read, update, start, stop, delete), error cases, cleanup in `finally`, redacted captures.
- [x] Run it with the user (their credentials file and clusters); keep the captures. The implementer writes the probe and checks it only offline (`--dry-run`: no network, the planned requests printed with placeholders, and the redaction tested on sample responses); the run against `rpc-vilnius` is made afterwards by the orchestrator, once the script is read, and the findings and AD-23 are written from its captures.
- [x] `spike-5-1-findings/findings.md` -- one answer per question, with the capture behind it.
- [x] Architecture spine -- AD-23 PROPOSED: endpoints, bodies, states, errors, token handling, Dedicated support, validation (or its absence) for entries 2-8.

**Acceptance Criteria:**
- Given the run, when the captures are read, then none holds a credential, token or secret value, and the cluster holds nothing the probe created.
- Given the findings, when the user reads them, then each question has an answer with its evidence, and AD-23 is approved or changed by the user.

## Implementation Notes

- The probe was written and checked offline only (`bash scripts/spike/cloud-probe.sh --dry-run`: a fake of the auth, Control Plane and Data Plane hosts; the credentials-file checks; redaction on samples; three flows, one clean and two with an injected failure, each checked for leaked values, the plan's grep, and leftovers). The real run against `rpc-vilnius` has not been made.
- Every created pipeline gets `resources {cpu_shares: 100m, memory_shares: 400M}` (the 0.1 CPU decision), so the "minimum body" is display_name + config_yaml + resources. A create without `resources` (the cluster's default size) runs only with `CLOUD_PROBE_TRY_NO_RESOURCES=1`.
- Other clusters are not called by default. With `CLOUD_PROBE_OTHER_CLUSTERS=1` the probe makes one read-only pipeline list on each other BYOC or Dedicated cluster and keeps successful bodies as shapes only. That is the only way to answer the Dedicated question if `rpc-vilnius` is BYOC.
- The secret is used through `root.n = ${secrets.VSCODE_SPIKE_<RUN>_N}` in the `generate` mapping (a random 9-digit value). An unsubstituted reference would be a Bloblang parse error, so RUNNING proves the substitution. A second pipeline reads a missing secret, to show that error.
- Validation candidates (`config-schema` on v1, v1alpha2 and v1alpha3, four `lint` POST paths with an invalid config, `components`) are guesses, and a 404 on them is expected evidence. A large config-schema body goes to `.cache/cloud-probe/`, and the capture keeps a summary with any `version` fields.
- Update variants on the stopped pipeline: partial (description only), full, `?update_mask=description`, and a body wrapped in `{pipeline: …}`. Then one full update while it runs, followed by a 30 s state watch. Each GET after an update records which fields changed.
- Leftovers from earlier runs (`vscode-spike-*` and `VSCODE_SPIKE_*` without this run's tag) are reported in `run.json` and never deleted.

## Verification

**Commands:**
- `bash scripts/spike/cloud-probe.sh` -- expected: every step reports its status; the cleanup step reports nothing left.
- `grep -rniE 'client_secret|access_token|Bearer [A-Za-z0-9]' spike-5-1-findings/captures` -- expected: only redaction markers.

**Manual checks:**
- In the Redpanda Cloud UI, the probed clusters show no `vscode-spike-*` pipeline or `VSCODE_SPIKE_*` secret after the run.

## Run Notes

- Run 1 (2026-11-02, `spike-5-1-findings/captures-run-1/`): every read and the secret flow answered; the main pipeline's create failed because the probe's config had an unquoted `${secrets.X}` in Bloblang (the create-time lint substitutes an empty value — a finding in itself); the 0.1 CPU pipeline went to ERROR with no message. Exit 1, nothing left on the cluster.
- After run 1 (orchestrator): the probe's redaction missed the Serverless list (other clusters' ids and console URLs), the provider tags (an AWS partner id in a tag key and a `pc:` id) and the Data Plane/Kafka host prefix; run 1's captures were cleaned in place and the probe fixed (Serverless list and tags as shape or count only, the host prefix a placeholder). The secret reference is quoted, and a 0.5 CPU pipeline was added (user decision) to tell whether run 1's ERROR was about resources.
- Run 2 (`captures/`): every step answered, exit 0, nothing left. The 0.1 CPU pipeline ran this time (15 s), so run 1's ERROR was not the resources; an error can come with no reason. Remaining ID-like strings in the captures are Auth0 request ids and a documentation example account number.
- The credentials file was first owned by root, mode 644; it was replaced by a copy owned by the user, mode 600, before the runs (the probe refuses anything else).
- Run 3 (after the review, `captures/`, written by the probe itself): exit 0, nothing left, no section error. Run 2's captures were replaced by it; `captures-run-1/` keeps only the two captures the findings cite. Findings and AD-23 rewritten from run 3; AD-23 back to PROPOSED for the user's approval of the new text.

## Review Triage Log

Quick review of the probe, two runs' captures, the findings and AD-23. Verdicts: 2 high, 4 medium, 8 low, 0 false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The cluster capture held its public NAT IP, the HTTP Proxy and Schema Registry host prefixes and its full configuration | high | patch | Real (07). The probe captures the cluster as the fields the findings use plus the other fields' names; run 3 re-captured. |
| 2 | The probe still leaked provider-tag keys (shape kept keys); the committed captures were hand-cleaned, not the probe's output | high | patch | `shape()` reduces tag and label maps to a count; run 3's captures are the probe's own. |
| 3 | Shapes of the cluster's own pipelines and secrets kept tag and label keys | medium | patch | With 2. |
| 4 | A 2xx body from a guessed lint path with an `id` would be adopted and deleted by cleanup | medium | patch | `track()` adopts only a pipeline named `vscode-spike-<run>-…`; a fake case answers a lint path with someone else's id. |
| 5 | A create whose reply was lost leaves its pipeline or secret behind | medium | patch | Cleanup finds this run's pipelines and both secrets by name; a fake "lost-create" case proves it. |
| 6 | Claims beyond the evidence (no lint endpoint, whole-body update, secret delivery, BYOC, `status.error`, `STATE_COMPLETED`, paging, error shape, rate limits) | medium | patch | Probe tests for delivery (interval from the secret), omitted fields and a quoted value; findings and AD-23 rewritten to claim only what run 3's captures show, the rest marked open; limits recorded. |
| 7 | The 5 MB components body committed twice | low | patch | Summarised (counts, names, entry keys); the full body in `.cache/`. |
| 8 | The plan's grep also hits `bearer token is invalid` | low | noted | The API's own message, not a credential. |
| 9 | Q1 called the Data Plane token "well-formed" | low | patch | Reworded: the same malformed token on both planes. |
| 10 | AD-23 marked ADOPTED with no recorded approval | low | patch | The user approved the first text (2026-11-02); after the rewrite it is PROPOSED again. |
| 11 | The secret id pattern is in no capture | low | patch | Cited as the documentation's. |
| 12 | `STATE_STOPPING` observed in run 2, said unobserved | low | patch | Run 3 is the evidence and did not see it; AD-23 names it from the documentation. |
| 13 | Paging never exercised | low | patch | Marked open. |
| 14 | A quoted value with `"` or `\` untested | low | patch | Tested in run 3: the pipeline ran. |
- AD-23 adopted by the user 2026-11-02 (the rewritten text, after the review).
- Marked done by the user on 2026-11-02.
