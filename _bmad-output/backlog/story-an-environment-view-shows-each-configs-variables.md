---
id: 31
type: story
title: "An Environment view shows each config's variables, their sources and the missing ones"
parent: none
covers: []
after: [30]
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# An Environment view shows each config's variables, their sources and the missing ones

## Description

After tickets 29 and 30, variables come from four places (the `env` setting, secrets, the env file and VS Code's environment) and nothing shows which value a config gets. When this is done, a Redpanda Connect container in the Activity Bar has an Environment view for the active config: its variables grouped by source, the value that wins marked, overridden ones crossed out, secrets masked, and every `${VAR}` the config uses but nothing sets flagged with an action that sets it. The test panel's button for an unset variable is ticket 32.

## Acceptance Criteria

1. **Sources and the value that wins**
   **Given** a config whose folder has variables in the setting, secrets, the env file and VS Code's environment
   **When** the config is the active editor
   **Then** the view lists them grouped by source, for that config's folder
   **And** a variable another source overrides is marked overridden, and the one the commands get is marked used
2. **Secrets stay masked**
   **Given** a secret variable
   **When** it is listed
   **Then** its value is masked, and shown in clear only after the user asks, for that variable alone
3. **Used but unset variables are flagged**
   **Given** the config uses `${REGION}` and no source sets it
   **When** the view shows the config
   **Then** `REGION` is listed as missing with an action that sets it (as a plain or a secret variable)
4. **Actions from the view**
   **Given** the view
   **When** the user adds, edits or removes a variable, or opens the env file
   **Then** it uses ticket 29's setting and ticket 30's secret commands, and the view updates
5. **Nothing changes for the commands**
   **Given** the view open or closed
   **When** any command runs
   **Then** its arguments and environment are those tickets 29 and 30 give

## Boundaries

- Must not change: how variables reach the commands (tickets 29 and 30); the env file is read for display only.
- Not part of this story: the test panel's set button (ticket 32).

## References

- parent — none
- related — _bmad-output/backlog/story-environment-variables-set-in-the-settings.md (ticket 29), _bmad-output/backlog/story-secret-environment-variables-kept-in-the-secret-storage.md (ticket 30)
- design — https://claude.ai/artifact/DaPANUeVy98mvkMr1YxtP5, artboards "B · Environment view in the Redpanda Connect sidebar", "B · Adding a secret variable (toggle Secret)" and "C · A missing variable, fixed from the test panel"

## Notes

- Decision (user, 2026-10-27): split from ticket 30; option B (sidebar view) over the full editor panel (C).
- Decision (user, 2026-10-28): the test panel's set button is split off as ticket 32.
- Decision (user, 2026-10-28): "used" is `${VAR}` in the YAML (`${VAR:default}` never missing) plus `env("VAR")` with a literal name; the env file's names are shown with values masked, read with the binary's strict `NAME=value` form, and a rejected line is flagged.
