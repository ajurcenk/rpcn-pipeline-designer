# Spike 5.1 findings: the Redpanda Cloud APIs on a real cluster

Probed 2026-11-02 with `scripts/spike/cloud-probe.sh` and a service account of the user's organization, on `rpc-vilnius`, the organization's only cluster (a Dedicated cluster on AWS). Three runs: run 1 found a probe bug (an unquoted secret reference) and a pipeline ERROR without a message; run 2 completed every step, with its captures not kept (its probe redacted too little); run 3, after the review's fixes to the probe, is the evidence: `captures/NN-<step>.json`, written by the probe itself. `captures-run-1/` keeps the two run-1 captures cited below. Every run deleted what it created (`captures/run.json`: `leftovers_this_run: []`).

Captures hold no credential, token or secret value; the organization id, cluster id, Data Plane host and the probe's resource ids are placeholders; the cluster is captured as the fields used here (other fields listed by name only); tag and label maps are counts; pipelines, secrets and clusters the probe did not create are shapes. Remaining ID-like strings are Auth0 request ids.

**Not proven, open for the stories:** BYOC clusters (none in the organization); the error for a cluster without the pipeline API; paging beyond one page; `STATE_COMPLETED` and `STATE_STOPPING` (run 3 saw neither); a pipeline `status` with an error message (no capture has one); lint on update; whether the lint paths exist for another service account (they answered PERMISSION_DENIED).

## Answers

### 1. Token

- `POST https://auth.prd.cloud.redpanda.com/oauth/token`, form `grant_type=client_credentials`, `client_id`, `client_secret`, `audience=cloudv2-production.redpanda.cloud` → 200 `{access_token, scope, expires_in: 86400, token_type: "Bearer"}`; the token is a JWT carrying the organization id (01).
- A bad secret → 401 `{error: "access_denied", error_description: "Unauthorized"}` (02): the token endpoint's errors are OAuth-shaped, not the APIs' `{code, message, details}`.
- Limits (01 headers): `auth0-organization-quota-limit: b=per_day;q=100` — 100 tokens per day per organization (`r=97` after this run: one per run); `x-ratelimit-limit: 300`.
- The same malformed token (`probe-invalid-<hex>`, not a JWT) → 500 `{code: "UNKNOWN", message: "failed to parse token: …"}` on the Control Plane (03) and 401 `bearer token is invalid` on the Data Plane (08). A well-formed but invalid or expired JWT was not tried.

### 2. Clusters

- `GET https://api.redpanda.com/v1/clusters?page_size=100` → `{clusters, next_page_token}` (04); Serverless clusters are a separate list, `GET /v1/serverless/clusters` → `{serverless_clusters, next_page_token}` (05). Only `next_page_token: ""` was seen; following a page token was not exercised.
- Control Plane limits (04 headers): `ratelimit-policy: 200;w=60;policy="account", 2000;w=60;policy="organization"` — 200 requests a minute per account, 2,000 per organization.
- `GET /v1/clusters/{id}` → `{cluster}` with `type: TYPE_DEDICATED`, `state: STATE_READY`, `cloud_provider`, `region`, `dataplane_api.url` (the Data Plane address) and `redpanda_connect.version: 4.115.0` (07). The list entries carry no `dataplane_api` (run.json `has_dataplane_api: false`): the Data Plane address comes from the single-cluster GET.
- A malformed id → 400 (`id: must be 20 characters`, `^[a-v0-9]{20}`) (06): cluster ids are 20-character xids.
- BYOC (expected `TYPE_BYOC`) was not observed: the organization has no BYOC cluster.

### 3. Pipelines on a Dedicated cluster

- **Dedicated clusters offer the pipeline API**: list, create, get, update, start, stop and delete all answered on `rpc-vilnius` (09, 29–64).
- List: `GET {dp}/v1/redpanda-connect/pipelines?page_size=100` → `{pipelines, next_page_token}` (09); `filter.name_contains` filters by display name (58).
- Create: `POST {dp}/v1/redpanda-connect/pipelines` `{display_name, description?, config_yaml, resources: {cpu_shares: "100m", memory_shares: "400M"}, tags?: {key: value}}` → **200** `{pipeline}` in `STATE_STARTING` (29, 39). The pipeline object: `id, display_name, description, config_yaml, resources, state, url, tags, created_by, create_time, update_time` (36).
  - `tags` must be a map: an array → 400 `proto: syntax error … unexpected token [` (27). A key with a `/` (`rpcn-vscode/config`) is accepted (39).
  - The create **validates the config**: invalid YAML → 400 `invalid YAML: …` (25); an unknown component → 400 with `details[].details[]` holding a `type.googleapis.com/redpanda.api.common.v1.LintHint` `{line, column, hint}` (`unable to infer component type: probe_no_such_input`) and an `ErrorInfo` `REASON_CONNECT_INVALID_PIPELINE_CONFIGURATION` (26).
  - A secret the cluster lacks is a lint error at create: hint `required secrets were not set: [secrets.NAME]` (65).
  - The create-time lint substitutes `${secrets.NAME}` with an empty value: an unquoted `root.n = ${secrets.X}` in Bloblang fails (`expected query, got: …`, captures-run-1/33); quoted it passes (39).
