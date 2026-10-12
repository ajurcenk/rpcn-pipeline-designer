---
title: 'Keyboard and screen-reader model'
type: 'feature'
ticket: '11'
created: '2026-10-10'
status: 'done'
baseline_revision: 'c4ce8cec2daf96e9920f0aa913ebbfbb88807d29'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The graph can only be used with a mouse. React Flow makes every node a Tab stop, but nothing moves between nodes with the arrows, Enter and Space do nothing, and nodes have no accessible names. Nothing announces new errors either (R11, CAP-7, EXPERIENCE Accessibility Floor).

**Approach:** the webview owns a keyboard and announcement model:
- **Focus:** one roving Tab stop. Tab enters the graph at the first node, or at the node last focused. The arrows move focus between the drawn nodes. Focus shows the `focusBorder` ring and is never removed.
- **Enter:** reveals the node's YAML (`nodeActivated` with `via: 'keyboard'`; the host already moves focus to the editor).
- **Space:** toggles a group's collapse.
- **Esc** (user decision 2026-10-10, "Both, two steps"):
  - Esc on a node moves focus to the graph container (EXPERIENCE :114).
  - Esc on the container posts a new `focusEditorRequested` message, an additive protocol change with a validator. The host then focuses the file's driving editor, without moving its cursor or selection.
  - With no editor for the file, nothing happens and nothing is logged as an error.
- **Names:**
  - the graph container is named "Pipeline graph, read-only";
  - each node's accessible name follows EXPERIENCE: "{role} {type}{, label}{, has error: message}{, has warning: message}", and a group adds its summary and "expanded" or "collapsed".
- **Live region:** one polite live region announces the banner text when it appears, and each node that newly gets an error.

**Decisions (agent defaults, reported at the checkpoint):**
- **Arrow map** (EXPERIENCE gives "flow order and into/out of groups" only):
  - Right / Left: the next / previous drawn sibling (same parent, model order);
  - Down: into an expanded group or route (its first drawn child);
  - Up: out to its parent;
  - at an end nothing moves.
  - A collapsed group is one stop; its hidden children are never focused.
- **Roles:** Input, Processor, Output, Resource, and Case for a route, from the node's role. The type is the component (`switch`), and the label is the node's label when it has one. A message is the first message only, with a count when there are more.
- **React Flow:** its own keyboard handling is turned off (`disableKeyboardA11y`, no Space pan key), and its swapped move/delete descriptions are not shown. Focus stays out of edges and the pane.
- **Pure helpers:** navigation (`nextFocus`) and announcements (`nodeAnnouncement`, `newErrorAnnouncements`) live in `layout.ts` and are tested in plain Node.
- **happy-dom** (new dev dependency, webview tests only) renders `Graph`. A test that renders a component opts in per file. Any React Flow browser APIs happy-dom lacks (for example `ResizeObserver`) are stubbed in the test setup only.

## Boundaries & Constraints

**Always:**
- The webview stays render-only (AD-3). Focus is view state, saved alongside the collapse state.
- Colours come only from DESIGN theme variables (TOKENS test); the ring is `var(--vscode-focusBorder)`.
- The mouse behaviour is unchanged (click, header label, chevron).
- **Green:** `npm test` (stable and 1.100.0), `npm run test:webview`, `npm run test:corpus` and CI.

**Never:**
- keybindings in `package.json`;
- moving or editing nodes from the keyboard;
- focus moving on its own because of a host `selection` (EXPERIENCE :90);
- assertive announcements.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| TAB_IN | Tab into the graph | the first node (the input) is focused, with the ring; Tab again leaves the graph | no nodes → the container keeps focus |
| ARROWS | Right / Left / Down / Up over a model with a switch | sibling, sibling, first case, parent, per the map | at an end → no move |
| COLLAPSED | Down on a collapsed group | no move; Space expands it, then Down enters | — |
| ENTER | Enter on a focused node | posts `nodeActivated {nodeId, via: 'keyboard'}` | — |
| SPACE | Space on a group / on a leaf | toggles the collapse / nothing | — |
| NAMES | a node with an error, a collapsed group, the container | "Processor mapping, has error: …", "Processor switch, 3 cases, collapsed", "Pipeline graph, read-only" | — |
| LIVE | a parse error arrives; a nodeStatus adds an error | the live region says the banner text; then "New error: {node name}" | the same error again → nothing |
| ESC | Esc on a node; Esc again | focus on the container; then `focusEditorRequested` is posted and the host focuses the driving editor, cursor unchanged | no editor → nothing |
| MODEL_CHANGE | the focused node disappears from a new model | focus goes to the nearest visible ancestor, else the first node | — |

</frozen-after-approval>

## Code Map

