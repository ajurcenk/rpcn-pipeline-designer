---
id: 8
type: story
title: "Bloblang completion on the left of an assignment"
parent: none
covers: ["CAP-4"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Bloblang completion on the left of an assignment

## Description

After a dot, Bloblang completion offers methods (2.19), narrowed by a known type (2.21), and after `this.` / `root.` the names already written (2.20). On the left of `=` (`root.user.` before ` = …`), a method is never valid: the target is a path being assigned. Methods are still offered there (recorded as a limit in the 2.19 review). When this is done, the left of an assignment offers only field names (for `root.` paths, the names already written), never methods or functions.

## Acceptance Criteria

1. **Assignment target**
   **Given** `root.user.§ = this.name` in a mapping
   **When** completion is requested at `§`
   **Then** no Bloblang methods are offered; fields already written under `root.user` are
2. **Right-hand side unchanged**
   **Given** `root.x = this.name.§`
   **When** completion is requested
   **Then** methods are offered as today
3. **`let` and `meta` targets**
   **Given** `let v§ =` or `meta foo§ =`
   **When** completion is requested
   **Then** no methods are offered

## Boundaries

- Must not change: Bloblang has no diagnostics or language server (AD-14); highlighting.

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-bloblang-function-and-method-completion-and-hover-plan.md, Review Triage Log #5 (left of `=` recorded as a limit)
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-refactor-sweep-plan.md, item 9

## Notes

- Bloblang statements can span lines (`root = if … { … }`); the scanner's statement start (`regionStart`) decides what counts as the left side.
