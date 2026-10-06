---
title: "EXPERIENCE — Redpanda Connect Designer for VS Code"
status: final
created: 2026-10-05
updated: 2026-10-05
sources:
  - ../brief-rpcn-vscode-designer/brief-rpcn-vscode-designer.md
  - ../brief-rpcn-vscode-designer/addendum.md
  - ../architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
---

# Redpanda Connect Designer — Experience Spine

## Foundation

**North star: smarter, not faster.** The designer does not try to replace typing YAML. It makes the YAML easier to understand and harder to get wrong. Every surface should answer one of these questions: *what does this pipeline do, where is it wrong, and what should go here?*

- **Form factor:** a desktop VS Code extension. The config file opens in VS Code's **native YAML editor** (left editor group), and a read-only **graph panel** opens beside it in its own, locked editor group (right). This is the Markdown-preview pattern. The YAML text is always the source of truth.
- **Layout authority:** architecture spine **AD-1** governs the two-group layout (native text editor + graph `WebviewPanel` beside it). There is no single-tab sash and no Split/Graph/YAML switcher. The addendum's `CustomTextEditorProvider` note is superseded.
- **UI system:** VS Code itself. All visual tokens live in `DESIGN.md` and resolve to the active theme. This spine specifies only the behavior VS Code doesn't already provide.
- **Graph is read-only in MVP.** It is for viewing and navigating only. All adding, removing, reordering and configuring happens in YAML. The brief was updated to match (graph read-only in the first release).
- **No graph without the binary.** Component structure comes from the user's binary's schema (AD-20). Without a resolved binary and schema, the graph panel never draws a pipeline; it shows the binary-missing empty state.
- Product context (users, scope, success criteria) lives in the sources and is not repeated here.

## Information Architecture

| Surface | Reached from | Purpose |
|---|---|---|
| YAML editor (left group) | Opening any config file | VS Code's native text editor with schema-aware editing from Red Hat YAML plus our schema: diagnostics, quick fixes, hover docs, completion, Bloblang highlighting, snippets. Undo/redo, git, search and multi-cursor all work as usual. |
| Graph panel (right group, locked) | Auto-opens beside a detected file; **Show graph** toggle | Read-only input → processors → output, nested group boxes, resources. Tab title "Graph: {filename}" `[ASSUMPTION]`. One panel per file, reused on re-open. Mock: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html) |
| Show graph / Hide graph toggle | Editor-title button on the YAML editor, Command Palette | Opens or closes the graph panel for the current file |
| Run session | Run action | Local Redpanda Connect run with logs in a dedicated Integrated Terminal per file. Mock: [mockups/key-run.html](mockups/key-run.html) |
| Binary-missing onboarding | Activation without a usable binary | Notification plus graph-panel empty state with recovery actions. Mock: [mockups/key-binary-missing.html](mockups/key-binary-missing.html) |

- **Two editor groups:** the YAML editor stays in its group on the left; the graph panel opens in the group beside it (right). On first open the extension locks the graph's group so other files don't open into it (best-effort, AD-1). Users resize the groups by dragging VS Code's own divider between editor groups; the extension adds no divider of its own.
- **Auto-open:** when a detected file is opened (first open per session, AD-18), the graph panel opens beside it automatically and focus returns to the YAML editor. A setting turns auto-open off; **Show graph** still works.
- **Show / Hide graph:** an editor-title button on the YAML editor (shown only for detected files), and a Command Palette command pair ("Show graph" / "Hide graph") toggle the panel. There is no default keybinding; users can bind the commands themselves. "Open in Designer" from earlier drafts is the **Show graph** command. Running Show graph on a file also marks it as detected for the session (AD-18).
- **Per-file memory:** the shown/hidden state of the graph is remembered **per file**. An explicit **Hide graph** is remembered for that file, **including across window reloads** (workspace state), and auto-open does not reopen the graph for that file until the user runs **Show graph** again. The graph panel closes on its own when the file's YAML tab is closed.
- **File detection:** files are recognized by their content (top-level `input` / `pipeline` / `output` / `buffer` / resource keys) plus a workspace pattern setting (AD-18).

