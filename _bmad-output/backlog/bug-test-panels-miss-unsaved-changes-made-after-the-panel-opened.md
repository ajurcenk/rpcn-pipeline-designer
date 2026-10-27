---
id: 25
type: bug
title: "Test panels may not notice that their config has unsaved changes"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
severity: P2
estimate: ""
---

# Test panels may not notice that their config has unsaved changes

## Description

The Bloblang test panels remember which configs have unsaved changes, and use it when a config is closed without saving: its panels go back to their saved processors (4.10). The record may miss changes typed after a panel opened, so closing such a config without saving could leave a panel on a processor that does not exist in the saved file when it is reopened.

## Reproduction

1. Open a saved config with a `mapping` processor and open its test panel.
2. Insert lines above the processor (the panel follows it) and do not save.
3. Close the config without saving, then reopen it.
4. Expected: the panel is on the processor at its saved position. Suspected: the panel stays on the position it had before closing.
Observed so far only indirectly: while writing a test for ticket 17, the panels' record (`hasUnsavedChanges`) stayed false after an edit; only a panel opened on an already modified config recorded it. The existing close-without-saving test passes, so the reproduction above has not been confirmed.

## Cause Hypothesis

The record is set from the document's modified state in the text change event, and VS Code may report the change before it marks the document modified; a later event with no content changes is ignored. Then the record is only right for a document that was already modified when its panel opened.

## Acceptance Criteria

1. **Unsaved changes are noticed whenever they are made**
   **Given** a config with an open test panel
   **When** the config is changed after the panel opened and closed without saving
   **Then** the panel is on its saved processor when the config is reopened
2. **A saved config is not treated as modified**
   **Given** a config whose changes were saved, or undone back to the saved text
   **When** it is closed
   **Then** its panels keep their processors
3. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers a change made after the panel opened
4. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the panel is already on its saved processor, with the evidence recorded in Notes — this supersedes 1 to 3

## References

- parent — none
- source — _bmad-output/backlog/bug-a-rename-that-overwrites-a-file-keeps-the-wrong-panel-plan.md, Implementation Notes (the OVERWRITTEN_DIRTY test)
- source — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the entry from ticket 17 on dirty tracking

## Notes

- Assumption: the user-visible effect is limited to closing without saving (the samples' "Save first" checks read the document itself).
