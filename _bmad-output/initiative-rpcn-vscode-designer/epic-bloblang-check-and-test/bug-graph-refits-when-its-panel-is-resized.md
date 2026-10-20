---
id: 19
type: bug
title: "Graph refits when its panel is resized"
parent: epic-bloblang-check-and-test
covers: [R8]
after: [13]
refined: true
severity: P2
hitl: false
risk: low
---

# Graph refits when its panel is resized

## Description

Opening a test panel puts it in a group below the graph (4.17), which halves the graph panel's height; the graph was fitted once to the tall panel and is never refitted, so its nodes end up below the visible area and the canvas looks empty. The graph webview refits its view when its container is resized, as long as the user has not panned or zoomed since the last fit.

## Acceptance Criteria

1. **Refit on resize**
   - Given the graph has been fitted (or restored from a fit) and the user has not panned or zoomed since,
   - When the graph's container changes size (for example when a test panel opens below it, or the user drags a group divider),
   - Then the graph is fitted again into the new size with the same rule as the first fit (`fitReadable`: between 75% and 100%, a graph still too wide starts at its input), at once, with no animation.
2. **The user's view is kept**
   - Given the user has panned or zoomed the graph (a move started by user input, not by a fit),
   - When the container is resized,
   - Then the viewport is left as the user set it. This also applies after the webview is recreated, since the "moved by the user" mark is kept with the saved viewport.
3. **Fit to view resets it**
   - Given the user has panned or zoomed,
   - When they use Fit to view,
   - Then later resizes refit again, as in 1.
4. **Nothing to fit**
   - Given no graph has been placed yet (no laid-out model with nodes),
   - When the container is resized,
   - Then nothing changes, and the first fit still happens on the first laid-out model, as today.
5. **No refit storm**
   - Given the container is resized repeatedly (a divider drag),
   - When the size settles,
   - Then the graph is refitted after the last change (debounced), not on every intermediate size.

Verify: Webview tests resize the graph's container (a stubbed `ResizeObserver`) and check criteria 1-5. The user sees the nodes after opening a test panel below the graph in the dev host.

## References

- `webview/src/Graph.tsx`: `fitReadable` (~line 67), the first fit and restore (`firstView`, ~lines 119-130), `onMoveEnd` saving the viewport (~line 325)
- `webview/src/test-setup.ts`: the `ResizeObserver` stub
- Found in the 4.13 manual check (2026-10-19); investigation: same behaviour on b602126, so it predates 4.13

- parent — _bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/epic-bloblang-check-and-test.md
