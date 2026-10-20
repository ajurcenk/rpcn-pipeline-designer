---
id: 14
type: story
title: "The graph forgets a rename that never completes"
parent: none
covers: ["CAP-6", "CAP-12"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
status: done
---

# The graph forgets a rename that never completes

## Description

Ticket 3.10 records each rename announced by `workspace.onWillRenameFiles` in `GraphPanels.pendingRenames` (`src/adapters/graphPanel/panels.ts`) and drops it on the matching `onDidRenameFiles`. While a rename is pending, closing the old file's last tab does not close its graph (TAB_CLOSE), and the new name does not auto-open. A rename that fails or is cancelled after `onWillRenameFiles` never gets its `onDidRenameFiles`, so its entry stays for the rest of the session: the old file's graph no longer closes with its last tab, and a file later created at the new name never auto-opens. 3.10 rejected this as rare (review row 7).

When this story is done, a rename that never completes stops affecting tab close and auto-open.

## Acceptance Criteria

1. **Failed rename**
   **Given** a file with an open graph whose rename is announced and then fails
   **When** its last text tab closes
   **Then** its graph closes
2. **New name**
   **Given** the same failed rename
   **When** a detected file at the new name is first shown, with auto-open on
   **Then** its graph auto-opens
3. **Completed rename**
   **Given** a rename that completes
   **When** it is done
   **Then** RENAME from 3.10 behaves as today

## Boundaries

- Rename handling from 3.10 must keep working, folders included.

## References

- source: the 3.12 refactor sweep, item 8 (3.10 review row 7, rejected).
- code: `src/adapters/graphPanel/panels.ts` (`pendingRenames`, `tabsChanged`, `shown`, `renamed`).

## Notes

- **Candidate approach:** drop a pending rename after a timeout, or when its old URI is gone and no `onDidRenameFiles` came. `onWillRenameFiles` can be fired in a test with a `WorkspaceEdit` whose rename fails (the target exists).
- **Resolution:** done by 4.13, the refactor sweep (2026-10-17): a pending rename expires 30 s after its announcement in both the graph and the test-panel registries (`PendingRenames` in `src/adapters/graphPanel/tabs.ts`); RENAME_NEVER in suites 84 and 90.
