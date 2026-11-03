---
title: 'Tracer: connect a service account, pick a cluster and deploy a config as written'
type: 'feature'
ticket: '2'
created: '2026-11-02'
status: 'in-review'
baseline_revision: '0221c5362fea1e93a682806d37c5b3e1b87b9c29'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-5-1-findings/findings.md
  - src/adapters/vscode/environmentView.ts
  - src/adapters/vscode/secrets.ts
  - src/adapters/vscode/run.ts
  - src/extension.ts
  - package.json
  - src/test/helpers/fakeBinary.ts
  - src/test/integration/suites/95-environment-view.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing in the extension talks to Redpanda Cloud. Epic 5's stories all need the same first path: a service account the extension can use, the organization's clusters, a pipeline created from a config, and a place to see it.

**Approach:** The thinnest path through every layer, on AD-23: **Connect service account** (client ID, then the secret in a password box, both in VS Code's secret storage) with an in-memory token cache; the Control Plane's clusters with their Data Plane address and Connect version; **Deploy to Redpanda Cloud** (command and editor-title button on a detected, saved config) that creates a pipeline from the file's text unchanged on a chosen cluster and follows its state; a first **Cloud** view in the Redpanda Connect sidebar (the service account, its clusters, their pipelines with state); and a local fake of the auth, Control Plane and Data Plane APIs for the integration tests.

## Boundaries & Constraints

**Always:**
- AD-23's contract: one token per window per service account, cached in memory for `expires_in` less a margin, never logged, written or shown; the client secret only in VS Code's secret storage (`context.secrets`), never in a setting, a file, argv or a log line; requests to the three production hosts only, made only on the user's action (connect, deploy, view refresh or expand).
- Every request and error message masks the client secret, the token and Authorization headers; API errors are shown as their `message` (and `LintHint` lines for a rejected config), with nothing else from the response body.
- The deploy sends the saved file's text as `config_yaml` unchanged (translation is story 6), creates a new pipeline every time (update is story 3), and never changes the file.
- The Cloud view follows the Environment view's patterns (a tree in the `redpandaConnect` container, `contextValue` menus, an `items()` test seam in test mode only).
- Theme only, no Redpanda branding (spec Constraints); stable APIs, `engines.vscode ^1.100.0`; Node's global `fetch` (the extension host's Node 20).