- **`webview/src/Graph.tsx`** (:100–114):
  - React Flow props: `onNodeClick`, `nodesDraggable={false}`, `elementsSelectable={false}`, `edgesFocusable={false}`;
  - not set yet: `nodesFocusable`, `disableKeyboardA11y`, `aria-label`, `panActivationKeyCode`;
  - collapse: `collapsed` / `toggle` (:50–56) and `saveViewState`;
  - `highlightDrawn` / `markStatus` (:92–93); `laidOut: Drawn`.
- **`webview/src/nodes.tsx`:**
  - `ComponentView`, `GroupView` and `RouteView`;
  - the chevron button `rpcn-group-toggle` (`aria-expanded`, `tabIndex={-1}`);
  - `MarkerIcon` (`role="img"`);
  - `ToggleContext` / `ActivateContext`.
- **`webview/src/layout.ts`:**
  - `visibleAncestor` (:144) and the private `visibleNodes` (:261, drawn nodes in model order: export it);
  - `nodeKind`, `nodeName`, `collapsedSummary`, `markerOf`, `isContainer`.
- **`webview/src/main.tsx`:**
  - `Banner` (`role="status"`, mounted only while broken), so the live region must be a separate, always-mounted element;
  - `EmptyStateView` (already named);
  - `onActivate` posts `via: 'click'` (:78).
- **Protocol** (`src/shared/protocol.ts`), add `focusEditorRequested` to `WebviewMessage` and `parseWebviewMessage`; handle it in `GraphPanel.receive` (`panels.ts`) with the driving editor (`this.editor()`), via `showTextDocument(editor.document, {viewColumn: editor.viewColumn, preserveFocus: false})` with no `selection`, which keeps the editor's cursor. Existing:
  - `ActivationVia` (:121) is already `'click' | 'keyboard'`; `WebviewMessage` (:124);
  - the host's `activate` ignores `via` (`panels.ts` :193, :443), which is correct.
- **React Flow 12.12.0:**
  - the node wrapper takes `ariaLabel`, `ariaRole` and `domAttributes` per node;
  - `onKeyDown` moves or selects nodes only when they are draggable or selectable;
  - its live message is assertive, so do not use it.
- **Tests:**
  - `webview/vitest.config.mts` (`environment: 'node'`, `include` `.ts` only, so widen it to `.tsx`);
  - existing pure tests: `layout.test.ts`, `state.test.ts`, `style.test.ts`;
  - `style.test.ts` holds the TOKENS check.

## Tasks & Acceptance

**Execution:**
- [x] `webview/src/layout.ts`: `nextFocus`, `nodeAnnouncement` and `newErrorAnnouncements` (pure).
- [x] `webview/src/Graph.tsx`, `webview/src/nodes.tsx`: the roving focus, keys, accessible names, React Flow a11y props and focus kept across models.
- [x] `src/shared/protocol.ts`, `src/adapters/graphPanel/panels.ts`, `src/test/shared/protocol.test.ts`, `src/test/integration/suites/80-graph.ts`: `focusEditorRequested` (validate, handle, test ESC on the host side).
- [x] `webview/src/main.tsx`: the container name and the polite live region.
- [x] `webview/src/graph.css`: the `focusBorder` ring on focused nodes.
- [x] `package.json` (devDependency `happy-dom`), `webview/vitest.config.mts`, `webview/src/*.test.ts(x)`: pure tests for the helpers, and happy-dom tests that drive Tab, the arrows, Enter, Space and Esc over a fixture model with node status (every matrix row).
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the graph of `graph-demo.yaml`, when a keyboard user tabs in, walks to a `switch` case's processor with the arrows and presses Enter, then the YAML editor shows that processor selected, and nothing needed the mouse.

## Implementation Notes

