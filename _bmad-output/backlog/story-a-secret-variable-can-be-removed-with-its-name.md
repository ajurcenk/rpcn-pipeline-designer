---
id: 39
type: story
title: "A secret variable can be removed with its name"
parent: none
covers: []
after: [30, 31]
assignee: ""
refined: true
hitl: false
risk: low
estimate: ""
---

# A secret variable can be removed with its name

## Description

A secret variable has a name in `redpandaConnect.secretEnv` (a settings file, which can be committed) and a value in VS Code's secret storage on this machine (ticket 30). The Environment view adds both (ticket 31), but its Remove, and **Redpanda Connect: Remove secret variable**, delete only the value. The row then stays as "no value on this machine" with no action, and removing the name means editing the right settings file by hand. When this is done, a declared name with no value can be removed from the view, and removing a secret that has a value offers to remove its name too.

## Acceptance Criteria

1. **A name with no value**
   **Given** a secret declared in `redpandaConnect.secretEnv` with no value on this machine
   **When** the user chooses Remove name on its row
   **Then** the name is taken out of `redpandaConnect.secretEnv` at the level that declares it (the setting removed there when no name is left), and the row is gone
2. **A secret with a value**
   **Given** a secret with a stored value
   **When** the user chooses Remove on its row, or runs Remove secret variable for it
   **Then** they choose between the value only (the default, as today) and the value and its name; the choice says which settings file the name is removed from
3. **The level is right**
   **Given** a name declared at the folder, workspace or user level
   **When** its name is removed
   **Then** only the list that holds it changes; when that list is not the one the config uses (lists do not merge, the most specific wins), the user is told where the name still comes from
4. **Cancel changes nothing**
   **Given** any of these prompts
   **When** the user cancels
   **Then** no value and no setting changes
5. **Failures are shown**
   **Given** a settings write or a secret storage delete that fails
   **When** the removal runs
   **Then** an error says what was not removed and why, with no value in it; a value is not deleted when its name could not be removed, or the reverse is reported
6. **Nothing else changes**
   **Given** plain variables, the env file and the other secret commands
   **When** they are used
   **Then** they behave as today

## Boundaries

- Must not change: how secrets reach the commands, their precedence, masking, or Clear stored secrets (values only, every folder).

## References

- parent — none
- related — _bmad-output/backlog/story-secret-environment-variables-kept-in-the-secret-storage.md (ticket 30: the name and value, Remove secret variable)
- related — _bmad-output/backlog/story-an-environment-view-shows-each-configs-variables.md (ticket 31: the view's Remove and its level rules)
- source — _bmad-output/backlog/story-the-enterprise-license-is-documented-and-its-state-shown-plan.md (ticket 38's manual check, where the user found the gap)

## Notes

- Decision (user, 2026-10-29): the value-only choice stays the default (a name shared through a committed settings file, each teammate their own value); value and name is the second choice.
- Decision (user, 2026-10-29): a removed name that leaves the list empty at its level removes the setting there (an empty `[]` would hide a less specific level's list).
