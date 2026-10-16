---
title: 'Test panel tabs, rename and placement'
type: 'feature'
ticket: '17'
created: '2026-10-15'
status: 'built'
baseline_revision: 'f3b66b3385725609a2195dbfb30ec0d67528bc34'
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

**Problem:** A test panel outlives its file's last tab and ignores renames. After a rename it keeps the old key, title and file names, and its samples file is left behind under the old name. It also opens `Beside` wherever the active group is, so it can land in the graph's locked group's place and block the graph's lock (E4 R8, AD-1 "4.10/4.17 settles its group").

**Approach:**
- **Tabs and rename:** reuse the graph's tab and rename logic (`src/adapters/graphPanel/tabs.ts`), so a panel closes with its file's last text tab and follows a rename. The config's samples file is renamed with it.
- **Placement:** test panels open in one group below the graph's locked group, shared by all test panels.

**Decision (user, 2026-10-15):** test panels go in a group below the graph.

## Boundaries & Constraints

**Always:**
- **Close with the last tab:**
  - A test panel closes once its file had a text tab and has none left, as the graph does (`hadTab` and `hasTextTab`).
  - It doesn't close while a rename of that file, or of a folder holding it, is pending.
  - Closing the panel clears its hint and disposes its samples watch, as today.
- **Rename (`onWillRenameFiles` / `onDidRenameFiles`, including folder renames, through `renamedThrough`):**
  - **Panel:** each panel of a renamed config moves to the new URI: key, title (`Bloblang: <label ?? path>` is unchanged, but the page title follows), hint, samples watch, dirty-set entry and tracking. The panel is not reset and not reopened.
  - **Dirty-file rename:** the close of the old document caused by the rename must not reset the panels (4.10's reset on close is skipped while that rename is pending).
  - **Collision:** if a panel lands on a key another panel already has, the incoming one closes, as the graph handles it.
  - **Webview:** it gets the new file and samples-file names through the snapshot (new optional `fileName`, `samplesFile`), which it prefers over the page's `data-` attributes.
  - **Samples file:** `old.samples.json` is renamed to the new config's `samples.json` in the same folder as the new config. Only when renaming a single file (a folder rename moves it anyway). Only when the old one exists and the new one doesn't. If the new one exists, both are left and the info message "Samples weren't moved: <new name> already exists." is shown. The store's caches follow the new names.
- **Placement:**
  - **Test group:** a group holding a test panel and no text editors or graph.
  - **Opening:**
    1. a test group exists: open there;
    2. the file's graph is open: create a group below the graph's group (`workbench.action.newGroupBelow` with the graph's group active) and open there;
    3. no graph: open `Beside` the YAML, as today.
  - **Focus:** returns to the YAML editor afterwards (`preserveFocus` as today).
  - **Graph opened later:** if the group the graph would take holds only test panels, the graph is opened in a new group above it instead (`workbench.action.newGroupAbove`), and its lock works as before (AD-1 lock rules unchanged).
  - **Never:** a test panel never goes into the graph's group.
- **AI-8:**
  - AD-1 is amended (the test group below the graph, tab close, rename, the samples file);
  - AD-5 (snapshot fields) and AD-22 (the rename) are amended;
  - EXPERIENCE gains the placement and close/rename row;
  - CHANGELOG is updated.

**Never:**
- changing the graph's lock rules or its own tab/rename behaviour (only the column it picks when the test group is in the way);
- protocol changes beyond the two optional snapshot fields;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| TAB_CLOSE | file in two groups; close one tab, then the last | panel stays, then closes; hint gone | none |
| RENAME | rename `a.yaml` → `b.yaml` (WorkspaceEdit) with a panel and samples | same panel under `b.yaml#path`; snapshot `fileName: b.yaml`; `a.samples.json` is now `b.samples.json`; samples still shown | none |
| RENAME_DIRTY | rename with unsaved edits above the processor | panel stays on its processor (no reset) | none |
| RENAME_FOLDER | the config's folder renamed | panel follows; samples file moved with the folder | none |
| RENAME_TARGET_EXISTS | `b.samples.json` already exists | both files left; info message; panel shows `b`'s file | none |
| COLLISION | rename onto a file whose same processor has a panel | the incoming panel closes | none |
| PLACE_WITH_GRAPH | graph open, open a test panel | new group below the graph; graph group holds only graphs; YAML focused | none |
| PLACE_SECOND | a second test panel (same or other file) | same test group | none |
| PLACE_NO_GRAPH | no graph | `Beside` the YAML | none |
| GRAPH_AFTER | test group beside the YAML, then Show graph | graph in a new group above the test group; graph group locked | none |

</frozen-after-approval>

## Code Map

- `src/adapters/bloblangPanel/panels.ts`:
  - `uri` is `readonly` (ctor, :244). Make it mutable; `key` (:678) follows.
  - **Hints:** they hold the uri (`hints.set(hintKey, uri, line)` :396/:674/:706; `hint.ts:19-44`), so re-set them under the new uri.
  - **Samples watch:** `owner.samples.watch(uri)` (:259). Dispose it and watch the new uri.
  - **Dirty set:** `dirty` (:717) is re-keyed.
  - **4.10 close reset:** the handler at :763-769 is skipped for a pending rename's `from`.
  - **Subscriptions:** add `tabGroups.onDidChangeTabs`, `onWillRenameFiles` and `onDidRenameFiles`.
  - **`show()` (:985-1030):** the placement replaces `ViewColumn.Beside` (:1004). The html's `data-file`/`data-samples` (:1024) stay for the first paint.
  - The snapshot gains `fileName`/`samplesFile`.
- `src/adapters/graphPanel/tabs.ts` -- reuse `Rename`, `within`, `renamedThrough`, `until`, `hasTextTab`, `isTextTabOf`, `openDocument` as they are.
- `src/adapters/graphPanel/panels.ts`:
  - model: `tabsChanged` (:312-321), `renamed` (:329-390) and its collision handling (:348-351);
  - `graphColumn` (:576-592): when the column it would pick holds only test panels (`BLOBLANG_VIEW_TYPE`), open above it with `newGroupAbove`. `lock`/`onlyGraphs` (:68, :602-724) are unchanged.
- `src/adapters/bloblangPanel/sampleStore.ts` -- `samplesUri` (:50), plus `seen` (:83), `queues` (:85) and `watched` (:87), which follow a rename. Add the samples-file rename: `workspace.fs.rename` with no overwrite, run from `onDidRenameFiles` for single-file renames.
- `src/shared/bloblangProtocol.ts:84-97` (+ test, fixture) and `webview/src/bloblang/main.tsx:12` / `TestPanel.tsx:104-107,231,548,577,634` -- the snapshot's names win over the props.
- Tests:
  - `src/test/integration/suites/90-bloblang-panel.ts` -- the matrix.
    - TAB_CLOSE and RENAME follow `84-graph-auto-open.ts:341,369`: `tabGroups.close`, `WorkspaceEdit.renameFile`, `waitFor`.
    - Placement is asserted with `tabGroups.all` and `viewColumn`.
    - Keep BOUNDARY 3.1+3.10 (:724); add GRAPH_AFTER.
  - Suite 84 must stay green unchanged.
  - AI-7: RENAME combined with 4.10 tracking (rename a dirty file, then save, then relink).
- Docs:
  - `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` (AD-1 :42-49, AD-5 :80, AD-22);
  - `ux-rpcn-vscode-designer/EXPERIENCE.md` (beside :35 and the test-panel rows);
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] Protocol fields + webview use + tests.
- [x] `panels.ts` (bloblang) -- tab close, rename, placement.
- [x] `sampleStore.ts` -- samples-file rename, cache re-keys.
- [x] `graphPanel/panels.ts` -- the graph above a test group.
- [x] Suite 90 -- the matrix.
- [x] Docs.

**Acceptance Criteria:**
- Given the dev host with the graph open, when the user opens two test panels, renames the file, and closes its tab, then both panels sit in one group below the graph, follow the rename with their samples, and close with the tab.
- Given the change, when `npm run compile`, `npm test` (stable), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- **Shared group helpers:** `src/adapters/graphPanel/groups.ts` (new) holds both view types (`GRAPH_VIEW_TYPE`, `BLOBLANG_VIEW_TYPE`, re-exported from both registries unchanged), `holdsGraph`, `onlyTestPanels`, `isTestGroup` and `newGroupNextTo(column, 'below' | 'above')`, which makes the group active with `workbench.action.focus<Nth>EditorGroup` (groups 1–8; `ViewColumn` follows the same grid order) and runs `newGroupBelow` / `newGroupAbove`, waiting (1 s) for a new, empty active group. `tabs.ts` is reused unchanged.
- **Focus return:** the YAML's column is read again after the new group exists: a group created below a graph group left of the YAML renumbers the columns after it.
- **Case-only renames:** for `orders.yaml` → `Orders.yaml` (`caseOnlyRename`) the "new one exists" check is skipped and the file service decides (it allows the move on a case-insensitive file system, and its `FileExists` is `'exists'`). A cache `rekey` copied to the new samples name is dropped when the file was not moved there.
- **Placement (bloblang `show`):** creations are queued one at a time (`enqueue`) so a second panel sees the first one's group. The file's graph column comes from a new option `graphColumn(uri)`, wired in `extension.ts` to `graphPanels.panelFor(uri)?.panel.viewColumn`. Registries without it (the suite's own) fall back to "the group beside the active one holds a graph", which also enforces "never into the graph's group" when another file's graph sits beside the YAML. If no group can be created, the panel opens `Beside` (logged).
- **Graph above the test group:** `graphColumn` is now async; only the two fallback branches (no open graph, no empty group right of the YAML) check whether the column the graph would take holds only test panels and, if so, open a group above it. The lock sequence and `onlyGraphs` are unchanged; suite 84 passes unchanged.
- **Tab close:** as the graph's (`hadTab` / `hasTextTab`), skipped while a pending rename has the file as `from` (or a folder holding it) **or as `to`**. Without the `to` case, an overwriting rename (COLLISION) closed the target's own panel first, because VS Code briefly drops the target's tab, so the incoming panel never collided.
- **Rename:** `moveTo` moves the URI, re-sets the hint on its current line (`hintLine` is tracked now) and swaps the samples watch. `SampleStore.rekey` moves the `seen` cache and queue tail first (before the old watch is disposed, which would drop the cache). `SampleStore.moveFile` is queued on the new samples file, so the moved panels' reads wait for it. It renames only when the new URI is a file, the new samples file is absent and the old one exists (no overwrite). It checks the new file first, so a move another store already made is `'none'`, not `'exists'`. The snapshot always carries `fileName` (and `samplesFile` for a saved config).
- **Test changes outside the matrix:** suite 90's `open()` now pins its editors (`preview: false`): a preview tab replaced by the next file would now close its panels. CLOSE_UNSAVED and SAVED_POSITION open the config in a diff editor (`vscode.diff`): only a file with no text tab keeps its panel through the document's close, which is the only way 4.10's reset on close is still reached. The snapshot deep-equals gained the two names.
- **Race fixed on the way:** `postSnapshot` / `samples()` now wait for Add label's relink in flight. A recreated webview's `ready` during the relink read the old (path) link after the move and posted empty samples (seen once in the full run as an OFFER flake).

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 1 medium, 5 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The YAML's column is read before the new group is created below a graph that sits before it; columns renumber, so focus returns to the new test group and the YAML opens in it | medium | patch | ViewColumn numbers follow grid order. Now the YAML's group is kept, not its number. An integration test covers the A, graph, B layout. |
| 2 | Samples files in a batch rename (swap, chain) are moved one by one and race each other: swapped samples, a false "already exists" | low | reject | Swap and chain renames in one batch are rare from the UI. A correct fix needs dependency-ordered moves through temporary names, more than a direct correction. The panels follow correctly. |
| 3 | A case-only rename on a case-insensitive filesystem reports "Samples weren't moved" | low | patch | The target "exists" because it's the same file. Now it renames when the paths differ only by case. |
| 4 | `rekey` leaves the old file's text cached for the target when nothing moved, so the next load fires a spurious outside edit | low | patch | The copied entry is dropped on the `exists` and `none` paths. |
| 5 | `pendingRenames` entries leak if a rename fails after the will-event, so tab close and the close reset are skipped for that file | low | defer | It copies the graph's existing pattern (pre-existing in `graphPanel/panels.ts`), and failed renames are rare. Recorded in deferred-work for both registries. |
| 6 | `BloblangPanels.idle()` is unused | low | patch | Removed. |

## Verification

**Results (2026-10-16, after the review patches):** `npm run compile` exit 0. Full stable suite under `xvfb-run -a`: 826 passing, three runs (two by the implementer, one by me). Two earlier runs on the real display failed 3 and 5 focus-dependent tests in suites that run before any 4.17 code (undo, completion): an environment effect, since `undo` needs window focus. `npm run test:webview` 240; `npm run test:corpus` 129. The implementer's floor run had 823 passing before the patches. Manual check (the user, dev host, real rpk): test panels in one group below the graph with the YAML focused, the graph opened later going above the test group and locked, a rename keeping the panel with the samples file moved, and panels closing with the last tab: no issues.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- Dev host: placement with and without the graph, the graph opened after a test panel, rename (samples file follows), close with the last tab.