**Mockups** live in [`mockups/`](mockups/): [key-editor-and-graph.html](mockups/key-editor-and-graph.html) (YAML editor + graph panel with error and warning nodes, plus the unparseable-YAML alt state), [key-binary-missing.html](mockups/key-binary-missing.html) and [key-run.html](mockups/key-run.html). **This spine wins on any conflict with a mockup.** Spine-only (no mock): Flow 3 and the Run-disabled state for untitled files; build them from this spine and `DESIGN.md` alone.

## Voice and Tone

The tone is terse, developer to developer, and VS Code-native. Use sentence case, name the exact thing, and don't add exclamation marks or cheerleading.

| Context | String |
|---|---|
| Invalid-YAML banner | "YAML has errors — showing last valid graph." |
| Binary-missing notification | "Redpanda Connect binary not found. Schema, validation, graph and Run need `rpk connect` or `redpanda-connect`." Actions: **Install guide** · **Set path** |
| Graph empty state (no binary) | "No Redpanda Connect binary. The graph needs it to read the schema." Actions: **Install guide** · **Set path** |
| Graph empty state (no pipeline keys) | "Nothing to draw yet. Add an `input`, `pipeline` or `output` section." `[ASSUMPTION]` |
| Node error / warning hover | The diagnostic message verbatim, e.g. "Missing property \"topic\"." or a `lint --deprecated` message |
| Quick Fix title | "Change to `topic`" `[ASSUMPTION]` |
| Toggle (editor title / Command Palette) | "Show graph" · "Hide graph" |
| Run terminal title | "Redpanda Connect: {filename}" (AD-13) |
| Status bar while running | "$(debug-stop) Stop pipeline" `[ASSUMPTION]` |
| Run disabled (untitled file) | Tooltip: "Save the file to run it." `[ASSUMPTION]` |

| Do | Don't |
|---|---|
| Pass Red Hat and `lint` messages through exactly as written; name the fix in the Quick Fix title ("Change to `topic`") | "Oops! Something went wrong in your config." |
| Pass runtime log lines through unchanged | Rewrite or soften runtime messages |
| Name the action: "Set path", "Show graph" | "Configure", "Fix it", "Open Designer" |

## Component Patterns

Behavioral only. Visual specs are in `DESIGN.md.Components`.

| Component | Behavioral rules |
|---|---|
| Pipeline node (`{components.pipeline-node}`) | Single-click selects the node and reveals and selects that component's YAML range in the left (driving) YAML editor. Hover shows the component type, plus the error or warning message if any. Nodes cannot be dragged or edited. Mock: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html) |
| Pipeline node (error) (`{components.pipeline-node-error}`) | Shown whenever the node's YAML range has an error diagnostic: a Red Hat schema error, or any `lint` finding that is not a deprecation. Hover shows the message. Click reveals the range, where the inline diagnostic and quick fix are available. |
| Pipeline node (warning) (`{components.pipeline-node-warning}`) | Shown only for Red Hat warning-severity diagnostics and `lint --deprecated` findings (AD-17), when the node has no error (error wins). Warning border plus a distinct warning icon, never color alone. Hover shows the warning message verbatim. Click reveals the range. Mock: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html) |
| Group box (`{components.group-box}`) | Used for `switch` / `branch` / `try`/`catch` / `workflow` / brokers. **Always expanded** when a file opens; collapse state is not persisted across sessions. Clicking the header chevron (or pressing the keyboard toggle) collapses or expands it. Clicking the header label reveals the whole block's YAML. Severity rolls up to the group header: a collapsed group that contains an error or warning shows that treatment on its header (AD-17). |
| Graph edge (`{components.graph-edge}`) | Not interactive. |
| Resources area | Resources (`*_resources`) are drawn as standalone nodes. Clicking one reveals its YAML. References from processors to resources are not drawn as edges `[ASSUMPTION]`. |
| Invalid-YAML banner (`{components.invalid-yaml-banner}`) | Appears while the YAML can't be parsed and disappears on the first parse that succeeds. It can't be dismissed. Clicking it jumps to the first parse error in the YAML editor `[ASSUMPTION]`. |
| Graph empty state (`{components.graph-empty-state}`) | Fills the graph panel. Actions are real buttons, reachable with the keyboard. |
| Show / Hide graph action (`{components.graph-toggle}`) | Editor-title action on the YAML editor of a detected file. Shows "Show graph" when the panel is closed and "Hide graph" when it is open. Same pair in the Command Palette; no default keybinding. Follows **Per-file memory** (Information Architecture). |
| YAML editor features | Inline diagnostics, each with a quick fix where one can be derived (e.g. a misspelled field becomes the nearest valid field). **Red Hat schema checks run live while typing.** **`rpk connect lint` runs on save only**; lint findings for the file clear on the first edit after a save and come back on the next save (AD-12, AD-17). A lint finding on the same line as a schema diagnostic is not shown twice. Hover shows the field's docs plus an example. Completion offers only keys and values that are valid at the cursor's location in the schema. Schema and lint come from the user's binary. |
| Run control | Started from an editor-title Run action and the Command Palette `[ASSUMPTION]`. **Disabled for untitled files** (tooltip "Save the file to run it."). If the file has unsaved changes, Run **auto-saves first, then runs** the saved file (no prompt). Each file has one terminal, "Redpanda Connect: {filename}", reused on re-run; the extension spawns the binary directly (nothing is typed into a shell). **Stop** (status-bar item or command) sends an interrupt to that file's process; the exit status shows in the status bar (AD-13). Mock: [mockups/key-run.html](mockups/key-run.html) |

