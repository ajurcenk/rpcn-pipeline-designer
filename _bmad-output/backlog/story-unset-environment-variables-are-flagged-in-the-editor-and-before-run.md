---
id: 46
type: story
title: "Unset environment variables are flagged in the editor and before Run"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
estimate: ""
---

# Unset environment variables are flagged in the editor and before Run

## Description

A config that uses `${NAME}` with no default, when no local source sets `NAME`, shows no problem in the editor, and Run then fails with `required environment variables were not set: [NAME]` and exit code 1. Live lint skips the binary's variable check on purpose (AD-9). When this is done, each such reference has a Warning in the editor with a fix that sets the variable, and Run refuses before it starts the binary, naming the variables and offering to set them. Deploy is unchanged: it checks the cluster's secrets (ticket 5.7).

## Acceptance Criteria

1. **A Warning at each unset reference**
   **Given** a config that uses `${NAME}` with no default, and none of the local sources sets `NAME` for the config's folder (the `env` setting, the env file, a secret variable, VS Code's environment)
   **When** the config is open
   **Then** each reference to `NAME` has a Warning that names `NAME`, says a local Run stops on it, and says Deploy reads it from the cluster's secrets
   **And** the Warning is shown in the Problems view with the other diagnostics of the file
2. **No Warning when the binary would not stop**
   **Given** a reference with a default (`${NAME:value}`), or a `NAME` that one of the local sources sets
   **When** the config is open
   **Then** that reference has no Warning, and the names flagged are the names the binary's run lists as not set for the same config and sources
3. **The Warnings follow the sources**
   **Given** an open config with a Warning for `NAME`
   **When** `NAME` is set or removed in any local source, or the file is edited
   **Then** the Warning appears or goes away without the user saving or reopening the file
4. **A fix sets the variable**
   **Given** a Warning for `NAME`
   **When** the user picks its quick fix
   **Then** they can set `NAME` as a secret variable or as a plain variable for the config's folder, through the existing commands, and the Warning goes away
5. **Run refuses before starting**
   **Given** a config with one or more unset variables
   **When** the user runs it
   **Then** no Redpanda Connect process starts, and a message names every unset variable and offers to set them
   **And** once they are all set, Run starts as it does today
6. **Values stay out of the messages**
   **Given** any Warning, fix or Run message from this ticket
   **When** it is shown
   **Then** it carries variable names only, never a value from any source

## Boundaries

- Must not change: lint's own findings and flags, the live Bloblang errors, the Environment view, the hover, the test panel's offer to set a variable, Deploy and its secrets questions, and Run for a config with every variable set.

## References

- source — the user's manual check on the dev host, 2026-11-09: a local Run of a config using `${MASK44_KEY}` failed on the unset variable while the editor showed nothing
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-9 (lint passes `--skip-env-var-check`) and AD-12 (diagnostics ownership and dedupe)
- prior — _bmad-output/backlog/story-environment-variables-set-in-the-settings.md (29, the `env` setting)
- prior — _bmad-output/backlog/story-secret-environment-variables-kept-in-the-secret-storage.md (30, secret variables)
- prior — _bmad-output/backlog/story-an-environment-view-shows-each-configs-variables.md (31, the missing variables and the action that sets them)
- prior — _bmad-output/backlog/story-the-test-panel-offers-to-set-an-unset-variable.md (32, the binary's not-set message read)
- prior — _bmad-output/backlog/story-hovering-a-variable-in-the-yaml-shows-its-value-and-source.md (34, a reference's value and source)

## Notes

- Decision: make the ticket now, separate from bug 44 (user, 2026-11-09).
- Decision: lint keeps `--skip-env-var-check`. The binary reports this error at line 1, column 1, not at the reference, and a variable unset locally can be a Cloud secret.
- Decision: Warning severity, not Error, because Deploy can still succeed with the cluster's secret (user, 2026-11-10).
- Decision: Run refuses, with no "Run anyway", since the binary would stop at once (user, 2026-11-10).
- Open question: whether references in the files of `redpandaConnect.resourceFiles` are flagged too, since Run reads them.
- Open question: how `${secrets.NAME}` and an escaped `$${NAME}` are treated locally. Check against the binary first.
- Open question: whether a variable set to an empty value counts as unset. Match the binary.
