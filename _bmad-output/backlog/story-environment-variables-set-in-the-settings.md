---
id: 29
type: story
title: "Environment variables set in the settings reach lint, Run, the live Bloblang check and the test panel"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# Environment variables set in the settings reach lint, Run, the live Bloblang check and the test panel

## Description

Today a config's `${VAR}` values come only from the `redpandaConnect.envFile` file or the environment VS Code was started with, so changing one means editing a separate file or restarting VS Code from a shell. When this is done, a new setting, `redpandaConnect.env`, holds variables as `KEY: value` pairs, and every command the extension runs for a config gets them: lint on save, Run, the live Bloblang check and the test panel. It can be set per folder like `envFile`, and a change applies on the next command without a restart.

## Acceptance Criteria

1. **A variable from the setting reaches every command**
   **Given** `redpandaConnect.env` sets `API_TOKEN` and a config uses `${API_TOKEN}`
   **When** the config is linted on save, run, checked live, or test-run in the panel
   **Then** each command's process gets `API_TOKEN` with that value
2. **The setting wins over the env file and VS Code's environment**
   **Given** `API_TOKEN` is set in `redpandaConnect.env`, in the `envFile` file, and in VS Code's environment, each with a different value
   **When** any of the four commands runs
   **Then** the pipeline sees the value from `redpandaConnect.env`
   **And** the variables only the env file or VS Code's environment sets still reach it
3. **Levels merge by key**
   **Given** the user settings set `A` and `B`, and a workspace folder's settings set `B` and `C`
   **When** a command runs for a config in that folder
   **Then** it gets `A` from the user settings and `B` and `C` from the folder's
   **And** a config in another folder gets only the user settings' `A` and `B`
4. **A change applies without a restart**
   **Given** the setting changed while VS Code is running
   **When** a command next runs
   **Then** it gets the new values
   **And** the live Bloblang check does not keep a result that the old values decided
5. **Invalid entries are refused, not guessed**
   **Given** an entry whose key is not a valid variable name or whose value is not a string
   **When** a command runs
   **Then** that entry is left out and one line in the "Redpanda Connect" output channel names it
   **And** the other entries still reach the command
6. **Nothing changes without the setting**
   **Given** `redpandaConnect.env` is unset or empty
   **When** any command runs
   **Then** its arguments and environment are exactly as today

## Boundaries

- Must not change: the `envFile` setting's path rules, the arguments lint, Run, the live check and the test panel pass today, and the `NO_COLOR` variable the extension already sets.

## References

- source — README.md, Settings table (`redpandaConnect.envFile`) and the Run section: variables come from the env file or VS Code's environment
- related — _bmad-output/backlog/story-multi-root-workspace-folder-choice-plan.md (ticket 4, per-folder `envFile`)
- related — _bmad-output/backlog/story-automated-test-run-in-a-multi-root-workspace-plan.md (ticket 28, the multi-root test run that can check AC3)

## Notes

- Decision (user, 2026-10-27): the setting's value wins over the env file's and VS Code's environment for the same variable.
- Decision (user, 2026-10-27): user, workspace and folder values merge by key, the most specific level winning per key.
- Open question: Redpanda Connect's own precedence between `--env-file` and the process environment; if the file wins, AC2 needs the extension to keep the setting's keys from being overridden by the file. The builder checks it on both pinned binaries and records the rule in the README.
- Assumption: values are plain strings, with no `${env:…}` or other expansion.
- Assumption: the README says the setting is stored in plain text in `settings.json`, so secrets belong in the env file, which can stay out of version control.
