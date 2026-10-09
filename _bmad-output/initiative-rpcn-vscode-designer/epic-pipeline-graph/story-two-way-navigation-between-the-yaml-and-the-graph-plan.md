---
title: 'Two-way navigation between the YAML and the graph'
type: 'feature'
ticket: '7'
created: '2026-10-09'
status: 'built'
baseline_revision: 'feecd297378ffefd4e0d69fb48f6fd964a4f7d9a'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/spike-3-14-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:**
- **Graph to YAML:** a click selects a node's YAML, but it reveals it only "if outside the viewport" and always in the file's first visible editor, not the editor the user was working in.
- **YAML to graph:** moving the cursor does nothing in the graph, so the YAML → graph half of CAP-8 is missing.

**Approach (AD-8, R6):**
- **Driving editor:** the host tracks it per file, meaning the text editor for that file the user last moved the cursor in or focused.
- **Click or Enter on a node** (`nodeActivated`): the host reveals the node's range **centred** in the driving editor and selects it. A click on a group's header label reveals the whole block (the group's range).
- **Cursor moves:** on every cursor move in a driving editor, and after every model change, the host computes `nodeAt(model, cursorOffset)` (3.5) and sends `selection {nodeId | null}`, only when it changed. The webview highlights that node with DESIGN's `pipeline-node-selected` tokens. It moves no focus and never opens or reveals the panel.

**Decisions (agent defaults, reported at the checkpoint):**
- **Tracking the driving editor:** from `onDidChangeTextEditorSelection` and `onDidChangeActiveTextEditor` events, using the editor objects they carry. Never read `window.activeTextEditor` mid-sequence: the 3.14 spike showed it is `undefined` or wrong on 1.100 while a webview has focus.
  - **Fallbacks, in order:** the driving editor; then a visible editor for the file; then `ViewColumn.One`.
  - **A closed driving editor** falls back the same way.
- **Selection while the YAML is broken:** no `selection` messages are sent while `parseError` stands, because the last valid model's ranges no longer match the text. The highlight stays as it was, and the next valid model recomputes it.
- **Highlight inside a collapsed group:** the nearest visible ancestor (the collapsed group's box) is highlighted. The view computes this from the `parent` chain.
- **The snapshot** carries the current selection, so a recreated webview shows the highlight.
- **Feedback loop:** a click reveals and selects, the cursor lands in the range, and `selection` names the clicked node. That is the intended confirmation, not a loop, because the host never moves the cursor in response to `selection`.

## Boundaries & Constraints

**Always:**
- **The webview only renders (AD-3, AD-8):** the host decides and performs every reveal, and neither side stores a selected id across changes. The selection is always recomputed from the cursor and the current model.
- **One function maps offsets:** `nodeAt` is the only offset → node mapping (AD-16). The host converts the cursor's position to an offset with `document.offsetAt`.
- **No edits:** a reveal or select never edits the text (AD-19). Focus stays in the editor on cursor moves; a click moves focus to the driving editor, which is what selecting there means.
- **Green:** `npm test` (stable and 1.100.0), `npm run test:webview`, `npm run test:corpus` and CI pass.

**Never:**
- the host moving the cursor because of a `selection` message;
- keyboard navigation inside the graph (Tab, arrows, Space, Esc: entry 11; Enter arrives as `nodeActivated via: 'keyboard'`, which the host already accepts);
- node status (3.8);
- revealing or opening the panel on a cursor move;
- debouncing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CLICK_CENTRED | `nodeActivated` for a node far down the file | its range is selected in the driving editor and revealed centred (`TextEditorRevealType.InCenter`) | — |
| DRIVING | the file open in columns One and Three, the cursor last moved in Three | a click selects in column Three's editor, and no new editor opens | — |
| DRIVING_CLOSED | the driving editor's tab closed | a visible editor for the file, else column One | — |
| HEADER | the header label of a `switch` group clicked | the whole `switch` block is selected | — |
| CURSOR | the cursor moved into a processor inside a switch case | one `selection` naming that processor (the innermost) | — |
| CURSOR_SAME | the cursor moved within the same node | no new `selection` | — |
| CURSOR_OUTSIDE | the cursor on a blank top-level line | `selection {nodeId: null}` (once) | — |
| AFTER_EDIT | an edit that moves the cursor's node (insert lines above) | after the new `model`, a `selection` for the node now under the cursor | — |
| BROKEN | cursor moves while `parseError` stands | no `selection` | — |
| FOCUS | cursor moves | focus stays in the editor; the panel is not revealed | — |
| OTHER_FILE | the cursor moves in a file without a panel | nothing is posted | — |
| VIEW_HIGHLIGHT | `selection` for a node, and for a node inside a collapsed group | that node, or the collapsed group's box, gets the selected style; `null` clears it | — |
| SNAPSHOT | the webview is recreated | the snapshot's `selection` is the current one | — |

</frozen-after-approval>

## Code Map

- **`src/adapters/graphPanel/panels.ts`:**
  - `GraphPanel.receive` (~L70–85) dispatches `ready` / `nodeActivated` / `bannerClicked`;
  - `activate(nodeId)` (L139) builds the model and selects the range;
  - `selectParseError` (L152);
  - the shared reveal helper (~L160–170) picks `visibleTextEditors.find(…)` and then `showTextDocument(doc, {viewColumn, …})`, and reveals with `InCenterIfOutsideViewport`;
  - `GraphPanels` subscribes `onDidChangeTextDocument` once (L205) and routes changes per URI. Do the same for `onDidChangeTextEditorSelection` and `onDidChangeActiveTextEditor`.
  - The last valid model and the parse error are kept per panel (3.6). The `posted` seam is capped at 50.
- **`nodeAt`:** `src/core/nodeAt.ts` `nodeAt(model, offset)`, re-exported from `src/core/graph.ts`.
- **Protocol:** `src/shared/protocol.ts` has `selection {nodeId: string | null}` as a host message, and `snapshot.selection`.
- **Webview:**
  - `webview/src/state.ts` is the reducer (snapshot / model / parseError; add `selection`); `webview/src/state.test.ts` already has a `selection` case;
  - `webview/src/layout.ts` turns the model and collapse state into ELK and xyflow nodes; the nearest-visible-ancestor helper belongs here (pure, vitest);
  - `webview/src/nodes.tsx` holds the component, group and route renderers (the group header ~L44, chevron `onClick` L51);
  - `webview/src/graph.css` holds theme-variable styles (the TOKENS test).
- **DESIGN tokens:** `pipeline-node-selected` = background `{colors.selection}` (`var(--vscode-list-activeSelectionBackground)`) and foreground `{colors.on-selection}`; groups should get a selected outline in the same colour, keeping their transparent fill.
- **Spike findings:** `spike-3-14-findings/findings.md`: do not trust `activeTextEditor` on 1.100; focus moves with `showTextDocument(doc, {viewColumn, preserveFocus: false})`.
- **Tests:** `src/test/integration/suites/80-graph.ts` has the host seam (`panelFor(uri).posted`, `receive`), `open()` and the fake 4.112.0 binary. Move the cursor with `editor.selection = new vscode.Selection(…)`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/graphPanel/panels.ts`: driving-editor tracking, the centred reveal for clicks and the banner, cursor → `selection` (deduped, suppressed while broken), recompute after each model, and the snapshot's `selection`. Host behaviour.
- [x] `webview/src/state.ts`, `webview/src/layout.ts`, `webview/src/nodes.tsx`, `webview/src/graph.css`: the selection state, the nearest-visible-ancestor helper, the highlight styles, and the header label posting `nodeActivated` for the group (not the chevron). View behaviour.
- [x] Tests:
  - `80-graph.ts`: CLICK_CENTRED, DRIVING, DRIVING_CLOSED, HEADER, CURSOR, CURSOR_SAME, CURSOR_OUTSIDE, AFTER_EDIT, BROKEN, FOCUS, OTHER_FILE, SNAPSHOT;
  - `webview/src/*.test.ts`: VIEW_HIGHLIGHT and the reducer.
- [x] `README.md`, `CHANGELOG.md`. Docs.

**Acceptance Criteria:**
- Given the graph beside a config, when the cursor moves through the YAML, then the node under it is highlighted in the graph and focus stays in the editor.
- Given a node is clicked, then its YAML is selected and centred in the editor the user was working in.

## Implementation Notes

- **Cursor offset = the selection's start.** `nodeAt` gets `document.offsetAt(editor.selection.start)`, not `selection.active`: a click selects `[start, end)` with the cursor at `end`, which lies outside the node (its range is half-open), so `active` would name the next node or nothing and break the click confirmation. For a plain cursor `start` and `active` are the same.
- **Driving editors** are tracked in `GraphPanels` for every file (not only files with a panel), so a panel opened later has one; entries whose editor is no longer in `visibleTextEditors` are dropped. Lookup: the driving editor while visible, else a visible editor for the file, else (for reveals) `ViewColumn.One`. Focusing an editor (`onDidChangeActiveTextEditor` with an editor) also recomputes the selection; `undefined` (webview focused) is ignored.
- **Dedupe memo:** the panel remembers the selection it last sent (snapshot or `selection`) only to skip sending the same one; the value is always recomputed with `nodeAt`. A snapshot while the YAML is broken carries that last sent value (the highlight as it was).
- **Per-version state cache:** the panel keeps its last `{model | parseError}` per document object, version and catalogue, so cursor moves do not rebuild the model.
- **View:** `visibleAncestor` (outermost collapsed ancestor, else the node) and `markSelected` in `layout.ts`; `Graph.tsx` restyles the laid-out nodes without re-running ELK. The group header label posts `nodeActivated` for the group (with `stopPropagation`); the chevron still only toggles. Selected styles: components use the list-selection background/foreground; expanded groups and routes keep their transparent fill and get a border/outline in the selection colour; a collapsed group is filled like a node.
- **CLICK_CENTRED test** scrolls the node to near the top first, so it fails with `InCenterIfOutsideViewport` (checked by mutation).

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, by a fresh subagent; 2026-10-09):** 5 findings, all patched (1 medium, 4 low). No intent_gap or bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Every selection event makes its editor the driving editor, including cursor shifts VS Code makes in a second split editor when the text moves, so typing in A can make B the driving editor | medium | patch | Only `e.kind !== undefined`, or the last-focused editor, counts. |
| 2 | The highlight resolves the current model and collapse state against an older layout (async ELK), so the wrong node can flash | low | patch | Each layout result keeps its own model and collapse state; pure helper with a test. |
| 3 | An editor with no `viewColumn` (a diff side) can be chosen, and the reveal then goes to column One | low | patch | Such editors are ignored. |
| 4 | The DRIVING test cannot tell "cursor last moved in" from "active editor" | low | patch | A case where an unfocused editor's cursor shifts programmatically. |
| 5 | The FOCUS test's "panel not revealed" check could not fail | low | patch | Checked before and after each move. |

## Verification

**Re-verification after the review patches (parent, 2026-10-09):** `npm run compile` clean; `npm run test:webview` 83 passed; `npm test` 596 passing on stable and 1.100.0; `npm run test:corpus` 123 passed. Manual check pending (the user).

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass on stable and 1.100.0.
- `npm run test:webview`: all pass.
- `npm run test:corpus`: all pass.

**Manual checks:**
- In the dev host on `graph-demo.yaml`:
  - moving the cursor highlights nodes, including inside `catch` and the broker, and the collapsed group box when collapsed;
  - clicking a node far down centres it;
  - with the file split into two editors, a click selects in the one last used.
