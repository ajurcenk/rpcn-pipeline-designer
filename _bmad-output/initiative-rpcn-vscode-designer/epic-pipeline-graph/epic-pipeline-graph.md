---
type: epic
title: "Read-only pipeline graph"
parent: initiative-rpcn-vscode-designer
covers: [CAP-1, CAP-6, CAP-7, CAP-8, CAP-9, CAP-10, CAP-12, CAP-14]
after: []
assignee: ""
risk: high
---

# Read-only pipeline graph

## Description

The graph panel beside the native YAML editor: a read-only view of input → processors → output with nested groups and resources, two-way navigation with the YAML, live updates that keep the last valid graph, and error and warning markers on nodes.

## Outcome

A developer sees and navigates a pipeline's structure next to its YAML and spots the faulty node at a glance; the spec's graph-accuracy and newcomer-under-10-minutes measures are the signal.

## Requirements

- E3 (R1) → CAP-6: The first time a detected file opens in a session, its graph opens beside it, that group is locked (best effort: VS Code exposes locking only as the `workbench.action.lockEditorGroup` command) and focus returns to the YAML editor; `redpandaConnect.autoOpenGraph = false` turns this off (AD-1, AD-18).
- E3 (R2) → CAP-12: Show graph / Hide graph are an editor-title toggle and Command Palette commands for detected files, with no default keybinding; Show graph marks the file detected for the session (`markDetected`); an explicit Hide is stored per file in `workspaceState`, survives a reload and suppresses auto-open until Show graph; closing the YAML tab closes its graph; panels are keyed by `uri.toString()` (AD-1, AD-18).
- E3 (R3) → architecture: `src/shared/protocol.ts` defines the `PipelineModel` and the full host ↔ webview message union; the webview's `ready` is answered with a complete snapshot (AD-5, AD-15).
- E3 (R4) → CAP-7: The core builds a `PipelineModel` from the YAML and a ComponentCatalog derived from the cached schema, with no built-in component table: a component with child processor lists or outputs is a group (so `switch`, `branch`, `try`/`catch`, `workflow`, brokers, and also `fallback`, `retry`, `while`, `parallel`, …); node ids follow AD-7 and ranges are UTF-16 `[start, end)` offsets (AD-2, AD-7, AD-16, AD-20).
- E3 (R5) → CAP-7: The webview lays every model out with elkjs; groups start expanded and can be collapsed; resources are standalone nodes; nothing can be dragged or edited; colours come only from DESIGN tokens (AD-3, AD-4).
- E3 (R6) → CAP-8: Clicking a node, or Enter on it, reveals, centres and selects its YAML range in the driving editor; moving the cursor highlights the node `nodeAt` finds, without moving focus; the text is never edited (AD-8, AD-16, AD-19).
- E3 (R7) → CAP-9: Every document change re-sends the complete model and unchanged nodes keep their position; a parse error keeps the last valid graph with the banner "YAML has errors — showing last valid graph.", and clicking the banner jumps to the error (AD-6).
- E3 (R8) → CAP-10: A NodeStatusService maps `LintDiagnostics.diagnosticsFor(uri)` to nodes with `nodeAt`: error beats warning, severity rolls up to group headers, status is its own message and is frozen while the banner shows, each state has a border plus its own icon (never colour alone), and hover shows the message verbatim (AD-17).
- E3 (R9) → CAP-1: With no usable binary the host draws no pipeline and the panel shows "No Redpanda Connect binary. The graph needs it to read the schema." with Install guide, Set path and Retry; after Set path or Retry the graph draws without reopening the file (AD-9, AD-20).
- E3 (R10) → CAP-7: With no pipeline keys the panel shows "Nothing to draw yet. Add an `input`, `pipeline` or `output` section."
- E3 (R11) → CAP-7: The graph follows EXPERIENCE's keyboard and screen-reader model: Tab, arrows, Enter, Space and Esc, announced node labels, the container named "Pipeline graph, read-only", and a `focusBorder` focus ring.
- E3 (R12) → CAP-14: For every corpus config on v4.100.0 and v4.112.0, the corpus harness compares the model (every component, route and nested group) with a recorded expected graph, and every node's range resolves back to that node through `nodeAt`.
- E3 (R13) → CAP-13: esbuild adds a browser bundle for the webview, and the `.vsix` carries it with the third-party notices (elkjs EPL-2.0, React, @xyflow/react) in NOTICE.

## Done when

1. Opening a detected config auto-opens its graph beside it (group locked where VS Code allows) and returns focus to the YAML, unless `autoOpenGraph` is off; an explicit Hide graph persists across reloads and suppresses auto-open.
2. For 100% of the corpus on v4.100.0 and v4.112.0 the model shows every component, route and nested group and every node's range maps back to it (graph accuracy in the CI corpus harness); clicking a node selects its YAML and moving the cursor highlights its node (VS Code integration tests).
3. The graph updates per keystroke and keeps the last valid graph with the banner while the YAML is broken; with no binary it shows the empty state and draws after Set path without reopening; with no pipeline keys it shows "Nothing to draw yet".
4. Nodes show error and warning markers from the deduped diagnostics (AD-17), never by color alone.
5. A newcomer completes EXPERIENCE Flow 3 to a running pipeline in under 10 minutes (a timed manual check the user runs); the CI `.vsix` carries the graph with the elkjs licence notice.

