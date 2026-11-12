---
title: 'Deploy names: the tag carries no local path and each file keeps its own mapping'
type: 'bugfix'
ticket: '47'
created: '2026-11-11'
status: 'built'
baseline_revision: 'fcc5b43fabfc2c298c53421e94fcadf178072afd'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Deploy tags a pipeline with `asRelativePath(uri, false)`: for a file outside every workspace folder that is its absolute local path (with the user name), sent to Redpanda Cloud; in a multi-root workspace `a/orders.yaml` and `b/orders.yaml` get the same tag, and the row's file, Compare, Deploy again and Deploy's tagged offer can resolve to the wrong folder's file. The mapping is `<stem>.cloud.json`, so `orders.yaml` and `orders.yml` in one folder share one mapping (epic 5 retrospective C3, C7; bug 47).

**Approach:** The tag never holds a local path and names the workspace folder in a multi-root workspace; every reader resolves a tag to one file or asks; each config gets its own mapping, with mappings and tags written before the fix still working.

**Decisions (user, 2026-11-11, the recommended options):** a file outside every folder is tagged with its base name; the tag is `<folder name>/<path>` in a multi-root workspace only (one-folder workspaces keep today's tags); new mappings are `<file name>.cloud.json`, an old `<stem>.cloud.json` is read when only one config could own it and is never renamed.

**Decision (user, 2026-11-11):** from the epic 5 retrospective's recommendations; the review runs the adversarial and edge-case lenses (epic 6 retrospective AI-6).

## Boundaries & Constraints

**Always:** no absolute path or user name in any request body; a pipeline and mapping made before the fix keep working for their one config; every path that changes or deletes a pipeline still checks the mapping's cluster and pipeline ids; every other Deploy and Cloud view behavior as today.

**Never:** bug 48's cases (translation, Compare's text); renaming or deleting a user's existing mapping file except where Delete already does; a new dependency; a floor (1.100.0) run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OUTSIDE | Deploy of a file outside every workspace folder | the tag is the file's base name; no absolute path or user name in the request; the row's file resolves it only when one workspace file has that name | as today |
| ONE_FOLDER | a one-folder workspace, `pipes/orders.yaml` | the tag is `pipes/orders.yaml`, as today | none |
| MULTI_ROOT | folders `a` and `b`, each with `orders.yaml`, each deployed | the tags are `a/orders.yaml` and `b/orders.yaml` (`<folder name>/<path>`, in a multi-root workspace only); the row's file, Compare, Deploy again and Deploy's tagged offer resolve each to its own folder's file | none |
| OLD_TAG_ONE | a pipeline whose old tag matches one file | resolved to it, as today | none |
| OLD_TAG_TWO | an old tag (no folder) that matches files in two folders | never resolved silently: the row's file says it is in more than one folder, Compare and Deploy again ask which, Deploy's tagged offer is not made for it | none |
| TWO_EXTS | `orders.yaml` and `orders.yml` in one folder, each deployed | each keeps its own pipeline and its own mapping, `orders.yaml.cloud.json` and `orders.yml.cloud.json` (`<file name>.cloud.json` for new mappings) | none |
| OLD_MAPPING | a config with a mapping written before the fix, no other config sharing its name | Deploy, Deploy again, Delete and the palette find it and act on the same pipeline as today; it is never renamed | none |
| OLD_MAPPING_SHARED | an old `<stem>.cloud.json` that two configs could own | it is not used for either without a message naming the file | none |

</frozen-after-approval>

## Code Map

