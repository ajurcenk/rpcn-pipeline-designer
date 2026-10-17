---
id: 17
type: bug
title: "A rename that overwrites a file keeps the wrong panel"
parent: none
covers: ["CAP-6", "CAP-12"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
severity: P3
estimate: ""
---

# A rename that overwrites a file keeps the wrong panel

## Description

When a rename moves a config onto a file that already has a graph or test panel (an overwrite rename, or two renames in one batch landing on one name), the registries keep the panel of the file that was overwritten and dispose the moved one (`renamed()` collision handling in `src/adapters/graphPanel/panels.ts` and `src/adapters/bloblangPanel/panels.ts`). The moved file's content is what now sits at that name, so its panel is the one that should survive. With two renames onto one key, the result depends on the registry's iteration order. Deferred from the pipeline-graph epic's interaction fixes and moved here by the 4.13 refactor sweep (user decision, 2026-10-17).

When this bug is fixed, an overwrite rename keeps the moved file's panel, and two renames onto one name give the same result whatever the order.

## Notes

- Source: `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` (rename collisions entry).
