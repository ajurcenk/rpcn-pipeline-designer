---
id: 12
type: story
title: "The graph follows a file through Save As"
parent: none
covers: ["CAP-6", "CAP-12"]
after: []
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# The graph follows a file through Save As

## Description

AD-1 says every per-file registry is re-keyed on rename and on Save As. Ticket 3.10 does the rename through `workspace.onDidRenameFiles`. It leaves Save As out, because VS Code has no Save As event: the editor's document is swapped for a new URI and the old one closes.

Today, after a Save As:
- the old file's graph closes with its tab;
- the new file auto-opens its own graph the first time it shows;
- the old file's Hide, if any, stays with the old URI.

When this story is done, the open graph, its pan and zoom, its collapsed groups, and the file's Hide move to the new URI.

## Acceptance Criteria

1. **Saved file**
   **Given** a detected file with an open graph
   **When** the user runs File: Save As to a new path
   **Then** the same graph panel now follows the new file, with its title updated, and no second graph opens
2. **Untitled file**
   **Given** an untitled detected document with an open graph
   **When** it is saved for the first time
   **Then** the graph follows the saved file
3. **Hide moves**
   **Given** a hidden file
   **When** it is saved under a new name
   **Then** the new file is hidden and does not auto-open

## Boundaries

- Rename handling from 3.10 must keep working.
- A tab swap that is not a Save As must never re-key a graph.

## References

- source: ticket 3.10's plan, Open Question 1 (user decision 2026-10-09: "Leave out", add a backlog story).
- architecture: AD-1 (re-keyed on rename / Save As).
- code: `src/adapters/graphPanel/panels.ts` (the rename re-key added by 3.10).

## Notes

- **Candidate approach:** in one `tabGroups.onDidChangeTabs` event, a text tab for the panel's URI closes and a text tab with a new URI opens in the same group at the same index. Check that VS Code really reports Save As this way on 1.100.0 and on stable, for both saved and untitled files.
- **Testing:** Save As needs a dialog, so an integration test would have to simulate the tab swap. Real Save As is a manual check.
