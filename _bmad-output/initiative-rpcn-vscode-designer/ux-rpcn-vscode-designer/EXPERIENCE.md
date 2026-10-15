---
title: "EXPERIENCE — Redpanda Connect Designer for VS Code"
status: final
created: 2026-10-05
updated: 2026-10-06
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
| Binary-missing notification | "Redpanda Connect binary not found. Schema, validation, graph and Run need `rpk connect` or `redpanda-connect`." Actions: **Install guide** · **Set path** · **Retry** |
| Binary-invalid notification | "Redpanda Connect at `{path}` can't be used: {reason}." Same three actions. `{reason}` is one of: "version {version} is older than the required v{min}", "it did not report a version", "it reported a version that can't be read", "its version check exited with an error", "it timed out", "it could not be started", "a relative path needs an open workspace folder" |
| Graph empty state (no binary) | "No Redpanda Connect binary. The graph needs it to read the schema." Actions: **Install guide** · **Set path**; plus **Retry** `[ASSUMPTION]` |
| Graph empty state (no pipeline keys) | "Nothing to draw yet. Add an `input`, `pipeline` or `output` section." `[ASSUMPTION]` |
| Node error / warning hover | The diagnostic message verbatim, e.g. lint's "field topic is required" or "field fields is deprecated" |
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
| Pipeline node (error) (`{components.pipeline-node-error}`) | Shown whenever the node's YAML range has an error diagnostic: any `lint` finding that is not a deprecation, or a Red Hat diagnostic (in practice a YAML syntax error; the schema does not constrain component fields, AD-12). Hover shows the message. Click reveals the range, where the inline diagnostic and quick fix are available. |
| Pipeline node (warning) (`{components.pipeline-node-warning}`) | Shown only for Red Hat warning-severity diagnostics and `lint --deprecated` findings (AD-17; in practice the deprecation findings), when the node has no error (error wins). Warning border plus a distinct warning icon, never color alone. Hover shows the warning message verbatim. Click reveals the range. Mock: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html) |
| Group box (`{components.group-box}`) | Used for `switch` / `branch` / `try`/`catch` / `workflow` / brokers. **Always expanded** when a file opens; collapse state is not persisted across sessions. Clicking the header chevron (or pressing the keyboard toggle) collapses or expands it. Clicking the header label reveals the whole block's YAML. Severity rolls up to the group header: a collapsed group that contains an error or warning shows that treatment on its header (AD-17). |
| Graph edge (`{components.graph-edge}`) | Not interactive. |
| Resources area | Resources (`*_resources`) are drawn as standalone nodes. Clicking one reveals its YAML. References from processors to resources are not drawn as edges `[ASSUMPTION]`. |
| Invalid-YAML banner (`{components.invalid-yaml-banner}`) | Appears while the YAML can't be parsed and disappears on the first parse that succeeds. It can't be dismissed. Clicking it jumps to the first parse error in the YAML editor `[ASSUMPTION]`. |
| Graph empty state (`{components.graph-empty-state}`) | Fills the graph panel. Actions are real buttons, reachable with the keyboard. |
| Show / Hide graph action (`{components.graph-toggle}`) | Editor-title action on the YAML editor of a detected file. Shows "Show graph" when the panel is closed and "Hide graph" when it is open. Same pair in the Command Palette; no default keybinding. Follows **Per-file memory** (Information Architecture). |
| YAML editor features | Inline diagnostics, each with a quick fix where one can be derived (a misspelled field becomes the nearest valid field, an invalid option the nearest valid option), plus **Fix all** when two or more findings have a clear fix. **YAML syntax errors show live while typing** (Red Hat). **`rpk connect lint` runs on save only** and is the Redpanda Connect validation; lint findings for the file clear on the first edit after a save and come back on the next save (AD-12, AD-17). A lint finding on the same line as a schema diagnostic is not shown twice. Hover shows the field's docs plus an example and its options. Completion offers the keys valid at the cursor and a field's documented options (any string stays valid), also in empty component blocks, values and list items, where it can insert a new component's required fields. Inside Bloblang, completion offers functions, methods and names already written, and hover shows their docs. Starter snippets appear only in Redpanda Connect files. Schema, docs and lint come from the user's binary. |
| Run control | Started from an editor-title Run action and the Command Palette `[ASSUMPTION]`. **Disabled for untitled files** (tooltip "Save the file to run it."). If the file has unsaved changes, Run **auto-saves first, then runs** the saved file (no prompt). Each file has one terminal, "Redpanda Connect: {filename}", reused on re-run; the extension spawns the binary directly (nothing is typed into a shell). **Stop** (status-bar item, command, or Ctrl+C in the terminal) sends an interrupt to that file's process; if it is still running after 10 s it is killed, and pressing Stop again kills it at once. The exit status shows in the status bar: "Pipeline stopped" for a run you stopped, otherwise "Pipeline exited (code N)" (AD-13). The editor-title Run follows each editor's own file. Untitled files show a disabled "Save the file to run it." entry instead of Run. Mock: [mockups/key-run.html](mockups/key-run.html) |

