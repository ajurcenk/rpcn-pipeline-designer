---
id: 18
type: story
title: "Graph marker does not blink after the YAML is fixed"
parent: none
covers: ["CAP-15", "CAP-10"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Graph marker does not blink after the YAML is fixed

## Description

A Bloblang parse error marks its processor's graph node (ticket 4.6). While the YAML doesn't parse, the marker stays (AD-17). Once the YAML parses again, the node status is recomputed before 4.5 republishes its cached Bloblang error after its 300 ms debounce, so the marker disappears for about 300 ms and comes back (two `nodeStatus` posts). 4.6 documented this in CHANGELOG and EXPERIENCE; fixing it means changing 4.5's republish (for example, republishing the cached errors at once when the YAML parses again, or keeping the frozen Bloblang diagnostics until the next parse). Moved here by the 4.13 refactor sweep (user decision, 2026-10-17).

When this story is done, fixing a YAML syntax error elsewhere doesn't make an existing Bloblang marker blink.

## Notes

- Source: `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/story-bloblang-errors-on-graph-nodes-plan.md` (Implementation Notes, FROZEN; Review Triage row 3).
