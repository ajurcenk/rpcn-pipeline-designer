---
title: 'Deploy again updates the mapped pipeline'
type: 'feature'
ticket: '3'
created: '2026-11-03'
status: 'in-review'
baseline_revision: '2f019725e2e5866d93d53e904d6cf5975e676ded'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-5-1-findings/findings.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-tracer-connect-a-service-account-pick-a-cluster-and-deploy-a-plan.md
  - src/adapters/vscode/cloudView.ts
  - src/adapters/cloud/dataPlane.ts
  - src/test/helpers/fakeCloud.ts
  - src/test/integration/suites/96-cloud.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every Deploy creates a new pipeline (story 5.2), so iterating on a config leaves a trail of copies on the cluster, and nothing ties a pipeline to the file it came from. Resources are a fixed 0.1 CPU.

**Approach:** A committed sidecar beside the config (`orders.yaml` → `orders.cloud.json`: cluster id, pipeline id) plus the pipeline's existing `rpcn-vscode/config` tag tie the two. A second Deploy reads the deployed pipeline and updates it (`PUT`, the full body); when that pipeline is running or starting and its config differs, a diff of the deployed and local config opens and a modal confirmation is needed. Resources come from a new compute-unit setting (1 unit = 0.1 CPU + 400 MB), chosen in a prompt on the first deploy when unset.

## Boundaries & Constraints

**Always:**
- AD-23's update rule: `PUT {dp}/v1/redpanda-connect/pipelines/{id}` with `display_name`, `description`, `config_yaml`, `resources` and `tags` every time (the deployed name, description and other tags kept, our tag set), or the missing ones are cleared.
- The sidecar holds ids only (`{"clusterId", "pipelineId"}`, plus names for reading), never a secret, token or config text; it is written only after a create or update succeeded; the config file itself is never changed.
- The deployed config is shown read-only (a virtual document), never written to disk.
- Story 5.2's rules stand: saved text sent unchanged, every message and log line masked, requests only on the user's action, the fake for every test.

**Never:**
- Start, stop or delete (story 4); translating `${VAR}` (story 6); several pipelines per config; resources per config (one setting); a merge of deployed and local config.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FIRST_DEPLOY | no sidecar, setting unset | compute-unit prompt (1–15, default 1) saved to the setting; create as in 5.2 with those resources; sidecar written | Escape at the prompt: nothing sent |
| UPDATE_STOPPED | sidecar; pipeline not running or starting | `PUT` with the full body; state followed; sidecar unchanged | 400 with `LintHint`s as in 5.2, "not updated" |
| UPDATE_RUNNING | sidecar; pipeline running or starting, config differs | diff (deployed ↔ local) opens; modal "Replace and restart"; on confirm `PUT`, then followed through the restart until running again | Cancel: nothing sent |
| UNCHANGED | config and resources equal to the deployed | "already deployed, nothing changed", no `PUT` | none |
| RESOURCES_ONLY | config equal, setting changed | `PUT` (running: confirmation without a diff, naming old and new size) | none |
| MAPPED_GONE | sidecar; pipeline 404 (deleted in the Cloud) | offer "Create a new pipeline"; on yes create and rewrite the sidecar | cluster gone or no longer offering the API: the same offer, with a cluster pick |
| BAD_SIDECAR | sidecar not JSON or missing ids | message naming the file; offer to deploy as new (sidecar replaced) | none |
| TAGGED | no sidecar; the chosen cluster has a pipeline tagged with this file | offer "Update <name>" / "Create new"; either way the sidecar is written | Escape: nothing sent |
| NOT_CONNECTED | sidecar; no account | offer Connect first (as 5.2) | none |

