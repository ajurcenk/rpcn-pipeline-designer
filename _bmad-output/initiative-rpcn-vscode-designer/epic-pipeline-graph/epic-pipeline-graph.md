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

Completed at inception.

## Done when

1. Opening a detected config auto-opens its graph beside it in a locked group; an explicit Hide graph persists across reloads and suppresses auto-open.
2. For 100% of the corpus the graph shows every component, route and nested group, and clicking any node selects the right YAML (graph accuracy in CI); moving the cursor highlights its node.
3. The graph updates per keystroke and keeps the last valid graph with the banner while the YAML is broken; with no binary it shows the empty state.
4. Nodes show error and warning markers from the deduped diagnostics (AD-17), never by color alone.
5. A newcomer completes EXPERIENCE Flow 3 to a running pipeline in under 10 minutes; the CI `.vsix` carries it with the elkjs license notice.

## Boundaries

Owns `src/core` YAML → PipelineModel, ComponentCatalog and `nodeAt` (AD-2, AD-7, AD-16, AD-20), `src/shared/protocol.ts` (AD-5), `src/adapters/graphPanel` (AD-1 lifecycle, NodeStatusService AD-17), and `webview/` (React, @xyflow/react, elkjs; AD-3, AD-4). Read-only: no graph editing. CAP-6 here: auto-open. CAP-1 here: graph empty state and graph after Set path. CAP-14 here: graph-accuracy assertions.

## References

- parent — _bmad-output/initiative-rpcn-vscode-designer/initiative-rpcn-vscode-designer.md, section Done when
- spec — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, CAP-6–CAP-10, CAP-12, CAP-14
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-1–AD-8, AD-16, AD-17, AD-20
- ux — _bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md and DESIGN.md; mockups/key-editor-and-graph.html, mockups/key-binary-missing.html

## Notes

- Waits on epic-foundation because: the ComponentCatalog is built from the cached schema and the empty state needs binaryState.
- Waits on epic-smart-yaml-editing because: auto-open uses the DetectionRegistry and node status reads its deduped diagnostics.