## Boundaries

Owns `src/core` YAML → PipelineModel, ComponentCatalog and `nodeAt` (AD-2, AD-7, AD-16, AD-20), `src/shared/protocol.ts` (AD-5), `src/adapters/graphPanel` (AD-1 lifecycle, NodeStatusService AD-17), and `webview/` (React, @xyflow/react, elkjs; AD-3, AD-4). Read-only: no graph editing. CAP-6 here: auto-open. CAP-1 here: graph empty state and graph after Set path. CAP-14 here: graph-accuracy assertions.

## References

- parent — _bmad-output/initiative-rpcn-vscode-designer/initiative-rpcn-vscode-designer.md, section Done when
- spec — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, CAP-1, CAP-6–CAP-10, CAP-12, CAP-14
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-1–AD-8, AD-15, AD-16, AD-17, AD-18, AD-20, Stack, Structural Seed
- ux — _bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md and DESIGN.md; mockups/key-editor-and-graph.html, mockups/key-binary-missing.html

## Notes

- Waits on epic-foundation because: the ComponentCatalog is built from the cached schema and the empty state needs binaryState.
- Waits on epic-smart-yaml-editing because: auto-open uses the DetectionRegistry and node status reads its deduped diagnostics.
- Note: the Show graph and Hide graph commands are contributed but hidden with no handler since 1.2; this epic enables them.
- Open question: no test exercises a real second `activate()` (needs a second extension host); decide at inception whether the graph's activation path gets an end-to-end test or stays a manual check (reviews of 1.4 and 1.6).
- Source: out-of-scope list in _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/story-refactor-sweep-plan.md, Implementation Notes (user decision 2026-10-06).
- Decision (user, 2026-10-08, "go with your recommendations"): Requirements R1–R13 and the revised Done when above. Groups are derived from the schema (any component with child processor lists or outputs), not limited to the spec's five named kinds (AD-20). Webview testing: model and layout logic in pure modules under vitest; happy-dom (new dev dependency) only for the keyboard and accessibility tests; rendering checked by hand. The second `activate()` (a real reload) stays a manual check. AD-17's clear-on-first-edit rule stays for this epic (backlog story 10 stays in the backlog), so lint markers clear on the first keystroke after a save. Retry is included on the no-binary empty state. Updates follow every keystroke as specified, measured on the largest corpus config; a debounce becomes a story only if that is slow. A closing refactor sweep is planned.
- Decision (user, 2026-10-08): EXPERIENCE Flow 1, the node error/warning rows and the editor-and-graph mockup reconciled at inception: `chek` and the missing `topic` are lint findings after save, not live schema errors (UX memlog).
- Source conflict: package.json titles "Show Graph" / "Hide Graph" vs EXPERIENCE "Show graph" / "Hide graph" (sentence case); the entry that enables the commands adopts EXPERIENCE's wording.
- Source conflict: lint findings are whole-line ranges starting at column 1 (E2 R3), while `nodeAt` maps one offset (AD-16); the line's leading indentation sits inside the parent node, so a marker would land one level too high. The status mapping uses the offset of the line's first non-whitespace character.
- Note: warnings on nodes come in practice only from `lint --deprecated`: Red Hat reports YAML syntax errors, and the served schema does not constrain component fields (AD-12).
- Decision (user, 2026-10-08, "approve and continue"): breakdown of 14 entries in `tickets.toml`. Tracer bullet is entry 1 (Show graph draws a flat pipeline and a click selects its YAML: webview bundle, dependencies and notices, minimal protocol, panel, flat model, elkjs). Contracts early: entry 2 completes the AD-5 protocol and the model with shared fixture models in `src/test/fixtures/models/`. The least certain part, group lock and focus on VS Code 1.100, is probed first as spike 14 and sets entry 10's approach.
- Decision (user, 2026-10-08): lanes. Host panel 1 → 6 → 7 → 8 → 9 → 10 is serialised because those entries share `src/adapters/graphPanel`, `webview/` and `src/extension.ts`; core 3 → 5; webview 4, then 11 after 10 (the webview lane is serial; 11 touches the same components and the lockfile). Entry 4 owns the vitest setup for webview tests. After 2, entries 3, 4 and 14 can run in parallel.
- Decision (user, 2026-10-08): 14 entries, above the typical 8–12, kept as one epic (mostly one lane, one owner). The closing refactor sweep is entry 12; the user's hands-on Flow 3 timing and reload check is entry 13 after it (hitl).
- Note: the epic is risk high; its check outside the tickets' own criteria is entry 13, the user's timed Flow 3 run and reload check.

