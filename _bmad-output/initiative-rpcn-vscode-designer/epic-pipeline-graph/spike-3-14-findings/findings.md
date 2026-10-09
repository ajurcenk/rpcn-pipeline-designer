# Spike 3.14 findings: group lock, focus return and restored tabs

Date: 2026-10-09.
- **Automated probe:** `probe-lock.ts`, run as an extra integration suite in a scratch worktree at 3f0356e on VS Code 1.141.0 (stable) and 1.100.0 (floor). Full step-by-step logs are in `probe-log.md`.
- **Reload check:** done by hand in the dev host by the user on **VS Code 1.103.2** (their `code`), not on 1.100.0 (screenshot `reload-locked-empty-group.png`, cropped to the VS Code window). Steps: one YAML tab (`graph-demo.yaml`) open; Show graph; graph tab clicked; **View: Lock Editor Group** run by hand; **Developer: Reload Window**.
- **Re-running the probe:** copy `probe-lock.ts` to `src/test/integration/suites/99-probe-lock.ts`, add `import './suites/99-probe-lock';` at the end of `src/test/integration/index.test.ts`, then run `npx tsc -p . --outDir out && node esbuild.js` and `npx vscode-test --label stable --grep "Spike 3.14"` (or `--label floor`). Each run writes `rpcn-probe-<version>.txt` to the OS temp folder. Do not commit the suite.

## Answers

| Question | Stable 1.141.0 | Floor 1.100.0 | Evidence |
|---|---|---|---|
| Does `workbench.action.lockEditorGroup` exist? | yes (also `unlockEditorGroup`, `toggleEditorGroupLock`) | yes | log, "commands" |
| Does it lock a webview's group? | yes, when that group is **active**: a file opened with no column then goes to the YAML group (step 6), and without the lock it goes into the graph group (control, step 9). Step 6's starting state (graph group active after `reveal`) was not logged at that step; it is inferred from step 3. | same; but the floor keeps the replaced tab (`col1[text:a.yaml, text:b.yaml]`), while stable replaced `a.yaml` (preview tab) | steps 3–6, 9 |
| What if the YAML group is active when the lock runs? | **the YAML group is locked** instead; a later open goes to the graph group (steps 10–11) | same | steps 10–11 |
| Does focus return to the YAML? | yes, with `showTextDocument(doc, {viewColumn: <its column>, preserveFocus: false})` | yes | step 5 |
| Does an explicit column bypass the lock? | yes **for a text editor**: `showTextDocument(c, {viewColumn: <graph column>})` lands in the locked group (step 7). Not probed for `createWebviewPanel` with an explicit column. | same | step 7 |
| Where does a second file's "Show graph beside" go once the graph group is locked? | into a **new** group beside the YAML; the locked group is renumbered (col3), so groups multiply (step 8) | same | step 8 |
| `activeTextEditor` while the webview is focused | still the YAML editor | **`undefined`** (step 3); and at step 8 it named `c.yaml@col3` although the active group was col1 with `a.yaml` active: on 1.100 it can point at another group's editor | steps 3, 8 |
| Can the extension read the lock state? | no: `TabGroup` has no `isLocked` in `@types/vscode` 1.100.0, and the extension API cannot read context keys. VS Code's `activeEditorGroupLocked` context key exists for `when` clauses (menus, keybindings). | — | `node_modules/@types/vscode/index.d.ts` `interface TabGroup` |
| After **Developer: Reload Window**: the YAML tab | restored, on screen (1.103.2). **Not observed:** whether the extension sees it as an open (`onDidOpenTextDocument`, `workspace.textDocuments` at activation) or only as a tab in `tabGroups`, and what happens to restored tabs that are not visible | not checked | screenshot |
| After reload: the graph tab | **gone** (1.103.2); no serializer, by spec (Non-goal "restoring the graph panel after a window reload") | same on **1.100.0**: the graph group is left empty (user, 2026-10-09, "Graph tab is still empty") | screenshot; user |
| After reload: the graph's group | **remains, empty and still locked** on screen (1.103.2): lock icon in its toolbar, only the VS Code watermark inside. Not checked through the API (`tabGroups.all`, `tabs.length === 0`); the probe's step 9 (after `closeAllEditors`) shows an emptied locked group does **not** survive a close-all | not checked | screenshot; step 9 |

## Recommendation for entry 10 (auto-open)

1. **Lock sequence:** open the panel beside with `preserveFocus: true`; `reveal(column, false)` to make its group active; run `workbench.action.lockEditorGroup`; then return focus with `showTextDocument(doc, {viewColumn: <the YAML's column>, preserveFocus: false})`. Hold the `TextDocument` from the start. Never rely on `window.activeTextEditor` during or right after the sequence: on 1.100 it is `undefined` while the webview has focus and can name another group's editor (step 8). That includes `GraphPanels.show()`'s current no-URI fallback (`src/adapters/graphPanel/panels.ts`), which entry 10 should replace with the editor the command came from (`activeTabGroup.activeTab`'s input, or the command's URI).
2. **One graph group, not one per file:** once a graph group exists, open every later panel into its column **explicitly**. The lock does not apply to an explicit column for text editors (step 7), so the group should get a new tab instead of a new group appearing. **Entry 10 must verify** this for `createWebviewPanel` first; it was not probed. Track the group by the column of the existing graph panels; if none are open, see 3.
3. **Reuse the empty locked group after a reload:** a reload leaves an empty locked group beside the editor (seen on 1.103.2). On the first open after activation, if the `tabGroups` beside the YAML's column include an **empty** group (`tabs.length === 0`), open the panel into that column explicitly instead of `ViewColumn.Beside`; otherwise VS Code adds another group next to the leftover locked one. **Unverified, for entry 10 to check:** that the leftover group appears in `tabGroups.all` with no tabs, and what `lockEditorGroup` does on a group that is already locked (`toggleEditorGroupLock` would unlock it; `lockEditorGroup` is expected to be idempotent but was not run twice).
4. **Best effort, and silent:** if `lockEditorGroup` throws or does not exist, skip it and keep the panel open. The lock only stops other editors from landing in the graph group.
5. **Tests in entry 10:** steps 5, 6 and 8 of the probe become integration assertions on both versions. Assert where the opened editor lands, not the tab count: preview-tab handling differs (stable replaced `a.yaml` at step 6, the floor kept it). A reload stays a manual check (entry 13), because reloading ends a test run. Entry 13 should repeat it on 1.100.0 (`CODE=.vscode-test/vscode-linux-x64-1.100.0/code scripts/dev-host.sh`) and note what happens to restored tabs that are not visible.

## Not covered

- The reload on VS Code 1.100.0 was repeated by the user (2026-10-09) in a 1.100.0 dev host (`.vscode-test/vscode-linux-x64-1.100.0/code`, separate profile `.dev-host/user-1100`): the graph tab is gone and its group is left empty, as on 1.103.2; the lock and the non-visible tabs were not reported. Still open: whether restored YAML tabs reach the extension as opens after a reload. Both matter for entry 10's first-open-per-session rule; entry 10 or entry 13 checks them.

- Remote windows (SSH, WSL, dev containers): not tried. They are the same workbench, so the same behaviour is expected.
- Locks set by the user on other groups, and the `workbench.editor.autoLockGroups` setting (which can auto-lock groups for some editor types): not probed. Entry 10 should leave user settings alone.
