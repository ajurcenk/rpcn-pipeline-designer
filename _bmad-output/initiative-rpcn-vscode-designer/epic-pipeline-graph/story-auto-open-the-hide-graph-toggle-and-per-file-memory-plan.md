---
title: 'Auto-open, the Hide graph toggle and per-file memory'
type: 'feature'
ticket: '10'
created: '2026-10-09'
status: 'done'
baseline_revision: '126568a4e0785cf7345aa4ce16f2300ceb25eecf'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/spike-3-14-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The graph opens only from the Command Palette. Nothing opens it for a detected file, Hide graph has no handler, and nothing in the editor title offers either command. A graph also outlives its YAML tab and loses its file on a rename (R1, R2, CAP-6, CAP-12).

**Approach (AD-1, AD-18, spike 3.14):**
- **Auto-open:** the first time an editor shows a detected file in a session, its graph opens beside it unless `redpandaConnect.autoOpenGraph` is `false` or the file is hidden. The graph's group is locked (best effort) and focus returns to the YAML editor.
- **Toggle:** Show graph and Hide graph appear as an editor-title toggle (Show while the file's panel is closed, Hide while it is open) and in the Command Palette, for detected files only, with no keybinding.
- **Show graph:** clears the file's Hide, marks it detected (`markDetected`) and opens or reveals its panel.
- **Hide graph:** closes the panel and stores the Hide per file in `workspaceState`. The Hide survives a reload and suppresses auto-open until Show graph.
- **Close and rename:** closing the file's last YAML tab closes its graph. A rename (`onDidRenameFiles`) re-keys the panel, its title, the Hide and the session memory.

**Decisions (agent defaults, reported at the checkpoint):**
- **"First open":** the first time a visible text editor shows the URI in this session (counted for editors visible at activation too), whether or not the file is detected then. A file that becomes detected while you type therefore gets the button and no auto-open (EXPERIENCE Flow 3). `onDidOpenTextDocument` is not used, because it fires for documents no editor shows.
- **Lock sequence (spike rec. 1):**
  1. Create the panel with `preserveFocus: true`.
  2. Run `reveal(column, false)`.
  3. Run `workbench.action.lockEditorGroup`.
  4. Run `showTextDocument(doc, {viewColumn: <the YAML's column>, preserveFocus: false})`.
  - The sequence uses the held `TextDocument` and never `activeTextEditor`.
  - It runs whenever a panel is **created**, by auto-open or by Show graph.
  - If it fails, the panel stays open and the failure is logged.
- **One graph group (rec. 2, 3):**
  - A new panel goes into the column of an existing graph panel, else into an empty group beside the YAML (a group left locked by a reload), else `Beside`.
  - Whether an explicit column bypasses the lock for `createWebviewPanel` is verified by a test.
- **Show graph's target:** the command's URI, else the active tab's text input (`tabGroups.activeTabGroup.activeTab`), never `activeTextEditor` (rec. 1).
- **Closing the panel by its own ×:** this is not a Hide. Only the Hide graph command stores one.
- **Context key:** `redpandaConnect.graphOpenPaths` (fsPaths of files with an open panel), next to `detectedPaths`.
  - **Icons:** `$(type-hierarchy)` for Show and `$(eye-closed)` for Hide, in the `navigation` group.
- **Save As (user decision 2026-10-09, "Leave out"):** not re-keyed in 3.10. VS Code has no Save As event, so the old graph closes with its tab (TAB_CLOSE) and the new file auto-opens its own on first show. Backlog story 12 covers a true re-key.
- **Plan size (user decision 2026-10-09, "Keep whole"):** one entry, because auto-open, Hide, tab-close and rename all key the same panel maps.
- **Tests and auto-open:** auto-open defaults to `true`, but the other suites open detected YAML. A root hook in the integration entry therefore sets `autoOpenGraph: false` (Global) before any suite, and the 3.10 tests turn it on.

## Boundaries & Constraints

**Always:**
- The panel registry stays keyed by `uri.toString()` (AD-1). Every map that holds a URI (panels, driving editor, Hide, seen) re-keys together.
- **Best effort, silent:** a failing lock or a failing focus return never closes the panel or throws.
- User settings stay as they are, including `workbench.editor.autoLockGroups`.
- **Green:** `npm test` (stable and 1.100.0), `npm run test:webview`, `npm run test:corpus` and CI.

**Never:**
- a `WebviewPanelSerializer` (the graph comes back after a reload through auto-open);
- a default keybinding;
- auto-open on detection while typing;
- auto-open for untitled documents;
- changing detection rules;
- keyboard navigation (3.11).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| AUTO | a detected file shown for the first time, setting on | one panel beside it; the active editor is the YAML; a file opened with no column then lands in the YAML group, not the graph group | the lock fails → panel kept, logged |
| AUTO_ONCE | the same file closed and shown again in the session | no second auto-open | — |
| AUTO_OFF | `autoOpenGraph: false` | no panel; Show graph still works | — |
| TYPED | a file that becomes detected while typing | no auto-open; the Show button appears | — |
| HIDE | Hide graph on an open graph | panel closed; Hide stored in `workspaceState` | — |
| HIDDEN | a hidden file shown again (also after a reload: state read at activation) | no auto-open | — |
| SHOW | Show graph on a hidden or never-detected file | Hide cleared, file marked detected, panel opened | — |
| SECOND | Show graph for a second file while one graph is open | the panel lands in the existing graph group; no new group | — |
| TAB_CLOSE | the file's last YAML tab closes | its graph closes | — |
| RENAME | a file with a panel and a Hide is renamed | panel keyed by the new URI, title updated, Hide moved, the model keeps following | — |
| TOGGLE | `when` clauses | Show in the title for a detected file without a panel, Hide with one; palette the same | — |

</frozen-after-approval>

## Code Map

- **`src/adapters/graphPanel/panels.ts`:**
  - `show(uri?)` (:639) uses an `activeTextEditor` fallback, `Beside`, `preserveFocus: true` and `reveal(undefined, true)`;
  - `registerCommands()` (:634) registers showGraph only;
  - the `panels` Map (:531), `driving` (:537) and `focused` (:539);
  - `onDidDispose` (:674);
  - `GraphPanel.uri` is readonly (:86) and closures capture `key` and `target` (:663–671), so re-keying needs a mutable URI;
  - `GraphPanelsOptions` (:471) gains optional `detection`, `memento`, `autoOpen` and `setContext`, faked by `testPanels`.
- **`src/adapters/vscode/detection.ts`:** `DetectionRegistry.isDetected` and `detectedUris`; `markDetected(uri)` (:130) has no caller yet; `onDidChangeDetection` (:78).
- **`src/adapters/vscode/run.ts`:** the context-key pattern (`DETECTED_PATHS_KEY` :25, `refreshUi` :393, `host.setContext` :173).
- **`package.json`:**
  - showGraph and hideGraph have no icon;
  - `commandPalette` hideGraph `when: "false"`;
  - `editor/title` has only run and runUntitled (`resourcePath in redpandaConnect.detectedPaths`);
  - `redpandaConnect.autoOpenGraph` (default `true`) is defined but read nowhere.
- **`src/extension.ts` (~:160):** pass `detection`, `context.workspaceState` and the setting reader.
- **Integration tests:**
  - root hook: `src/test/integration/index.test.ts`;
  - `80-graph.ts`:
    - helpers `open` (:74), `showGraph` (:82), `withGraph` (:59);
    - teardown asserts `size === 0` (:99–101);
    - the hideGraph palette test (:105–113) changes;
    - column and focus assertions (:124, :171).
- **Spike probe:** `spike-3-14-findings/probe-lock.ts`, steps 5, 6 and 8 are the assertions to reuse; assert where an opened editor lands, not tab counts.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/graphPanel/panels.ts`:
  - first-open tracking and auto-open;
  - the lock sequence and group choice;
  - Show and Hide with `workspaceState`;
  - the context key;
  - tab-close;
  - rename re-keying.
- [x] `src/extension.ts`, `package.json`: wiring, the command icons, the `editor/title` and `commandPalette` `when` clauses.
- [x] `src/test/integration/index.test.ts`: the root hook that turns auto-open off.
- [x] `src/test/integration/suites/80-graph.ts`: every matrix row, on both versions. HIDDEN-after-reload is tested by a fresh `GraphPanels` on the same memento.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a detected file opened for the first time, when it opens, then one graph shows beside it, the YAML editor has focus, and a file opened next lands in the YAML group.
- Given that file hidden, when the window reloads and the file is shown, then no graph opens until Show graph.

## Implementation Notes

- **Lock guard:** the lock runs only once the new panel is active and its group is the active group (polled up to 1 s); otherwise it is skipped and logged, so it never locks the YAML's group (spike step 10).
- **One at a time:** panel creations and their lock sequences are queued, since the lock acts on the active group. `GraphPanels.show()` is now async and resolves after the sequence; `idle()` and `isHidden()` are test seams.
- **TAB_CLOSE** is "the file had a text tab since its panel opened and has none now", checked on every `onDidChangeTabs`, so a replaced preview tab counts too. The suite's `open` helper therefore opens files with `preview: false`.
- **RENAME:** `onWillRenameFiles` records the pending rename, so that the old tab closing (and the new editor's first show) during the rename neither closes the panel nor auto-opens a second one; `onDidRenameFiles` re-keys panels, driving editors, Hide and seen (folder renames included, `renamedKey`).
- **Explicit column into the locked group** (rec. 2): verified for `createWebviewPanel` by SECOND on both versions — the panel lands in the graph group and no group is added.
- **Run suite:** its editor-title assertion now checks only the run entries.
- **Not tested automatically:** the empty locked group a reload leaves (rec. 3) is reused by `graphColumn`, but only a manual reload (entry 13) can check it; a failing `lockEditorGroup` is only covered by code review (logged, panel kept).

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 3 medium, 4 low, 0 false, 0 maybe-false; 1 low rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | A queued auto-open runs after the YAML tab closed: it reopens the file, or leaves a graph with `hadTab` false that never closes | medium | patch | `open()` re-checks only `shouldAutoOpen`; skip an auto-open when the file has no text tab |
| 2 | The focus return can pull the YAML over an editor opened since | medium | patch | the queue plus the 1 s poll delay it; return focus only while the graph panel is still active |
| 3 | With no graph group, `Beside` / `yamlColumn + 1` can land the graph in a group of the user's text editors, and the lock then locks it | medium | patch | the guard checks only that the group is active; lock only a group of graph panels; reuse only the adjacent empty group |
| 4 | Hide graph is not offered while the graph tab has focus | low | patch | `resourcePath` is unset for a webview; add `activeWebviewPanelId == 'redpandaConnect.graph'` to the palette `when` |
| 5 | README and CHANGELOG say Show graph works on undetected files, but no menu offers it there | low | patch | the palette and title `when` clauses need detection; reword |
| 6 | Re-running the lock on an already-locked group is never checked | low | patch | SECOND gains a no-column open that must land in the YAML group |
| 7 | A rename that never completes leaves `pendingRenames` set for the session | low | reject | needs a failed or aborted rename, which is rare in use; a fix needs a timeout or cleanup branch |

## Verification

**Commands (2026-10-09, after the review patches):**
- `npm run compile` and `npm run lint`: exit 0.
- `npm test`: 626 passing on stable 1.141.0 and on 1.100.0, including every matrix row (AUTO, AUTO_ONCE, AUTO_OFF, TYPED, HIDE / HIDDEN / SHOW, SECOND, TAB_CLOSE, RENAME, TOGGLE) and UNTITLED.
- `npm run test:webview`: 99 passed. `npm run test:corpus`: 123 passed.

**Manual checks (entry 13 repeats the reload):**
- In the dev host:
  - open `graph-demo.yaml`: the graph opens beside it, locked, with focus in the YAML;
  - Hide graph, then Developer: Reload Window, then reopen the file: no graph;
  - Show graph: it opens;
  - close the YAML tab: the graph closes.
- **Done by the user on 2026-10-10** in the dev host (stable), starting from a clean editor layout. Checked: auto-open of a first and a second file into one locked graph group, Hide graph, the Hide surviving a reload, Show graph, tab close, rename, and optionally the setting turned off. Result: "tested".
  - During the check the user found that the graph auto-opens only on a file's first show in a window session ("This is working only first time"). That is R1 as written. Their decision: "keep as is now", so Show graph brings the graph back after that.
  - Not reported: whether a reload left an empty locked group, and whether the next graph reused it. Entry 13 repeats the reload on 1.100.0.