- `src/adapters/cloud/dataPlane.ts` -- `CONFIG_TAG = 'rpcn-vscode/config'` :54 (comment :53); create body :202-208 (no description), update :216-224 (the Cloud's own description).
- `src/adapters/vscode/cloudDeploy.ts` -- `rel = asRelativePath(doc.uri, false)` :183 (multi-root drops the folder; outside a folder it is `fsPath`); create tags :253, update `{...deployed.tags, [CONFIG_TAG]: rel}` :327 (every update rewrites the tag, so old tags take the new format on the next Deploy); mapping read and `mapTo`/`writeMapping` :184-186, :238-242 (write skipped when ids match :239); tagged offer `p.tags[CONFIG_TAG] === rel` :655, message :660; `newTarget`/`mappedTarget` :195-202, :640, :683, :699.
- `src/adapters/cloud/sidecar.ts` -- `sidecarPath` :16-23 (`<dir>/<stem>.cloud.json`); `taggedConfigs(tag, folders)` :72-85 (`path.resolve(folder, tag)` in every folder, both returned for two folders); `taggedSidecars` :88-90; comments :1, :16, :67-71.
- `src/adapters/vscode/cloudView.ts` -- `workspaceFolders()` :509-510 (test seam); `localFileOf` :1250-1262 (first file wins); row label, tooltip, context :1214-1228; comment :23.
- `src/adapters/vscode/cloudActions.ts` -- `localFileFor` :530-539; Compare :542-556; Deploy again :560-571 (refuses a file whose mapping names another pipeline); `mappingsOf` :303-317 and the remove :407-411 (ids checked :590); palette target :151-156. `src/adapters/vscode/cloudLogs.ts` :478, :487; `cloudShared.ts` `readMapping` :34.
- Docs: `README.md:88,90,92,94`; `CHANGELOG.md`.
- Tests: `src/test/integration/suites/96-cloud.ts` (`sidecarFile()` :177; the folders seam saved :226, restored :318, :344, set :1776, :1835, :1913, :1968; DEPLOY :450 asserting the tag :465; UPDATE_RUNNING :765, :806; TAGGED :921-927; ROW_FILE :1810-1838; RETAGGED 45 :2362, :2375; mapping tests FIRST_DEPLOY :736, MAPPED_GONE :876, BAD_SIDECAR :901, hand-written :954, DELETE_MAPPED :1677, PALETTE :1709, :1749, DEPLOY_AGAIN :1921); `97-logs.ts` builds `${name}.cloud.json` :1082, :1115, :2795; unit `src/test/adapters/cloud/update.test.ts:12-16`, `lifecycle.test.ts:65-75`; multi-root `src/test/integration-multiroot/index.multiroot.ts` (loads settings and environment only; workspace `test/multiroot/multiroot.code-workspace`, folders `a`, `b`) — a Cloud multi-root suite starts the fake cloud as `96-cloud.ts` does; `src/test/helpers/fakeCloud.ts` stores tags as given (:436-451, :488-501).
- Note: the stable integration run opens no folder, so today every Deploy in `96-cloud.ts` sends an absolute temp path as the tag; tests that assert the tag change with OUTSIDE (Plan Change Log).

## Tasks & Acceptance

**Execution:**
- [x] `cloudDeploy.ts`, `dataPlane.ts` -- the tag per OUTSIDE / ONE_FOLDER / MULTI_ROOT; the tagged offer by folder.
- [x] `sidecar.ts`, `cloudView.ts`, `cloudActions.ts`, `cloudLogs.ts` -- resolve a tag to one file (new and old formats), ask or say when it matches two; the mapping name per TWO_EXTS with OLD_MAPPING and OLD_MAPPING_SHARED.
- [x] tests per matrix row: integration in `96-cloud.ts`; the multi-root rows in a new Cloud suite of the multi-root run; unit `update.test.ts`, `lifecycle.test.ts`; existing tag and mapping assertions updated (Plan Change Log).
- [x] `README.md`, `CHANGELOG.md` -- the tag and the mapping name.

**Acceptance Criteria:**
- Given the change, when a matrix row's fix is removed, then its test fails.
- Given the existing Deploy, delete, Compare and Deploy again tests that use one config per name, when the suites run, then they pass with only their tag or mapping-name assertions updated.

## Implementation Notes

- `sidecar.ts`: `configTag(file, folders)` makes the tag (innermost containing folder; posix separators; base name outside every folder; `<folder name>/<path>` only when there is more than one folder). `taggedConfigs` takes `WorkspaceRoot` (`{ name, path }`) and returns every file a tag could name: the `<folder name>/<path>` reading first, then the old reading in every folder (relative, or absolute inside one). `sidecarPath` is now `<file name>.cloud.json`; `legacySidecarPath` gives the old `<stem>.cloud.json` (undefined when equal, e.g. no extension); `legacyOwnersOf` gives the configs that could own it: the config itself and `<stem>.yaml`, `<stem>.yml` beside it. `taggedSidecars` removed.
- `cloudShared.ts`: `filesOfTag` (the existing files a tag names), `findMapping(config)` (`own`: the new file if it exists, else the old one if it exists and no other owner is a file, else the new name; `shared`: only the old one exists and another owner exists), `sharedMappingText`, `IN_SEVERAL_FOLDERS` ("in more than one folder").
- The folders seam `CloudView.workspaceFolders` now returns `{ name, path }[]` and Deploy makes the tag from it too (before: `asRelativePath`), so the tag and its resolution use the same folders.
- Row's file: exactly one existing file resolves; more than one is `ambiguous` (row "· in more than one folder", tooltip lists the paths, ` hasFile` kept so Deploy again is offered). Compare and Deploy again ask with `ui.pickChoice`, the choices shown as each file's new-format tag (`a/orders.yaml`); Escape: `notStarted`, nothing sent.
- Deploy's tagged offer (`taggedWith`): the tag's files in the workspace are exactly this file; a tag naming no workspace file matches when it equals this file's new tag (outside every folder: the base name) or is this file's absolute path (what an older deploy sent for a file outside the folders). An update rewrites the tag in the new format, as before.
- Old mapping: read and, when a deploy rewrites it (gone pipeline, Deploy as new), written in place (never renamed). Shared old mapping: Deploy shows `<old> could map orders.yaml or orders.yml, so it is not used for orders.yaml. Deploy orders.yaml without it? Its mapping is then orders.yaml.cloud.json; orders.cloud.json is not changed.` with **Deploy without it** (then the normal no-mapping flow with the tagged offer); Deploy again and the row's Deploy again explain and send nothing; the palette says so and goes to the pick; Delete does not name or delete it (logged when it names the pipeline).
- Multi-root suite `src/test/integration-multiroot/suites/cloud.ts` (MULTI_ROOT, OLD_TAG_TWO, OLD_TAG_ONE) writes `orders-47.yaml` and `only-a-47.yaml` into the fixture folders and removes them and their mappings after.
- Review fixes (2026-11-11): the old mapping's owners now include the bare `<stem>` and are deduplicated by `(dev, ino)`; the mapped pipeline's tag decides between owners (`mappedTagOf`, from the cluster's list); the shared message names the fix; a mapping written fresh always takes `<file name>.cloud.json`; a file outside every folder matches its tagged pipeline by base name or old absolute path directly (`tagNames`); `taggedConfigs` reads a multi-root tag led by a folder's label or name (longest first, `/` allowed in names) only in that folder, and a first segment naming no folder also as the rest in every folder (in a one-folder workspace only when it is the folder's name); folders sharing a name are tagged `<name>#<n>/…` (`folderLabel`); the row's pick carries each file and adds the path to a label only if two would read the same.

## Plan Change Log

- Review round (2026-11-11), existing assertions changed: `lifecycle.test.ts` `taggedConfigs('pipes/orders.yaml', [w, v])` now also lists `w/orders.yaml`, `v/orders.yaml` (a first segment naming no open folder is also read as another workspace's folder name); its MULTI_ROOT test now expects `a/orders.yaml` to name only `a`'s file (the folder-led reading alone). `update.test.ts` `legacyOwnersOf` expectations include the bare `<stem>`. `96-cloud.ts` OLD_MAPPING_SHARED: the expected message names the fix, the mapped pipeline is untagged (so its tag cannot decide), the Delete check goes through the palette, and Deploy without it creates a new pipeline (Create new on the offered tagged `copy`) followed by an unchanged Deploy. `97-logs.ts` `openConfig` writes `<name>.yaml.cloud.json` (messages now name `gone.yaml.cloud.json`, `bad.yaml.cloud.json`); PALETTE_GONE keeps the old `moved.cloud.json`.
- Tag and mapping-name assertions updated in `96-cloud.ts` (as the Code Map's note foresaw): `sidecarFile()` is `orders.yaml.cloud.json`; messages naming `orders.cloud.json` now name `orders.yaml.cloud.json`; tags asserted as `asRelativePath(doc.uri, false)` (an absolute temp path in the stable run) are now `orders.yaml`; the "deployed from <absolute path>" messages of COMPARE and DEPLOY_AGAIN now say "deployed from orders.yaml". The folders seam is set as `[{ name, path }]`. `lifecycle.test.ts`'s `taggedSidecars` test removed with the function; its cases moved into `taggedConfigs`'s. `97-logs.ts`'s hand-written `<name>.cloud.json` mappings are unchanged: they are now read as old mappings with one owner (OLD_MAPPING), and their messages still name them.
- OUTSIDE's "the row's file resolves it only when one workspace file has that name" is read as: the base-name tag resolved against the workspace folders' roots (as any tag is) gives exactly one file; the whole workspace is not searched for files of that name (the row is drawn synchronously).

## Review Triage Log

Thorough review (2026-11-11; blind-hunter, edge-case-hunter, verification-gap, intent-alignment): 0 high, 5 medium and 14 low patched, 4 rejected, 1 deferred. All patches sent to the implementer in one message.

| # | Finding | Lenses | Verdict | Route |
|---|---------|--------|---------|-------|
| 1 | An extensionless `orders` gets `orders.cloud.json`, the old mapping of `orders.yaml`; the bare stem (and other `<stem>.<ext>` configs) are not owners, so the two share it and one can update or delete the other's pipeline | blind, edge ×3 | medium | patch (owners include the bare stem and yaml/yml siblings; case-only duplicates deduped) |
| 2 | An outside file's own base-name tag is resolved to a same-named workspace file, so its pipeline is not offered and Deploy creates a duplicate | edge | medium | patch (an outside config matches its own tag directly) |
| 3 | A new-format tag is also read as an old one: false "in more than one folder" when a folder holds a subdirectory named like another folder | blind | medium | patch (a leading folder name resolves only that way in multi-root) |
| 4 | Two folders with the same name get the same tag; the pick's identical labels map to the first path | blind, edge ×2, vgap | medium | patch (a unique tag when names repeat; the pick carries the path) |
| 5 | A mapping written fresh (pipeline gone, bad mapping) still goes to the old name | blind | medium | patch (`<file name>.cloud.json`; the old file left as it is) |
| 6 | The shared-mapping message gives no way out; the pipeline's tag could decide the owner | blind | low | patch |
| 7 | Folder names with `/` split at the first slash | edge | low | patch |
| 8 | A multi-root tag whose folder name matches no open folder | edge | low | patch (fall back to the rest in every folder) |
| 9 | No test: Deploy's offer for an old absolute tag, and its rewrite | vgap, intent | low | patch (test) |
| 10 | No test: both mappings exist after "Deploy without it" | vgap | low | patch (test) |
| 11 | No test: an unparsable old mapping with one owner | blind | low | patch (test) |
| 12 | `97-logs.ts` writes old-name mappings, so the current name is untested there | blind | low | patch |
| 13 | The multi-root fixtures can be left behind by an aborted run | blind | low | patch (cleared in setup; git-ignored) |
| 14 | CHANGELOG: old tags stay until the next Deploy; "Deploy without it" not named | blind | low | patch |
| 15 | README: outside files are matched by base name only | blind, edge | low | patch |
| 16 | A long header comment; an import order | blind | low | patch |
| 17 | Case-insensitive file systems double-count an owner | edge | low | patch (with 1) |
| 18 | An outside file's base-name tag resolves to an unrelated same-named workspace file in the row, Compare and Deploy again | blind, edge, edge claim, intent | low | reject: the frozen OUTSIDE row and the user's decision say the row resolves it when one workspace file has that name; the README states it (patch 15) |
| 19 | Outside files with the same base name in unrelated projects are offered each other's pipelines | edge | low | reject: an offer, never an action; the user picks Create new |
| 20 | Deploy leaves an ambiguous old tag out of its offer rather than asking | intent | low | reject: the frozen OLD_TAG_TWO row says exactly that |
| 21 | The folder name goes into the tag as it is | intent | low | reject: the user's decision names the folder in the tag |
| 22 | No test: the logs pick's "in more than one folder" text | vgap, blind | low | defer: display only, nothing sent |

## Verification

**Commands:**
- `npm run compile` -- expected: 0, lint included.
- `npm run test:corpus`; `npm run test:webview` -- expected: pass.
- `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); then `--label multiroot` -- expected: all pass. No floor run.

**Result (2026-11-12, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 381, stable 1459 passing, 1 pending, 0 failing, multi-root 14 passing (the new Cloud multi-root suite among them); the test settings clean; `test/multiroot` clean after the run; no floor run.

**Manual checks:**
- Dev host 1.143.1 on the user's cluster: Deploy a file opened outside the workspace (the pipeline's tag in the Cloud UI shows no local path); in the test workspace, `orders.yaml` and `orders.yml` each deployed keep their own pipeline.

**Results (2026-11-11, uncommitted working tree on fcc5b43):**
- `npm run compile`: 0 (types and lint clean). `test:corpus` 182 passed; `test:webview` 381 passed.
- Stable (VS Code 1.146.0, alone): 1451 passing, 1 pending, 1 failing: "Bloblang test panel (integration, 4.2) OFFER + ACCEPT + REORDER_AFTER + AI-7 (4.16)" timed out at 90 s after the extension host was reported unresponsive (log line "Extension host ... is unresponsive"). Unrelated to this change; re-run alone (`--label stable --grep "Bloblang test panel"`): 104 passing. All 96-cloud tests passed, the four new bug 47 tests among them.
- Multi-root: 14 passing (the new Cloud suite's MULTI_ROOT, OLD_TAG_TWO, OLD_TAG_ONE among them); the fixture folders hold only their tracked `pipe.yaml` and `.env` afterwards.
- Manual checks: not run (they need the user's cluster on the 1.143.1 dev host).

**Review round (2026-11-11):** `npm run compile` 0. Stable `--grep` the Cloud view and Deploy, Cloud unit and Pipeline logs (6.2) suites: 226 passing, 1 failing (the widened `taggedConfigs` assertion, then updated; `Cloud start, stop and delete` re-run: 9 passing). Multi-root: 14 passing. The wider runs are the coordinator's.

