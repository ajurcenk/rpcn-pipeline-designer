---
title: 'The Cloud view: the deployed config, Compare, Deploy again and Copy ID'
type: 'feature'
ticket: '5'
created: '2026-11-04'
status: 'in-review'
baseline_revision: '7669f0069b7efd0fbc50d886a948238c55ae632f'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-start-stop-and-delete-a-pipeline-with-its-state-and-error-plan.md
  - src/adapters/vscode/cloudView.ts
  - src/adapters/cloud/sidecar.ts
  - src/test/integration/suites/96-cloud.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Cloud view lists clusters and pipelines with their state and offers Start, Stop and Delete (5.2–5.4), but a deployed pipeline's config can only be seen through a deploy's diff, the local file it came from is only in a tooltip, and nothing in the view compares, redeploys or copies its id.

**Approach:** Each pipeline row shows the file it was deployed from (its `rpcn-vscode/config` tag) in its description, as the design board does ("Running · orders.yaml"). Clicking a row opens its deployed config read-only (read fresh from the Cloud). The row's menu gains **Open deployed config**, **Compare with <file>** (deployed, read-only ↔ the local file, editable), **Deploy <file> again** and **Copy pipeline ID**, beside 5.4's Start, Stop and Delete.

**Decisions (user, 2026-11-04):**
- Compare's right side is the local file itself (editable); `${VAR}` against the deployed `${secrets.VAR}` shows as a difference.
- A single click on a pipeline row opens its deployed config read-only.

## Boundaries & Constraints

**Always:**
- The deployed config comes from `GET {dp}/v1/redpanda-connect/pipelines/{id}` at the moment of the action, through `authorizedJson`; it is shown in the existing read-only `redpanda-cloud:` documents, never written to disk.
- The local file is found from the tag inside the workspace folders only (`taggedSidecars`' rule, 5.4); an absolute tag outside them, or a file that does not exist, is "not in this workspace": the description says so, and Compare and Deploy again explain it instead of acting.
- Deploy again acts on this pipeline only: it runs the normal Deploy of the file when the file's `.cloud.json` maps to this cluster and pipeline; otherwise it explains (the mapping names another pipeline, or there is none) and sends nothing.
- Requests only on the user's action; every message masked; 5.2–5.6 rules stand.

**Never:**
- Editing the deployed config in place; a compare of two deployed pipelines; logs or metrics; changing Start, Stop or Delete.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ROW_FILE | a pipeline tagged with a workspace file | description "Running · orders.yaml" (the file's name; the tooltip has its path) | tag outside the workspace or file missing: "· not in this workspace"; no tag: the state only |
| OPEN | click the row, or Open deployed config | a fresh GET; a read-only editor titled "<name> (deployed)" with its `config_yaml` | 404: "the pipeline is gone", the cluster's pipelines re-read; other errors: the API's message |
| COMPARE | Compare with orders.yaml | diff: deployed (read-only) ↔ the local file (editable), titled "<name> (deployed) ↔ orders.yaml" | file not in the workspace: said so, nothing opened |
| DEPLOY_AGAIN | Deploy orders.yaml again; its `.cloud.json` maps to this pipeline | the normal Deploy of the file (5.3's update flow) | mapping to another pipeline or none: explained, nothing sent; file not in the workspace: said so |
| COPY_ID | Copy pipeline ID | the id on the clipboard; "Copied the ID of <name>" | none |
| MENUS | each pipeline state | Open, Compare and Copy ID for every state; Deploy again when the row has a workspace file; Start/Stop/Delete as 5.4 | none |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudView.ts` pipeline item (~:840 `case 'pipeline'`) -- add the file to `description` and an `item.command` (open deployed config); a context-value flag (e.g. `hasFile`) for Deploy again and Compare, keeping 5.4's `cloudPipeline state-<key>` prefix so its `when` regexes still match. The provider (`registerTextDocumentContentProvider(DEPLOYED_SCHEME …)`, `deployedConfigs`, `deployedConfigUri`) and `showDiff` exist; reuse them. `readPipeline` (~:1206) for the fresh GET; `deploy(uri)` (~:949) for Deploy again; the `.cloud.json` reading (`readMapping`) to check the mapping first.
- `src/adapters/cloud/sidecar.ts` `taggedSidecars` -- resolves a tag inside the workspace folders; derive the config path the same way (a sibling helper if needed, unit-tested).
- `package.json` -- commands `redpandaConnect.cloud.openDeployed`, `.compare`, `.deployAgain`, `.copyId` (hidden from the palette: they need a row), `view/item/context` entries and groups (open/compare/deploy again, copy, then 5.4's delete group last), an inline icon for Open.
- `src/test/integration/suites/96-cloud.ts` -- every matrix row; the menus' `when` regexes against each context value, as 5.4's menu test does; the clipboard via `vscode.env.clipboard`.
- `README.md` Redpanda Cloud section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/cloud/sidecar.ts` + unit test -- the tag's config path inside the workspace.
- [x] `src/adapters/vscode/cloudView.ts`, `package.json` -- row description and click, the four commands, menus.
- [x] `src/test/integration/suites/96-cloud.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a deployed pipeline whose tag names a workspace file, when its row is clicked, then a read-only editor shows the config the fake holds for it at that moment.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass.

## Implementation Notes

- Menu titles are static in VS Code, so the row commands read **Compare with local file** and **Deploy local file again** (not "Compare with orders.yaml"); the diff's title names the file ("<name> (deployed) ↔ orders.yaml").
- `taggedConfigs` (sidecar.ts) gives the tag's config paths inside the workspace folders; `taggedSidecars` is built on it. A row's file is the first of them that is a file (checked on each render).
- Context value `cloudPipeline state-<key>[ hasFile]`; 5.4's Start/Stop regexes changed from `$` to `\b` so they still match with the suffix.
- Open deployed config uses its own URI (`…/<name> (deployed)`, language set to YAML) so its tab reads "<name> (deployed)"; Compare uses the deploy diff's `deployedConfigUri` on the left and the `file:` URI on the right. A re-open waits (≤2 s) until the open document shows the fresh text.
- Test seam `CloudView.workspaceFolders` (the stable run opens no folder); 5.2 tests' pipeline rows now read "… · not in this workspace" there, as the matrix says.

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: a deployed pipeline's row shows its file; click opens the deployed config; Compare shows the diff with the file editable; Deploy again runs the update; Copy pipeline ID puts the id on the clipboard.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | README's Service account paragraph lists when Redpanda Cloud is contacted and misses the row click, Open, Compare and Deploy again | low | README ~:82 unchanged; `readNow` → `readPipeline` sends a GET for each | patch |
| 2 | The placeholder for an unloaded `redpanda-cloud:` document says "Open it again from the Cloud view", wrong for a restored "as sent" side and for a restored diff's left side | low | `provideTextDocumentContent` serves `DEPLOYED_NOT_LOADED_TEXT` for every unloaded URI; Open uses another URI | patch |
| 3 | A row's file and `hasFile` go stale when a folder or the tagged file is added or removed | low | computed on render only; no folder or file listener; Compare and Deploy again re-check when run; the fix adds watchers | reject |
| 4 | Deploy again can create a different pipeline: `deploy()`'s `mappedTarget` offers "Create a new pipeline" when the pipeline (or cluster) is gone by then | medium | `deployAgain` hands off to the full `deploy(uri)`; breaks "acts on this pipeline only … otherwise explains and sends nothing" | patch |
| 5 | A row command with no account says "no longer in the Cloud view" instead of offering Connect | low | `rowAction` guard returns one message for four causes; `deploy` offers Connect | patch |

