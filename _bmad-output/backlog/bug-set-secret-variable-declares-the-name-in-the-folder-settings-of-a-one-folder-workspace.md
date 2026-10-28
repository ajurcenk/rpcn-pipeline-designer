---
id: 33
type: bug
title: "Set secret variable declares the name in the folder's settings of a one-folder workspace"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
estimate: ""
---

# Set secret variable declares the name in the folder's settings of a one-folder workspace

## Description

**Redpanda Connect: Set secret variable** adds the name to `redpandaConnect.secretEnv` in the folder's settings whenever a `.code-workspace` file is open, even when that workspace holds one folder. The README says the name goes to the workspace's settings with one folder open, and the Environment view's plain **Set variable** (ticket 31) chooses the level by the number of folders. In a one-folder workspace opened through a `.code-workspace` file, a secret's name lands in the folder's `.vscode/settings.json` and a plain variable lands in the `.code-workspace` file. The secret still works; the name is only in an unexpected file.

## Reproduction

1. Make a `.code-workspace` file that lists one folder, and open it.
2. Run **Redpanda Connect: Set secret variable**, pick that folder, enter a name and a value.
3. Actual: the name is added to `redpandaConnect.secretEnv` in the folder's `.vscode/settings.json`.
4. Expected: the name is added to `redpandaConnect.secretEnv` in the `.code-workspace` file's settings, as the README says and as ticket 31's level rule does for a plain variable.

## Cause Hypothesis

Ticket 30 picks the level from whether a workspace file is open, not from the number of workspace folders. Ticket 31 changed only its own level choice (its review row 6).

## Acceptance Criteria

1. **One folder through a workspace file**
   **Given** a workspace file with one folder
   **When** a secret is set for that folder
   **Then** its name is declared in the workspace's settings
2. **Other layouts are unchanged**
   **Given** a folder opened without a workspace file, a workspace with more than one folder, or no folder (or **No folder**)
   **When** a secret is set
   **Then** its name is declared where it is today: the workspace's settings, the folder's settings, the user settings
3. **The secret and the README agree**
   **Given** the fix
   **When** the README's **Set secret variable** paragraph is read
   **Then** it states the rule the command follows, the same rule as the Environment view's plain **Set variable**
4. **Tests cover the condition found and fixed**
   **Given** the test runs
   **When** they run
   **Then** a test that fails on the defect and passes on the fix covers the reproduction
5. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the name already lands in the workspace's settings, with the evidence recorded in Notes — this supersedes 1 to 4

## References

- parent — none
- source — _bmad-output/backlog/story-an-environment-view-shows-each-configs-variables-plan.md, Review Triage Log row 6
- source — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the entry from ticket 31 on ticket 30's level choice
- related — _bmad-output/backlog/story-secret-environment-variables-kept-in-the-secret-storage.md (ticket 30)

## Notes

- Decision (user, 2026-10-28): a name already declared in the folder's settings by the old rule stays where it is; the fix changes only where new names go.