## Graph ↔ YAML Sync

- **YAML → graph:** the graph re-renders on every keystroke. The layout stays stable across re-renders: unchanged nodes keep their position, and the collapse state is preserved when the node still exists `[ASSUMPTION]`.
- **Unparseable YAML:** the graph keeps showing the last valid render and the invalid-YAML banner is shown. Node error/warning treatments stay frozen as they were in the last valid render.
- **Graph → YAML:** node click reveals the node's YAML range in the left (driving) editor — the last-focused text editor for that file — scrolled to the center, and selects it. It never edits the text.
- **YAML cursor → graph:** moving the cursor in the driving YAML editor highlights the graph node whose YAML range contains the cursor (innermost node wins in nested groups). It is a highlight only: it does not move keyboard focus or open, close or reveal the graph panel.
- **Diagnostics timing:** schema errors and warnings appear live while typing. Lint-only findings (including deprecations) appear on save and clear on the next edit. Node error/warning treatments update whenever either result arrives.

## State Patterns

| State | Surface | Treatment |
|---|---|---|
| Valid config | Graph panel | Full graph, groups expanded |
| Config with errors | Graph + YAML | Affected nodes get `{components.pipeline-node-error}`. YAML shows inline diagnostics with quick fixes. |
| Config with warnings | Graph + YAML | Nodes with a Red Hat warning or a `lint --deprecated` finding (and no error) get `{components.pipeline-node-warning}`: warning border plus distinct warning icon. YAML shows the warning diagnostics. Mock: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html) |
| Unparseable YAML | Graph panel | Last valid graph plus banner. Mock: alt state in [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html) |
| Unparseable on first open (no prior valid render) | Graph panel | Banner over an empty canvas `[ASSUMPTION]` |
| No pipeline keys yet | Graph panel | Empty state: "Nothing to draw yet…" |
| Graph hidden | YAML editor | Only the YAML editor is open. The editor-title action reads "Show graph". Diagnostics and Run work as usual. |
| Binary missing or invalid | Global + Graph panel | Notification with **Install guide** / **Set path**. YAML keeps basic highlighting but has no schema diagnostics, completion or lint. The graph panel shows the binary-missing empty state with the same actions and draws **no** pipeline (AD-20). Mock: [mockups/key-binary-missing.html](mockups/key-binary-missing.html) |
| Binary set after missing | Graph + YAML | Schema loads, the graph renders and diagnostics appear without reopening the file `[ASSUMPTION]` |
| Schema loading | Graph panel | VS Code progress indicator in the editor-title area. No skeletons `[ASSUMPTION]` |
| Running | Terminal + status bar | Logs stream in the file's terminal. The status-bar Stop item is visible. Mock: [mockups/key-run.html](mockups/key-run.html) |
| Run exited / failed | Terminal + status bar | Terminal stays open with the exit output. The Stop item is replaced by the exit status. |
| Untitled file | Editor title | Run is disabled with the tooltip "Save the file to run it." Spine-only, no mock. |