## Graph ↔ YAML Sync

- **YAML → graph:** the graph re-renders on every keystroke. The layout stays stable across re-renders: unchanged nodes keep their position, and the collapse state is preserved when the node still exists `[ASSUMPTION]`.
- **Unparseable YAML:** the graph keeps showing the last valid render and the invalid-YAML banner is shown. Node error/warning treatments stay frozen as they were in the last valid render.
- **Graph → YAML:** node click reveals the node's YAML range in the left (driving) editor — the last-focused text editor for that file — scrolled to the center, and selects it. It never edits the text.
- **YAML cursor → graph:** moving the cursor in the driving YAML editor highlights the graph node whose YAML range contains the cursor (innermost node wins in nested groups). It is a highlight only: it does not move keyboard focus or open, close or reveal the graph panel.
- **Diagnostics timing:** Red Hat's YAML syntax errors (and the few schema errors it can still detect) appear live while typing. Lint findings, which carry the Redpanda Connect errors and deprecations, appear on save and clear on the next edit. Node error/warning treatments update whenever either result arrives.

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
| Binary missing or invalid | Global + Graph panel | One warning notification per transition into missing or invalid, including the first check at activation. A refresh or **Retry** that leaves the state unchanged shows nothing; dismissing does nothing. Actions: **Install guide** opens https://docs.redpanda.com/connect/install/; **Set path** picks a file, saves it as `redpandaConnect.binaryPath` (user scope) and re-checks; **Retry** re-checks. If the state is still unusable after Set path, the warning shows again and the output log records what the picked path resolved to. YAML keeps basic highlighting but has no schema diagnostics, completion or lint. The graph panel shows the binary-missing empty state with **Install guide** / **Set path** (plus **Retry** `[ASSUMPTION]`) and draws **no** pipeline (AD-20). Mock: [mockups/key-binary-missing.html](mockups/key-binary-missing.html) |
| Binary set after missing | Graph + YAML | Schema loads, the graph renders and diagnostics appear without reopening the file `[ASSUMPTION]` |
| Schema loading | Graph panel | VS Code progress indicator in the editor-title area. No skeletons `[ASSUMPTION]` |
| Running | Terminal + status bar | Logs stream in the file's terminal. The status-bar Stop item is visible. Mock: [mockups/key-run.html](mockups/key-run.html) |
| Run exited / failed | Terminal + status bar | Terminal stays open with the exit output. The Stop item is replaced by the exit status. |
| Untitled file | Editor title | Run is disabled with the tooltip "Save the file to run it." Spine-only, no mock. |
| Bloblang syntax error while typing | YAML editor | About 300 ms after typing stops, a Bloblang syntax error in a `mapping` / `mutation` processor is underlined (Error, source `Bloblang`) at the binary's line and column with the binary's message; it clears once the mapping parses. None while the YAML does not parse, without a usable binary, or in untitled files. An unset `${VAR}` shows nothing (one output-channel line). On save, lint's duplicate of the same error is hidden. The graph marks the error's processor node like any other error (border and icon, rolled up to collapsed groups, the binary's message on hover); while the YAML does not parse the marker stays, and once it parses again the marker returns together with the underline, about 300 ms later (the debounce) (AD-17). Spine-only, no mock. |
| Bloblang test panel: running, result, Run on change off | Bloblang test panel | Header: the processor's title and kind, and a status pill: "Running…" while a run is in flight, then `✓ Ran in <N> ms · <binary>` for an output (other results: their own pills, below). Toolbar: **Run on change** (checkbox, on by default) and **Run** (disabled while the content is empty). Input and Output columns, each with Content and Metadata tabs; the input's Metadata tab is an editable Key / Value table (**+ Add metadata**, **Remove** per row, a count of rows with a key). With Run on change on, a content or metadata edit, or an edit to the mapping, runs the current input 300 ms after the last change, and a reloaded panel runs its restored input once; only the latest input's result shows. With it off, nothing runs until **Run**. A result: the output content pretty-printed when it is JSON, the lines of each added or changed top-level field marked with a tint and a 2px left bar; the output's Metadata tab a read-only table with added and changed keys marked; the footer "Changed:" with `+field`, `~field`, `−field` and `@key` tags (or "No changes"), so the marks never rest on colour alone. Content, metadata rows, the selected tabs and the toggle survive a reload. Mock: [../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html](../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html) (success state). |
| Bloblang test panel: parse error | Bloblang test panel | Pill `✕ Syntax error · not run`. An alert card (`role="alert"`, error colours of the theme) "Mapping doesn't parse" with the subtitle `mapping line L, char C · <file> line F`, the binary's `blobl` message and caret excerpt, and **Go to line F**. Footer: "Fix the mapping to run it again." The position is the one the editor's live diagnostic underlines; the run's own config-relative lint position is never shown. An edit that fixes it (with Run on change) replaces the card with the output. Mock: [../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html](../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html) (syntax error state, without its per-error explanation). |
| Bloblang test panel: mapping error | Bloblang test panel | Pill `✕ Mapping failed on this input`. An alert card "Failed on mapping line N", subtitle `<file> line F`, the binary's message and **Go to line F**; without a `failed assignment (line N)` in the message, "The mapping failed on this input" and no button. Footer: "Showing the last successful output, dimmed." when there is one. No Copy error. Mock: [../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html](../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html) (fails state). |
| Bloblang test panel: invalid input | Bloblang test panel | Pill `✕ Input not valid for this mapping`. An alert card "This input can't be read by the mapping" with the binary's message and the hint "The mapping reads the message as JSON (`this`); check the input's Content." No button. Spine-only, no mock. |
| Bloblang test panel: deleted | Bloblang test panel | Pill `⊘ Message deleted · <N> ms` in the warning tone. A dashed info card "The mapping deleted this message" (no matched line, no button). Footer: "No output and no metadata." Nothing is dimmed. Mock: [../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html](../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html) (deleted state, without its matched line). |
| Bloblang test panel: run could not happen | Bloblang test panel | Pill `✕ Not run`. An alert card "The test could not run" with the message verbatim (an unset `${VAR}`, a timeout, or a run that races the loss of the binary: "No Redpanda Connect binary."). Spine-only, no mock. |
| Bloblang test panel: no binary | Bloblang test panel | While the binary is not usable (missing, invalid or not yet resolved), the header (title and kind) stays and the status pill, the toolbar and the Input / Output columns are replaced by a region named "No Redpanda Connect binary": the bold title "No Redpanda Connect binary", the text "The test panel runs mappings with your own binary, so results match the version you deploy." and **Install guide**, **Set path** and **Retry**, which run the same actions as the binary warning and the graph's empty state. Announced once in the polite live region on entry. Nothing runs in this state (no Run on change, no restored run), and a result shown when the binary was lost is hidden. The input (content, metadata rows, tabs, Run on change) is kept. When the binary becomes usable, the panel leaves the state and runs its current input once, whether Run on change is on or off (an empty content runs nothing), without reopening. Mock: [../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html](../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html) (no-binary state). |
| Bloblang test panel: saved samples | Bloblang test panel | The toolbar starts with "Sample" and a picker of the mapping's samples, then **New sample**, **Rename** and **Delete**, then Run on change and Run; under it, "Saved in <file>" while the mapping has samples. The samples live in `<config>.samples.json` beside the config (AD-22; the prototype's `.rpcn/samples/…` location is not used), linked by the processor's `label`, else its path. **New sample** with no samples saves the current input as "sample 1"; otherwise it adds an empty "sample N" (the first free N), selects it and runs nothing. Picking a sample makes it the input and runs it (with Run on change off too), and the choice is saved. **Rename** turns the picker into a text field: Enter saves, Esc and blur cancel; a name must be 1–100 characters after trimming and unique, otherwise "Name must be 1–100 characters" / "A sample with this name exists" shows inline and the field stays. **Delete** asks with a VS Code modal, `Delete sample "<name>"?` with **Delete**; the neighbour sample is selected, and with none left the input stays as unsaved input. Edits to the selected sample's content or metadata are saved 300 ms after the last one. With no sample selected the picker shows "Unsaved input" and the input is the panel's own, as before. An edit of the file on disk, or a save in VS Code, reloads it, and a changed selected sample replaces the input and runs (Run on change rules). A file that can't be read is never overwritten: "The samples file can't be read: <reason>" shows and the sample controls are disabled until it reads again. Untitled configs have no sample controls. Mock: [../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html](../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html) (toolbar). |
| Bloblang test panel: dimmed output | Bloblang test panel | After a parse error, a mapping error, an invalid input or a run that could not happen, the last `ok` output since the panel opened (content or metadata, per the selected tab) shows below the card, dimmed, without change marks, labelled "Last successful output". None before the first `ok`. Mock: [../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html](../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html) (fails state). |
| Bloblang test panel: end-of-line hint | YAML editor | While a panel's latest result is a mapping error with a file line, that line ends with ` ✕ fails on this input` (an `after` decoration, error foreground, italic; one decoration type for all panels). It clears on any other result, when the line leaves the processor, and when the panel closes. **Go to line** shows the YAML in its editor group, the cursor at the start of the line (a line past the end clamps), revealed in the centre, and the editor takes focus. Mock: [../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html](../brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html) (fails state, without the sample name). |

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
7. She makes a typo, `chek`, and saves. `lint` runs on save and reports it (`field chek not recognised`): the case node gets the error treatment and the YAML shows the inline diagnostic with the quick fix "Change to `check`". Lint also reports that `fields` on the `unknown_region` log processor is deprecated; that node gets the warning treatment.
8. She applies the quick fix and the error treatment clears. The fix is an edit, so the lint warning clears too and returns on her next save.
9. She saves again; only the deprecation comes back, and she leaves it for a follow-up ticket.