- **Container:** the named, focusable container (`.rpcn-graph`, `role="region"`, "Pipeline graph, read-only") is rendered by `Graph.tsx`, not `main.tsx`, because it owns the roving Tab stop, the key handling and Esc's two steps. The name is one constant, `GRAPH_NAME` (`state.ts`), used by it and by the empty state. Its `tabIndex` is 0 only while no node is drawn (TAB_IN "no nodes"), else -1 (Esc focuses it; Tab from it goes to the roving node).
- **Roving stop:** every node is `nodesFocusable` with `domAttributes.tabIndex` 0 for the roving node and -1 for the rest; `ariaLabel` carries `nodeAnnouncement`. React Flow: `disableKeyboardA11y`, `panActivationKeyCode`, `deleteKeyCode`, `selectionKeyCode` and `multiSelectionKeyCode` all `null`, and its node/edge descriptions blanked through `ariaLabelConfig`. Keys with Alt/Ctrl/Meta are left to VS Code. A focused node off screen is centred at the current zoom (`setCenter`, no animation under reduced motion).
- **Focus as view state:** `ViewState.focused` holds the focused node and its ancestors, nearest first (`focusChain`); `focusTarget` resolves it against each drawn model (the node, its collapsed ancestor, a kept old ancestor, else the first drawn node). When the focused node goes while focus is in the graph, focus moves to that target; never while the webview itself is unfocused, so typing in the YAML never pulls focus into the graph. A host `selection` never moves focus.
- **Helpers added beyond the plan's three:** `focusChain`, `focusTarget`, `nodeSpokenName` (`layout.ts`, exported `visibleNodes`); `liveAnnouncements`, `reduceLive` (`state.ts`).
- **Names:** a route reads "Case {caption}" ("case 1" becomes "Case 1"). A group reads "{role} {type}{, label}, {summary}, expanded|collapsed"; the marker part is the marker drawn on the box ("has error: {first}, and N more"). "New error: {role} {type}{, label}" is said for nodes with an error of their own (a leaf's severity, a container's `own`), so a child's error does not also announce every enclosing group.
- **Live region:** an always-mounted, visually hidden `role="status"` `aria-live="polite"` region in `main.tsx`; each announcement is a new keyed element so a repeat is spoken again. The banner is announced when a parse error appears (also in a snapshot); errors in a snapshot are the baseline, so a recreated webview (every tab switch, `retainContextWhenHidden` off) repeats nothing. The banner's own `role="status"` was removed so it is not announced twice.
- **Host:** `focusEditorRequested` is handled by `GraphPanel.focusEditor`: `this.editor()` (driving, else visible), `showTextDocument(editor.document, {viewColumn, preserveFocus: false})`, no selection; no editor → return, nothing logged.
- **Tests:** `webview/src/keyboard.test.tsx` (`// @vitest-environment happy-dom`) renders `App` and drives every matrix row through host messages and key events; `webview/src/test-setup.ts` stubs `acquireVsCodeApi`, `ResizeObserver` and `DOMMatrixReadOnly` only under happy-dom. Tab itself is not simulated (happy-dom has no sequential focus navigation): TAB_IN asserts the set of Tab stops in the graph is exactly the roving node. eslint's test-file block now also covers `*.test.tsx`. happy-dom pinned at 20.14.5 (21.x was a day old).
- **Review fixes:** the nothing-to-draw text is no longer its own region; it describes the graph container (`aria-describedby`), so one region carries the name in both empty states. Edges get `ariaRole: 'presentation'` and `aria-hidden` (React Flow named them "Edge from <id> to <id>"); happy-dom draws no edges, so this is checked on the layout props. The live baseline is the (type, message) errors of the last status that had any (`errorKeys`, `LiveView.errors`), so an id shift or lint errors returning on save are not announced again. Key events from a button (the chevron) are left to it.
- `nodes.tsx` needed no change: the accessible names are set on React Flow's node wrapper.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 3 medium, 1 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Nothing to draw gives two regions named "Pipeline graph, read-only", and the Tab stop is the empty one | medium | patch | `App` renders `Graph` and `EmptyStateView` together for `nothingToDraw`; keep one region and describe it with the text |
| 2 | Edges are read as images named with raw node ids | medium | patch | React Flow 12.12.0 gives non-focusable edges `role="img"` and "Edge from {source} to {target}"; hide edges from assistive tech |
| 3 | "New error" fires again after an id shift, and after every save once lint has cleared | medium | patch | the baseline is keyed by node id and resets on an empty status; compare by (component, message) against the last status that had errors |
| 4 | Enter on a mouse-focused chevron activates the node instead of the button | low | patch | the container's `onKeyDown` catches it; let buttons keep their own keys |
| 5 | The acceptance criterion is not verified end to end | false | reject | it is the plan's manual check, run by the user before the plan is marked done; the automated part is covered by ARROWS + ENTER and the host's `activate` tests |

## Verification

**Commands:**
- `npm run compile` and `npm run lint`: exit 0.
- `npm test`: all pass on stable and 1.100.0.
- `npm run test:webview` and `npm run test:corpus`: all pass.

**Results (2026-10-12):** `npm run compile` (check-types + lint + build) exit 0; `npm test` 627 passing on stable and 627 on 1.100.0 (including the new ESC suite test); `npm run test:webview` 122 passing (14 happy-dom); `npm run test:corpus` 123 passing.

**After the review patches (2026-10-12):** compile and lint exit 0; `npm test` 627 passing on stable and on 1.100.0; `npm run test:webview` 128 passing; `npm run test:corpus` 123 passing.

**Manual checks:**
- In the dev host, keyboard only: Tab into the graph, use the arrows, Space and Enter, and see the ring.
- With a screen reader, if one is available (Orca on Linux): node names, and the banner announced.
- **Done by the user on 2026-10-12** in the dev host on VS Code **1.141.0** (the user updated their `code` from 1.103.2). Checked with the keyboard only: Tab in and Tab out, the arrows, Space, Enter to the YAML, Esc in two steps, and no focus ring after a mouse click. Result: "tested". Orca was optional and not reported.
- **The same day, every integration suite also passed on 1.140.0** (627), in a one-off run with a temporary config, besides 1.141.0 and 1.100.0.
