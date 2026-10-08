---
id: 10
type: story
title: "Keep lint findings on lines an edit did not touch"
parent: none
covers: ["CAP-3", "CAP-10"]
after: []
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# Keep lint findings on lines an edit did not touch

## Description

Lint diagnostics are cleared on the first edit after a save (E2 R3, AD-17), because lint reports line numbers for the saved file and an edit can make them point at the wrong line. The rule also clears every other finding when one Quick Fix is applied, so fixing several findings needs a save after each one (E2 retrospective F2). Ticket 2.22 ("Fix all") removes most of that friction without changing the rule. When this story is done, an edit drops only the findings on the lines it touched; the other findings stay, moved by the number of lines the edit added or removed, until the next save replaces them all.

## Acceptance Criteria

1. **Other findings survive a Quick Fix**
   **Given** findings on lines 6, 12 and 20 after a save
   **When** the Quick Fix on line 6 is applied
   **Then** the findings on lines 12 and 20 stay, with their Quick Fixes, and line 6's is gone
2. **Findings move with inserted lines**
   **Given** findings on lines 12 and 20
   **When** two lines are inserted above line 12
   **Then** the findings show on lines 14 and 22
3. **An edited line loses its finding**
   **Given** a finding on line 12
   **When** any character on line 12 changes, or the line is deleted
   **Then** that finding is removed
4. **Multi-line edits and undo**
   **Given** a paste over lines 10–15, or an undo of an earlier edit
   **When** the change is applied
   **Then** findings inside the changed span are removed and the rest are moved, never shown on a line they did not come from
5. **Save still replaces everything**
   **Given** any moved findings
   **When** the file is saved
   **Then** lint's fresh findings replace them all

## Boundaries

- Must not change: lint runs on save only (AD-12); Red Hat dedupe (R4); 2.22's "Fix all".
- AD-17 and R3 must be amended in this story: epic 3's NodeStatusService reads these diagnostics, so its node markers follow the moved findings.

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/epic-smart-yaml-editing-retrospective.md, F2 and A2 (user decision 2026-10-08: "go with D now, add a backlog story for B")
- code — src/adapters/vscode/diagnostics.ts (`invalidate`, the `onDidChangeTextDocument` handler)
- architecture — AD-17 (lint diagnostics cleared on the first edit after save)

## Notes

- Decide before epic 3's inception if possible, since AD-17's node markers depend on it.
- `TextDocumentChangeEvent.contentChanges` gives each change's range and text, which is enough to compute line shifts; several changes in one event apply in order.
