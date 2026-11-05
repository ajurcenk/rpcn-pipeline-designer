---
title: 'Create the missing cloud secrets'
type: 'feature'
ticket: '7'
created: '2026-11-04'
status: 'in-review'
baseline_revision: 'c9369b648a026d0a5e1708a69cfd1b2563355a5c'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-5-1-findings/findings.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-translate-the-config-for-the-cloud-plan.md
  - src/core/cloudTranslate.ts
  - src/adapters/vscode/cloudView.ts
  - src/adapters/vscode/environmentView.ts
  - src/adapters/vscode/environmentModel.ts
  - src/test/helpers/fakeCloud.ts
  - src/test/integration/suites/96-cloud.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Deploy sends `${secrets.NAME}` (5.6) but never checks that the cluster has `NAME`: a missing secret makes the cluster reject the config ("required secrets were not set") or, with a default, logs a failed lookup; the user must create each secret in the Cloud UI.

**Approach:** After the final translation, Deploy lists the chosen cluster's secrets and, for each secret the config references that the cluster lacks, asks one question at a time, then creates the secrets it was given before creating or updating the pipeline. Values come from the local sources the binary would use, or are typed in a password box; they go only into the secret-creation request.

**Decisions (user, 2026-11-04):**
- A missing secret with a local value: "Keep the value from <source>" or "Enter another value…" (password box). Source names: secret storage, `redpandaConnect.env` (with its level), the env file, VS Code's environment.
- A missing secret with no local value: "Add <NAME> now?"; yes → the password box. Declining, or Escape in any question or box, stops the deploy: nothing more is sent (secrets already created in this deploy stay).
- A reference with a default (`${NAME:default}` only, no use without one) is asked about only when it has a local value, with a third choice "Don't create it (the Cloud uses the default)"; with no local value nothing is asked.
- An existing cloud secret is never changed.
- A typed value goes to the cloud secret only; nothing local changes.

## Boundaries & Constraints

