---
id: 15
type: bug
title: "YAML editor loses focus during cursor moves on VS Code 1.100"
parent: none
covers: ["CAP-8"]
after: []
assignee: ""
refined: false
hitl: false
risk: medium
severity: P2
estimate: ""
---

# YAML editor loses focus during cursor moves on VS Code 1.100

## Description

The 3.7 integration test "CURSOR / CURSOR_SAME / CURSOR_OUTSIDE / FOCUS" (`src/test/integration/suites/81-graph-navigation.ts:155`) fails on VS Code 1.100.0 in CI with "the YAML editor is active after moves within the node": after a few cursor moves inside one node, `vscode.window.activeTextEditor` is `undefined`. It failed in CI at f3242f4 (attempt 1; the rerun passed), at 8243faa and at 6b7a442, and passed in every CI run before f3242f4 and in every local run. f3242f4 is ticket 3.15, which added "focus comes back to the graph after it reappears" (retro finding F5). Either the graph webview takes focus from the editor on 1.100 (a regression users would meet: typing goes nowhere after moving the cursor), or 1.100 reports `activeTextEditor` late (a test-timing problem, spike 3.14). This ticket finds out which and fixes it. CI on `main` is red until it does.

## Acceptance Criteria

1. **Cause found**
   **Given** the failing test on VS Code 1.100.0
   **When** it is run repeatedly (locally under `xvfb-run`, and in CI)
   **Then** the plan records whether the webview takes focus (its focus restore runs while the YAML editor has focus) or only `activeTextEditor` lags
2. **Focus stays in the editor**
   **Given** a graph open beside a YAML file on VS Code 1.100 and 1.141
   **When** the cursor moves within a node, between nodes and outside every node
   **Then** the YAML editor keeps focus and the graph panel never becomes active
3. **The 3.15 focus restore still works**
   **Given** the graph had keyboard focus when it was hidden
   **When** it appears again
   **Then** focus comes back to the graph, as the 3.15 tests require
4. **Stable in CI**
   **Given** the fix
   **When** CI runs the suite on stable and 1.100.0
   **Then** the test passes in 10 consecutive runs of that suite on 1.100.0, without its focus assertion being weakened

## References

- test — src/test/integration/suites/81-graph-navigation.ts, CURSOR / CURSOR_SAME / CURSOR_OUTSIDE / FOCUS
- plan — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/story-graph-interaction-fixes-across-tickets-plan.md (3.15, F5 focus restore)
- findings — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/spike-3-14-findings/findings.md (focus on VS Code 1.100)
- note — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the 3.7 CURSOR flake entry

## Notes

- Evidence: CI runs 38311464573 (8243faa) and 38323410082 (6b7a442) fail on the floor (1.100.0) run only; stable passes 645.