**Decisions (user, 2026-11-03):**
- A second Deploy with a sidecar updates the mapped pipeline straight away, with no cluster or name prompt (a running one still gets the diff and confirmation); deploying elsewhere means deleting the sidecar.
- With no sidecar, when the chosen cluster has a pipeline whose `rpcn-vscode/config` tag names this file, Deploy offers "Update <name>" or "Create new"; the sidecar is written either way.
- The first-time compute-unit choice is saved to the workspace settings (`.vscode/settings.json`; the workspace folder's in a multi-root workspace).

</frozen-after-approval>

## Code Map

- AD-23 (architecture doc) and findings §3 -- `PUT` replaces; an update of a running pipeline restarts it (`RUNNING` → `STARTING` after ~5 s → `RUNNING`); lint on update unverified, so a 400 on `PUT` is handled as on create.
- `src/adapters/cloud/dataPlane.ts` -- `TRACER_RESOURCES` becomes `resourcesOf(units)` (`${units*100}m`, `${units*400}M`); `pipelineFrom` also keeps `description`, `config_yaml` and `resources`; new `updatePipeline(call, dp, id, body)`. Requests go through `authorizedJson` (controlPlane.ts) like the others.
- `src/adapters/vscode/cloudView.ts` `deployFile`/`createAndFollow`/`report` (~:700–860) -- split into: resolve target (sidecar → GET; else cluster pick + name), compare, confirm, create-or-update, follow, write sidecar. Reuse the save-first, Connect-first and cluster-pick code as is. New: a `TextDocumentContentProvider` for scheme `redpanda-cloud` (`redpanda-cloud:/<cluster>/<pipeline>/<name>.yaml`) for the diff's left side (story 5 reuses it for "Open deployed config"); `vscode.diff`; `ui.confirm` added to `CloudUi` (modal `showWarningMessage`) and `ui.pickUnits`, both replaceable in tests.
- New `src/adapters/cloud/sidecar.ts` -- path (`<dir>/<stem>.cloud.json`), parse (strict: both ids strings), serialize (2-space JSON, trailing newline); no `vscode` import; unit tests.
- `package.json` -- `redpandaConnect.cloud.computeUnits` (integer 1–15, no default value so "unset" is detectable, `scope: resource`), description stating 0.1 CPU + 400 MB per unit; `files.associations`/`jsonValidation` not needed.
- `src/test/helpers/fakeCloud.ts` -- add `PUT /{id}` (replace semantics: missing description/tags cleared, missing config 400, lint on the new config), and a restart sequence after an update of a running pipeline; record bodies.
- `src/test/integration/suites/96-cloud.ts` (or a new `97-cloud-update.ts`) -- every matrix row; the `PUT` body carries the kept name, description and tags.
- `README.md` Redpanda Cloud section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/cloud/sidecar.ts`, `dataPlane.ts` + unit tests -- sidecar, resources, update.
- [x] `src/test/helpers/fakeCloud.ts` -- `PUT` and the restart.
- [x] `src/adapters/vscode/cloudView.ts`, `package.json` -- the update flow, diff provider, confirmation, compute-unit setting and prompt.
- [x] integration tests for every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a config deployed once, when it is deployed again, then the fake received one create and one `PUT` to the same id, and the cluster has one pipeline.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass.

## Implementation Notes

- Following an update of a running pipeline: the state is `RUNNING` right after the `PUT`; poll until a non-running state has been seen and then a final one, or until 20 s pass with no change (then report it running).
- `STATE_STARTING` counts as running for the confirmation.

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: deploy `vscode-tracer.yaml` (compute-unit prompt, sidecar appears); change the mapping and deploy again (diff and confirmation, the same pipeline restarts and runs); deploy unchanged ("nothing changed"); delete it in the Cloud UI, deploy again (offer to create new).

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | Sidecar rewritten on the mapped paths (UNCHANGED, update) when its text differs from the serialized form | medium | `mapTo` → `writeMapping` (cloudView.ts ~928, ~943) writes whenever the text differs: a hand-written or renamed-pipeline sidecar is rewritten though nothing was created; breaks "written only after a create or update" and "sidecar unchanged" | patch |
| 2 | Compute-unit prompt shown on a mapped deploy; its default 1 can resize the deployed pipeline | medium | `unitsFor` (~888) runs before the sidecar is read; accepting 1 against a 3-unit pipeline takes the RESOURCES_ONLY path and restarts it; the matrix puts the prompt under FIRST_DEPLOY only | patch |
| 3 | Workspace / workspace-folder save targets of the units choice untested | low | `unitsTarget` (~1274) Workspace and WorkspaceFolder branches run in no suite; the stable run is folderless | patch |
| 4 | Tagged-pipeline check silently skipped when the pipeline list fails | medium | `newTarget` (~1045) treats a failed list as no tagged pipelines and goes on to create, which can make a second pipeline for the config | patch |
| 5 | The read-only `redpanda-cloud:` document gets Run, Deploy and the Test-mapping lens | low | `when` clauses in package.json check only `activeEditorDetected`/`untitled`; bloblangLens.ts:68 excludes only `untitled`; seen every time the diff is open | patch |
| 6 | UNCHANGED log says "already runs" for a stopped or errored pipeline | low | log at ~944 ignores the state | patch |
| 7 | `deployedConfigs` entries never removed; an open diff stays on the old config after the update | low | real but rarely met; the fix adds a change event and bookkeeping | reject |

**Manual check result (user, 2026-11-03):** passed on the 1.143.1 dev host against the real organization: "tested, no issues". The log confirms the real API echoes `100m`/`400M` unchanged, so an unchanged deploy is "nothing changed", not a resize. The first create went to `STATE_ERROR` with no reason before running (the spike's intermittent error). Information messages were hidden at first by a per-source Do Not Disturb (errors only) for the extension in the test profile, not by the code.