**Never:**
- Updating, starting, stopping or deleting pipelines (stories 3, 4); variables, secrets or resource files in the deploy (stories 6, 7); a pre-deploy check (story 8); Serverless clusters; browser sign-in.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CONNECT | Connect service account: client ID, then secret (password box) | both stored in secret storage; a token is requested once; the view shows the account (its token's `client_name`) and its clusters | 401: "the client ID or secret is wrong", nothing stored |
| CONNECT_CANCEL | Escape at either prompt | nothing stored, no request | none |
| DISCONNECT | Disconnect | the stored ID and secret and the cached token are removed; the view shows its empty state | none |
| NOT_CONNECTED | Deploy, or the view, with no service account | the view's empty state with Connect; Deploy offers Connect first | none |
| TOKEN_CACHE | several calls within the token's lifetime | one token request | none |
| CLUSTERS | clusters listed | BYOC and Dedicated clusters with cloud, region and Connect version; one without a Data Plane address shown as "no pipeline API" and not offered for deploy | a Control Plane error is shown in the view and as a message |
| DEPLOY | a detected, saved config; Deploy; pick a cluster; name (default: the file's name) | `POST` with the file's text, default resources, a tag naming the file; a progress notification until `STATE_RUNNING`; the pipeline in the view | none |
| DEPLOY_REJECTED | the cluster rejects the config (400 with `LintHint`s) | an error message with each hint's line and text; nothing created | none |
| DEPLOY_ERROR_STATE | the pipeline reaches `STATE_ERROR` (with or without a message) | the notification says so (its message, or "the cluster gave no reason"); the view shows Error | none |
| DEPLOY_UNSAVED | the config has unsaved changes, or is untitled | Deploy asks to save first (as Run does) | untitled: refused |
| VIEW_REFRESH | Refresh, or expanding a cluster | clusters and pipelines read again | an error row in the cluster |
| NO_LEAK | any of the above | no secret, token or Authorization value in a message, the output channel, a setting, a file or the view | none |

</frozen-after-approval>

## Code Map

- `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` AD-23 -- the contract: token request and cache, clusters list then get for `dataplane_api.url` and `redpanda_connect.version`, pipeline create body (`resources: {cpu_shares, memory_shares}`, `tags` a map), states, `LintHint`s, error shapes, rate limits.
- `epic-deploy-to-redpanda-cloud/spike-5-1-findings/captures/` -- real request and response bodies to model the fake on (01 token, 04 clusters list, 07 cluster get, 09 pipelines list, 26 a rejected create with `LintHint`s, 29/31 create and state).
- New `src/adapters/cloud/` -- `token.ts` (the cache; injectable fetch and clock), `controlPlane.ts` (clusters), `dataPlane.ts` (pipelines list, create, get), `errors.ts` (API error → message, `LintHint`s, masking); no `vscode` import except where the URLs and secret storage are read.
- `src/adapters/vscode/secrets.ts` (wired ~:192 in `extension.ts`) -- how ticket 30 uses `context.secrets`; the service account keys are separate (`redpandaConnect.cloud.clientId`, `redpandaConnect.cloud.clientSecret`), not in the environment secrets' records.
- `src/adapters/vscode/environmentView.ts` -- the tree view pattern to follow (provider, `register()`, commands, `contextValue`, `items()` seam, empty state); new `src/adapters/vscode/cloudView.ts`.
- `src/adapters/vscode/run.ts` -- Run's save-first and untitled handling to reuse for Deploy; `ACTIVE_DETECTED_KEY` for menus.
- `src/extension.ts` (~:54 `ExtensionApi`, ~:300 test-mode seams) -- register the view and commands; a `cloud` test seam in test mode: its items, the prompts to replace, and the base URLs of the three hosts (production values otherwise).
- `package.json` -- `views.redpandaConnect` gains `redpandaConnect.cloud` ("Cloud"), `viewsWelcome` for its empty state, commands (connect, disconnect, deploy, refresh), `editor/title` Deploy (detected, saved configs, as Run), view title and item menus.
- `src/test/helpers/` -- new `fakeCloud.ts`: a local HTTP server for the three hosts (token, `/v1/clusters`, `/v1/clusters/{id}`, `{dp}/v1/redpanda-connect/pipelines` list, create with lint errors, get with a state sequence), recording requests for the no-leak checks.
- Tests: a new integration suite `src/test/integration/suites/96-cloud.ts` for every matrix row against the fake; unit tests for the token cache and the error mapping.
- Docs: `README.md` (a Redpanda Cloud section: service account, Connect, Deploy, the view; what the tracer does not do yet), `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/cloud/*` + unit tests -- token cache, clients, error mapping and masking.
- [x] `src/test/helpers/fakeCloud.ts` -- the fake of the three hosts.
- [x] `src/adapters/vscode/cloudView.ts`, `package.json`, `src/extension.ts` -- Connect, Disconnect, Deploy, Refresh, the view, the test seam.
- [x] `src/test/integration/suites/96-cloud.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass.
- Given every request the fake received and every message, output line and view item, when they are read, then none holds the client secret or a token outside an `Authorization` header.

## Implementation Notes

- Decision (user, 2026-11-02): tracer resources are `cpu_shares: "100m"`, `memory_shares: "400M"` (0.1 CPU · 400 MB), a constant in the cloud adapter until story 3's setting.
- Decision (user, 2026-11-02): the pipeline name defaults to the file's name without its extension (`orders.yaml` → `orders`), pre-filled in an input box the user can edit; an empty name is refused by the box's validation.
- The tag naming the file: key `rpcn-vscode/config` (accepted by the API, spike 39), value the workspace-relative path.
- The real API's `STATE_ERROR` can arrive with no `status` (spike 31, 35): the fake must offer that sequence too.
- Polling: GET the pipeline every 3 s until `STATE_RUNNING`, `STATE_ERROR`, `STATE_STOPPED` or `STATE_COMPLETED`, at most 3 minutes; then say it is still starting and leave the view to show it. Poll interval and timeout are test-seam overridable.
- The Cloud test seam lives only in `ExtensionMode.Test`; production base URLs are `https://auth.prd.cloud.redpanda.com`, `https://api.redpanda.com`, and each cluster's `dataplane_api.url`. The fake returns its own address as `dataplane_api.url`.

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot`, `npm run test:corpus`, `npm run test:webview` -- expected: pass.

**Manual checks:**
- Dev host on 1.143.1 against the real organization: Connect with the spike's service account; the view lists `rpc-vilnius` (Dedicated, Connect 4.115.0); Deploy a config with no variables (`generate` → `drop`); it reaches Running and shows in the view; then delete it in the Cloud UI (delete is story 4).
