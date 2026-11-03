---
title: 'Start, stop and delete a pipeline, with its state and error'
type: 'feature'
ticket: '4'
created: '2026-11-03'
status: 'done'
baseline_revision: '931d0162afe8f29fcaf02d29257658e4916da057'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-5-1-findings/findings.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-deploy-again-updates-the-mapped-pipeline-plan.md
  - src/adapters/vscode/cloudView.ts
  - src/adapters/cloud/dataPlane.ts
  - src/adapters/cloud/sidecar.ts
  - src/test/helpers/fakeCloud.ts
  - src/test/integration/suites/96-cloud.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A deployed pipeline can only be created or updated from VS Code; stopping, starting or deleting it, and seeing why it failed, needs the Cloud UI.

**Approach:** **Start**, **Stop** and **Delete pipeline…** as Cloud view item actions (shown by the pipeline's state) and as palette commands; Delete needs a modal confirmation naming the pipeline and cluster. After an action the pipeline's state is followed (as Deploy does) and the view updated. Every pipeline row shows its state; an Error row shows the cluster's reason, or "the cluster gave no reason".

## Boundaries & Constraints

**Always:**
- AD-23: `PUT {dp}/v1/redpanda-connect/pipelines/{id}/start`, `PUT …/{id}/stop`, `DELETE …/{id}` (200, then a GET answers 404), through `authorizedJson` like every other call; errors shown as their `message`, masked.
- Requests only on the user's action: following a state ends at a final state (Running, Stopped, Error, Completed; for delete: the 404) or after the deploy's timeout; no background polling.
- Start is offered for Stopped, Error and Completed; Stop for Running and Starting; Delete for every state. A state the API names that the extension does not know shows its name and offers only Delete.
- Story 5.2/5.3's rules stand (masking, the fake for every test, the config file never changed).

**Never:**
- Open deployed config, Compare, Copy ID or Deploy again from the view (story 5); logs or metrics; bulk actions on several pipelines; deleting a cluster's other resources.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| STOP | Running or Starting pipeline; Stop | `PUT …/stop`; progress until Stopped; the row shows Stopped and offers Start | an API error: message, the row re-read |
| START | Stopped, Error or Completed; Start | `PUT …/start`; progress until Running or Error; the row updates | Error: its reason or "the cluster gave no reason" |
| DELETE | any state; Delete pipeline… | modal "Delete <name> on <cluster>? This cannot be undone."; on confirm `DELETE`; the row is gone | Cancel: nothing sent; 404 already gone: the row removed, said so |
| ERROR_ROW | a pipeline in Error | the row shows Error with the reason (description and tooltip), or "the cluster gave no reason" | none |
| STATES | Starting, Stopping, Completed, an unknown state | each its own label and icon; unknown: its raw name, Delete only | none |
| PALETTE | the command from the palette | the active config's mapped pipeline, else a quick pick of every pipeline | none chosen: nothing sent; a mapped pipeline gone: said so |
| DELETE_MAPPED | the deleted pipeline is the one a config's `.cloud.json` maps to | the confirmation names the sidecar; after the `DELETE`, the sidecar is deleted; the config is untouched | a sidecar naming another pipeline is left |
| STALE | the action's pipeline changed meanwhile (e.g. deleted in the Cloud) | the API's error shown; the cluster's pipelines re-read | none |

**Decisions (user, 2026-11-03):**
- The palette commands act on the pipeline the active config's `.cloud.json` maps to; with no active config or no valid mapping, a quick pick of every pipeline on the clusters.
- Deleting the pipeline a config's `.cloud.json` maps to deletes that sidecar too, and the confirmation names it. The sidecar is found from the pipeline's `rpcn-vscode/config` tag (and, from the palette, the active config); it is deleted only when it parses and names this cluster and pipeline id.

</frozen-after-approval>

## Code Map

- AD-23 (architecture doc ~:234) and findings §3 -- the three calls; stop reaches Stopped within one poll, start about 10 s; `STATE_STOPPING`/`STATE_COMPLETED` documented but unseen.
- `src/adapters/cloud/dataPlane.ts` -- add `startPipeline`, `stopPipeline` (both answer `{pipeline}`), `deletePipeline` (answer `{}`); reuse `pipelineFrom`, `pipelineStateText`, `FINAL_STATES`.
- `src/adapters/vscode/cloudView.ts` -- the pipeline item (~:771–776) already sets `contextValue = cloudPipeline state-<state>` and shows the Error reason; add the actions, reusing the deploy's follow loop (`createAndFollow`'s poll part: `pollMs`, `timeoutMs`, `MAX_POLL_FAILURES`), `upsertPipeline`, `loadPipelines`, `ui.confirm`, `ui.progress`, `report`-style messages. Register `redpandaConnect.cloud.start`, `.stop`, `.delete` next to the others (~:281). For the palette, a pipeline quick pick on `CloudUi` (replaceable in tests). Unknown states map to `state-unknown`.
- `src/adapters/cloud/sidecar.ts` -- `sidecarPath`, the parser; needed for the palette target or the sidecar on delete, per the answers.
- `package.json` -- the three commands (palette `when`: connected); `view/item/context` and inline icons on `viewItem =~ /cloudPipeline state-(stopped|error|completed)/` (Start), `/state-(running|starting)/` (Stop), `/^cloudPipeline/` (Delete, last group).
- `src/test/helpers/fakeCloud.ts` -- `PUT /{id}/start`, `/stop` (state sequences like create's), `DELETE` (then 404); a per-call failure hook.
- `src/test/integration/suites/96-cloud.ts` -- every matrix row; package.json menus asserted as the 5.2 test does.
- `README.md` Redpanda Cloud section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/cloud/dataPlane.ts` + unit tests -- start, stop, delete.
- [x] `src/test/helpers/fakeCloud.ts` -- the three routes.
- [x] `src/adapters/vscode/cloudView.ts`, `package.json` -- actions, commands, menus, state labels.
- [x] integration tests for every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a running pipeline in the view, when it is stopped, started and deleted from its row, then the fake received `PUT …/stop`, `PUT …/start` and one `DELETE` for that id, in that order, and the row ends gone.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass.

## Implementation Notes

- Command titles are **Start pipeline** / **Stop pipeline** / **Delete pipeline…** (not bare "Start"/"Stop"), so the palette entries do not read like Run's existing **Stop**.
- The palette quick pick lists every pipeline on the clusters; one whose state does not offer the action (e.g. Start on a running pipeline, also via the mapping) is refused with a message and nothing is sent (`notOffered`).
- Following a start or stop reuses the deploy's `follow`, generalized from "restart" to "the state it was in" (`{ from, waiting }`): an answer still in the old state does not end the follow until another state is seen or `restartGraceMs` passes. The real API answers `STOPPING` / `STARTING` (captures 41, 53), so this is a safeguard.
- Delete: after the `DELETE` (200), GETs every `pollMs` until a 404 (or the timeout: "being deleted", the list re-read). The mapping is deleted after an accepted `DELETE` and also when the `DELETE` answers 404 (already gone), re-checked right before it is removed.
- Mapping candidates: `sidecarPath` of the `rpcn-vscode/config` tag (absolute as is; relative joined with each workspace folder) and, from the palette, of the active config.

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: Stop `vscode-tracer` from its row (Stopped), Start it (Running), the palette commands, then Delete it (confirmation; gone from the view and the Cloud UI).

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | Starting and Stopping share one icon; STATES says each its own | low | `stateIcon` returns `sync~spin` for both; the test pins it | patch |
| 2 | A failure while following start/stop is reported as the action failing; a 401 while polling offers no Connect | medium | `startOrStop` `case 'failed'` handles `follow`'s "could not read its state" like a refused `PUT`; `cause` unset on that path (delete keeps them apart) | patch |
| 3 | The palette quick pick shows the cluster's Error reason unmasked | medium | `defaultCloudUi.pickPipeline` (~:179) builds descriptions from `pipelineStateDescription` outside `this.mask`; the tree masks the same text | patch |
| 4 | start/stop follow from the view's cached state, not the server's | medium | `from: pipeline.state` (~:1496) comes from the last list; a stale Stopped row over a real Error ends the follow on the old Error or waits the grace on an unchanged state | patch |
| 5 | A raw unknown state is lowercased in older messages (`state_paused`) | low | `pipelineStateText(...).toLowerCase()` at ~:1030, ~:1043, ~:1354, ~:1494; `stateWord` does it right | patch |
| 6 | (triage) The `.cloud.json` lookup from the tag accepts an absolute or `..` path outside the workspace | low | `mappingsOf` (~:1536) adds `sidecarPath(tag)` for an absolute tag; the tag comes from the Cloud; only a parsing mapping with the same ids is deleted, but nothing outside the workspace should be touched | patch |

**Manual check result (user, 2026-11-03):** passed on the 1.143.1 dev host against the real organization: "tested, no issues" (stop and start from the row and the palette, delete with the confirmation, the mapped `.cloud.json` removed).