- **The secret's value reaches the pipeline**: the main pipeline's `generate.interval` is `"${secrets.N}"`, the secret's value a duration (`<n>ms`); it reached `STATE_RUNNING` (40, run.json `secret_delivered`), which it could not with the literal reference.
- **A value holding `"` and `\`** in a quoted Bloblang reference (`root.n = "${secrets.Q}"`, the value `q"<n>\x`) did not stop the pipeline: `STATE_RUNNING` (61, 62, run.json `quoted_secret_state`). Whether the mapping received the value intact is not observable from the API.
- States and timing (timeline.tsv): `STATE_STARTING` → `STATE_RUNNING` in 10–31 s; stop → `STATE_STOPPED` within one poll (41, 42); start → `STATE_STARTING` → `STATE_RUNNING` in 10 s (53, 54).
- **`STATE_ERROR` with no message, intermittently**: two pipelines with no secret (0.1 and 0.5 CPU) went `STATE_STARTING` → `STATE_ERROR` after about 62 s with no `status` field (31, 35), as run 1's 0.1 CPU pipeline did (captures-run-1/30); in run 2 the identical pipelines ran. The cause is not in the API's answer. One poll during the wait failed at the network level (timeline `HTTP 0`).
- Update `PUT {dp}/v1/redpanda-connect/pipelines/{id}` **replaces the pipeline**:
  - a body without `config_yaml` is rejected (`{description}` alone, and the same wrapped as `{pipeline: …}` → 400 `a pipeline needs a configuration before it can run`) (43, 51);
  - a body without `description` and `tags` **clears them** (`description: ""`, `tags: {}`) (47, 48);
  - the full body → 200 (45, 46);
  - `?update_mask=description` → 200 and only the description changes (the body's display_name is ignored) (49, 50);
  - an update of a running pipeline **restarts it**: `RUNNING` → `STARTING` after about 5 s → `RUNNING` about 20 s later (55, 57, timeline.tsv).
- Delete: `DELETE {id}` → 200 (32, 59); a GET then answers 404 (33, 60). Get of a missing id → 404 (28).

### 4. Secrets

- List: `GET {dp}/v1/secrets?page_size=100` → `{secrets, next_page_token}` (10); `filter.name_contains` works (23). Secret calls take 1.2–2.9 s.
- Create: `POST {dp}/v1/secrets` `{id, scopes: ["SCOPE_REDPANDA_CONNECT"], secret_data: <base64>}` → **201** `{secret: {id, labels, scopes}}` (19, 24). The same id again → **409** (20). Get → `{secret: {id, labels, scopes}}`, no value (21). A missing id → 404 (22). Delete → **204**, then 404 (66, 67, 68).
- The id rule `^[A-Z][A-Z0-9_]*$` is the documentation's (Data Plane API page); the probe used only such ids.

### 5. Validation and components

- The guessed lint paths `/v1/redpanda-connect/lint`, `/pipelines/lint`, `/pipelines:lint`, `/config/lint` and `/v1alpha3/…/config-schema` answered **403 `PERMISSION_DENIED` "you are not authorized to call this endpoint"** (13–17): they may exist for other permissions. The validation this service account has is the create call's.
- `GET {dp}/v1/redpanda-connect/components` → `{components: {version: "4.115.0", inputs (61), outputs (66), processors (80), buffers, caches, rate_limits, metrics, tracers, scanners, bloblang_functions (36), bloblang_methods (193)}}`, each a list of `{name, type, status, summary, description, config, …}` (18, summarised; the full body is in `.cache/`, git-ignored).
- `GET {dp}/v1/redpanda-connect/config-schema` (and `/v1alpha2/…`) → 200 `{config_schema}`, the cluster's config schema (11, 12, summarised).

### 6. Errors

- API error bodies: `{code: "<gRPC code name>", message, details}` — `INVALID_ARGUMENT` (400), `PERMISSION_DENIED` (403), `UNKNOWN` (500); the token endpoint uses `{error, error_description}` (02).
- Seen: 400, 401, 403, 404, 409, 500. Not seen: 429.

## For the stories

- **5.2 tracer:** cache the token for `expires_in`; the organization has 100 tokens a day. Clusters from `/v1/clusters`, then `GET /v1/clusters/{id}` for `dataplane_api.url` and `redpanda_connect.version`. Create answers 200 in `STATE_STARTING`; poll GET. BYOC is expected to behave as Dedicated; check it on a BYOC cluster when one is available.
- **5.3 update:** `PUT /{id}` replaces the pipeline: always send display_name, description, config_yaml, resources and tags, or the missing ones are cleared. An update of a running pipeline restarts it (the diff-and-confirm stands).
- **5.4 lifecycle:** stop is immediate, start about 10 s; `STATE_ERROR` can come with no reason: show "Error (the cluster gave no reason)". `STATE_STOPPING` and `STATE_COMPLETED` are in the documentation but were not seen.
- **5.6 translation:** quote every `${secrets.NAME}` inside Bloblang (the create-time lint sees an empty value); a value with quotes or a backslash did not stop a quoted reference.
- **5.7 secrets:** list is slow (1–3 s); create 201, existing 409, scope `SCOPE_REDPANDA_CONNECT`; the create's lint also names missing secrets.
- **5.8 pre-deploy check:** `GET {dp}/v1/redpanda-connect/components` lists what the cluster runs, with its version; the create's `LintHint`s give line and column for anything else. A separate lint endpoint was not available to this service account.