**Always:**
- Spike §4 / AD-23: `GET {dp}/v1/secrets?page_size=100` (paged; ids from `secrets[].id`); create `POST {dp}/v1/secrets` `{id, scopes: ["SCOPE_REDPANDA_CONNECT"], secret_data: <base64>}` → 201; 409 (created meanwhile) counts as existing; through `authorizedJson`; each call 1–3 s, under the deploy's progress.
- A value (local or typed, and its base64 form) never reaches the config, a log line, a message, the view, a setting or a file: it is added to the view's mask set as soon as it is read or typed; request logging stays method, URL and status only.
- Only names the translation turned into secret references are considered; the list is read once per deploy, and only when there is at least one.
- Story 5.2–5.6 rules stand (requests only on the user's action, the fake for every test).

**Never:**
- Updating or deleting cloud secrets; saving a typed value locally; a secrets view or command outside Deploy; secrets not used by the config.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ALL_PRESENT | every referenced secret on the cluster | no question; deploys as 5.6 | the list fails: the API's message, nothing sent |
| KEEP_LOCAL | `${BROKER}` missing; `BROKER` in secret storage | "Keep the value from secret storage" → created from it, then the pipeline | the create fails: the API's message, the pipeline not sent |
| CHANGE_LOCAL | same; "Enter another value…" | password box; the typed value created | Escape: the deploy stops |
| ADD_MANUAL | `${TOKEN}` missing, no local value | "Add TOKEN now?" → password box → created | No / Escape: stops; nothing more sent |
| DEFAULT_LOCAL | `${TOPIC:orders}` missing, local value | keep / change / "Don't create it (the Cloud uses the default)" | Escape: stops |
| DEFAULT_NONE | `${TOPIC:orders}` missing, no local value | nothing asked; not created | none |
| CONFLICT | created by someone else meanwhile (409) | counts as existing; the deploy goes on | none |
| NO_LEAK | any of the above | no value or its base64 in a message, the output channel, the view, the YAML sent or a file | none |

</frozen-after-approval>

## Code Map

- `src/core/cloudTranslate.ts` -- the `ok` result's `secrets` becomes `{ name, required }[]` (required: some use without a default), by first use, as `envUsage`'s `required`; keep the text rules unchanged; update its unit tests.
- `src/adapters/cloud/dataPlane.ts` -- `listSecretNames(call, dp)` (paged) and `createSecret(call, dp, id, value)` (base64 here; 409 → `'exists'`); unit tests with an injected fetch.
- `src/adapters/vscode/environmentView.ts` -- a public `localValues(uri): Map<name, { value; source; level? }>` from `compute(uri)`'s `used` variables (the value the binary would get); wire it into `CloudView` through `src/extension.ts` as an option.
- `src/adapters/vscode/cloudView.ts` `deployFile` -- after the second save-read-translate (after the size pick) and before the UNCHANGED comparison: the secrets step under the deploy's progress; questions through `CloudUi` (a quick pick per secret and the existing `input` with `password: true`), replaceable in tests; values into `seenSecrets` before any message.
- `src/test/helpers/fakeCloud.ts` -- `GET /dp/<id>/v1/secrets` (paged) and `POST` (201, 409 when present), per-cluster secret ids, recorded bodies, a failure hook.
- `src/test/integration/suites/96-cloud.ts` -- every matrix row; the fake's created ids and decoded values; NO_LEAK extended with every value used.
- `README.md` Redpanda Cloud section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/cloudTranslate.ts`, `src/adapters/cloud/dataPlane.ts` + unit tests.
- [x] `src/test/helpers/fakeCloud.ts` -- secrets routes.
- [x] `src/adapters/vscode/environmentView.ts`, `src/extension.ts`, `src/adapters/vscode/cloudView.ts` -- local values, the secrets step.
- [x] `src/test/integration/suites/96-cloud.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given `${BROKER}` and `${TOKEN}` missing on the cluster, `BROKER` set locally and `TOKEN` typed, when the user deploys, then the fake holds both secrets with those values, the pipeline is created after them, and neither value is in any message, log line or the YAML sent.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass.

## Implementation Notes

- Questions and creates are interleaved: each missing secret is asked about, then created (its own progress notification, as is the list), then the next; so an Escape later in the deploy leaves the earlier ones created (Intent). The list, the questions and the creates are not inside the create/update progress (that one starts after the UNCHANGED check and the restart confirmation), so the notification never sits over a quick pick.
- `CloudUi.pickChoice(title, question, choices)` is the per-secret quick pick; the password box is the existing `input` with `password: true`, non-empty. With no local value, the choices are **Add it now: enter its value…** and **Don't deploy**; the question ends "Add <NAME> now?".
- `localValues(uri)` keeps the `used` variables the config references (the `extension` source's `NO_COLOR` included, named "the extension"). Local values of the missing secrets, and each typed value, go into `seenSecrets` with their base64 form as soon as they are read or typed. `maskCredentials` masks values of 4 characters or more only (unchanged).
- The fake's create and update lint now also rejects a `${secrets.NAME}` without a default that the cluster lacks (spike 65), so the earlier suites' configs get `BROKER`, `X` and `LATE` seeded on rpc-vilnius in `setup`.

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: `vars.yaml` with `VSCODE_TRACER_MSG` deleted in the Cloud UI and set locally as a secret variable: Deploy offers to keep the local value, creates the secret, the pipeline runs; a config with an unset `${VSCODE_TRACER_TOKEN}`: "Add it now?", typed value, created; declining stops the deploy. Afterwards delete the pipeline and the secrets in the Cloud UI.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | README's "Not yet" paragraph still says local values are not sent and there is no check before the deploy | low | unchanged context right after the new "Missing secrets" section; contradicts it and the CHANGELOG | patch |
| 2 | An empty local value (`X: ""`, `X=`, an empty process variable) is offered as "Keep" and sent as an empty `secret_data` | medium | `localValues` keeps `value !== undefined`; the typed path refuses empty; no test | patch |
| 3 | The `failed` results of the list and create failures carry the raw API message, unmasked | low | `ensureSecrets` returns `message` without `this.mask`; the shown and logged copies are masked | patch |
| 4 | `listSecretNames` stops silently after 20 pages, so an existing secret can be asked about | low | `MAX_PAGES` cap with no log; the 409 then only logs "already exists" | patch (log it) |
| 5 | DEFAULT_LOCAL's "Enter another value…" path is untested, and its value not in NO_LEAK | low | the test covers Escape, use-default and keep only | patch |
| 6 | NO_LEAK's settings check for `topicLocal` depends on the test's own cleanup | low | the test writes the setting itself; a test-design point, not a leak | reject |
| 7 | Secrets created in a deploy stay when the user then declines "Replace and restart", and nothing says so | low | `ensureSecrets` runs before the confirmation (the plan's order); declining returns `notStarted` silently about them | patch (say which secrets were created and stay) |