## Interaction Primitives

- **Mouse:** click selects and reveals. Click the chevron to collapse/expand. Hover shows details. Pan and zoom the graph canvas, with a "Fit to view" action `[ASSUMPTION]`.
- **Keyboard (graph panel)** `[ASSUMPTION]`: `Tab` enters the graph and focuses the first node. Arrow keys move between nodes in flow order and into/out of groups. `Enter` reveals the node's YAML (focus moves to the YAML editor in the left group). `Space` toggles collapse on a group header. `Esc` returns focus to the graph container.
- **Commands:** "Show graph", "Hide graph", Run and Stop are all available in the Command Palette. Show/Hide graph has no default keybinding; users can bind the commands.
- **Banned:** dragging nodes to edit, inline editing in the graph, forms, modal dialogs, auto-running the pipeline, an in-panel view switcher.

## Accessibility Floor

Behavioral. Visual contrast comes from the active VS Code theme (`DESIGN.md`).

- Every node and group header can be reached and operated with the keyboard, as listed above. Nothing is mouse-only. The Show/Hide graph toggle is a command, not just a button, so it is reachable from the Command Palette and bindable.
- Screen-reader labels: nodes are announced as "{role} {type}{, label}{, has error: message}{, has warning: message}" (braces here mark optional template parts, not `DESIGN.md` tokens), e.g. "Processor switch, 3 cases, has error". Groups announce their expanded or collapsed state. The graph container has an accessible name: "Pipeline graph, read-only".
- The banner and the appearance of new errors are announced through a polite live region `[ASSUMPTION]`.
- The focus ring is always `{colors.focus}` (VS Code `focusBorder`) and is never removed.
- High-contrast themes are fully supported: `{colors.contrast-border}` outlines every node, group and banner.
- No color-only signals. Errors and warnings always combine an icon and a border (with distinct icons), and the banner has an icon and text.
- Reduced motion (VS Code / OS setting) turns off pan and zoom animation `[ASSUMPTION]`.

## Inspiration & Anti-patterns

- **Lifted from Kestra:** a topology view kept in sync with schema-validated YAML (addendum).
- **Lifted from VS Code Markdown preview:** the source in the native editor, a live read-only view beside it, toggled from the editor title.
- **Differentiated from Cloud Visual tab:** local-first, uses the user's own binary, and lives in the editor. Unlike Cloud, the graph here is read-only in MVP: the YAML is the one place where editing happens.
- **Rejected:** per-component-type color coding, a brand theme, form-based editing in MVP, and an editor embedded in the webview.

## Key Flows

### Flow 1 — Untangling an inherited pipeline (Anna, platform engineer, Monday morning)

Anna inherited a 300-line pipeline from a colleague who has left. Orders are showing up in the `payments` topic. Mock: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html) (steps 5–8).