Failure: the YAML stays unparseable → the graph keeps the last valid render with the banner, and clicking the banner jumps to the parse error.

### Flow 2 — First open on a fresh machine, then Run (Anna, new laptop)

Mock: [mockups/key-binary-missing.html](mockups/key-binary-missing.html), [mockups/key-run.html](mockups/key-run.html).

1. Anna opens the same repo on a new laptop that has no `rpk`. The notification reads "Redpanda Connect binary not found…" with **Install guide** · **Set path** · **Retry**.
2. The graph panel beside the YAML shows the binary-missing empty state with **Install guide** · **Set path** and no graph. The YAML still has basic highlighting.
3. She installs `rpk` on her PATH, then chooses **Retry**. (If the binary isn't on PATH, she chooses **Set path** and points it at the file.)
4. **Climax:** without reopening anything, the schema loads, the graph draws the full pipeline and diagnostics appear in the YAML.
5. She clicks Run. A terminal named "Redpanda Connect: orders-pipeline.yaml" opens and streams the logs. A status-bar Stop item appears.
6. She stops the pipeline from the status bar; the process gets an interrupt and shuts down. The terminal stays open with the final output and the status bar shows the exit status.

Failure: Set path points at a file that can't be used → the warning appears again with the same three actions, the output log says what the picked path resolved to, and the graph panel keeps the empty state. Failure: Retry with nothing changed → no new warning; the graph panel keeps the empty state.

### Flow 3 — From an empty file to a first running pipeline (Tomás, newcomer)

`[ASSUMPTION]` Tomás, a backend developer new to Redpanda Connect, needs to pipe webhook events from an HTTP endpoint into a Redpanda topic.

**Success criterion:** a newcomer goes from an empty/new file to a first running pipeline in **under 10 minutes**. Spine-only, no mock.

1. Tomás creates and saves `webhooks.yaml` and types `input:`. Content detection now recognizes the file, and the **Show graph** button appears in the editor title. Auto-open fires only on open, so he clicks **Show graph**. The graph panel opens beside the YAML and shows "Nothing to draw yet…".
2. He inserts the input snippet and picks `http_server`. An input node appears in the graph as he types.
3. Under `http_server`, completion offers only the fields valid there. He picks `path` and sets `/webhooks`. Hovering `path` shows its docs with an example.
4. He adds `pipeline: processors:` with a `mapping` processor. The Bloblang in the mapping is highlighted as Bloblang (`root = this`, `root.received_at = now()`). A processor node joins the graph on the next keystroke.
5. He adds `output:` and picks `redpanda` from completion (or its snippet). The graph now reads input → mapping → output, growing with each keystroke.
6. He types `topci: webhook-events` and saves. Lint flags it: the output node gets the error border and icon, and the YAML shows the inline diagnostic. He applies the quick fix "Change to `topic`" and the error treatment clears.
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