1. Anna opens `orders-pipeline.yaml` from the repo. It opens in the native YAML editor; the file is detected by its content and the graph panel auto-opens beside it in the right group. Focus returns to the YAML editor.
2. The graph shows `kafka_franz` input → a chain of processors → a `switch` output group with three cases, each a `kafka_franz` output. All groups are expanded.
3. She drags the divider between the editor groups to give the graph panel more room, then fits the graph to view to see the whole flow at once.
4. She follows the flow to the `switch` group and sees that cases 1 and 2 both point to output nodes she recognizes by their labels.
5. **Climax:** she clicks the case-2 output node. The YAML editor on the left scrolls to and selects that case's `check` and `output` block. She hovers over `check`; the field docs and example explain that cases are evaluated in order and the first match wins. Case 1's check, `this.type.has_prefix("pay")`, is broader than intended and also catches `payout_order` events. The graph showed her where to look, and the YAML explained why.
6. She tightens case 1's check in the YAML. The graph re-renders as she types. For a moment the banner reads "YAML has errors — showing last valid graph." It disappears when the expression is valid again.
7. She makes a typo, `chek`. While she is still typing, the schema check flags it: the case node gets the error treatment and the YAML shows the inline diagnostic with the quick fix "Change to `check`".
8. She saves. `lint` runs on save and reports that `fields` on the `unknown_region` log processor is deprecated; that node gets the warning treatment (lint's own report of `chek` is on the same line as the schema error, so it is not shown twice).
9. She applies the quick fix and the error treatment clears. The fix is an edit, so the lint warning clears too and returns on her next save. She leaves the deprecation for a follow-up ticket.

Failure: the YAML stays unparseable → the graph keeps the last valid render with the banner, and clicking the banner jumps to the parse error.

### Flow 2 — First open on a fresh machine, then Run (Anna, new laptop)

Mock: [mockups/key-binary-missing.html](mockups/key-binary-missing.html), [mockups/key-run.html](mockups/key-run.html).

1. Anna opens the same repo on a new laptop that has no `rpk`. The notification reads "Redpanda Connect binary not found…" with **Install guide** · **Set path**.
2. The graph panel beside the YAML shows the binary-missing empty state with the same two actions and no graph. The YAML still has basic highlighting.
3. She installs `rpk`, then chooses **Set path** and points it at the binary.
4. **Climax:** without reopening anything, the schema loads, the graph draws the full pipeline and diagnostics appear in the YAML.
5. She clicks Run. A terminal named "Redpanda Connect: orders-pipeline.yaml" opens and streams the logs. A status-bar Stop item appears.
6. She stops the pipeline from the status bar; the process gets an interrupt and shuts down. The terminal stays open with the final output and the status bar shows the exit status.

Failure: the binary at the chosen path isn't a valid Redpanda Connect binary → the notification appears again with the same actions, and the graph panel keeps the empty state.

### Flow 3 — From an empty file to a first running pipeline (Tomás, newcomer)

`[ASSUMPTION]` Tomás, a backend developer new to Redpanda Connect, needs to pipe webhook events from an HTTP endpoint into a Redpanda topic.

**Success criterion:** a newcomer goes from an empty/new file to a first running pipeline in **under 10 minutes**. Spine-only, no mock.

1. Tomás creates and saves `webhooks.yaml` and types `input:`. Content detection now recognizes the file, and the **Show graph** button appears in the editor title. Auto-open fires only on open, so he clicks **Show graph**. The graph panel opens beside the YAML and shows "Nothing to draw yet…".
2. He inserts the input snippet and picks `http_server`. An input node appears in the graph as he types.
3. Under `http_server`, completion offers only the fields valid there. He picks `path` and sets `/webhooks`. Hovering `path` shows its docs with an example.
4. He adds `pipeline: processors:` with a `mapping` processor. The Bloblang in the mapping is highlighted as Bloblang (`root = this`, `root.received_at = now()`). A processor node joins the graph on the next keystroke.
5. He adds `output:` and picks `kafka_franz` from completion. The graph now reads input → mapping → output, growing with each keystroke.
6. He types `topci: webhook-events`. The live schema check flags it right away: the output node gets the error border and icon, and the YAML shows the inline diagnostic. He applies the quick fix "Change to `topic`" and the error treatment clears.
7. He clicks Run. The unsaved changes auto-save, which also runs `lint` (no findings), then the terminal "Redpanda Connect: webhooks.yaml" opens and streams the logs. The status-bar Stop item appears.
8. He sends a test request to `/webhooks` with `curl`.
9. **Climax:** the terminal logs show the first message written to `webhook-events`, well under 10 minutes after he created the empty file.

Failure: no binary on the machine → Flow 2 steps 1–4 apply before Flow 3 step 2. Failure: he works in an untitled buffer instead of saving `webhooks.yaml` in step 1 → Run is disabled with "Save the file to run it."

## Deferred (later phases, not specced)

- Data-flow visualization between steps.
- Highlighting nodes from errors in Run logs.
- Visual editing (add/remove/reorder/configure in the graph), including nested structures.
- Lint while typing (architecture Deferred; revisit if save-only lint feels slow).
- Restoring the graph panel after a window reload (architecture Deferred; reopens via auto-open or Show graph; an explicit Hide still persists).
- Lint-warning flicker is accepted for the POC: a deprecation warning clears on the first edit after save and returns on save (Flow 1 step 9). Revisit with the architecture's "lint while typing" deferral.
- BYOC deploy, testing, AI assist, metrics, debugging (brief Vision).

## Open Questions

