---
id: 30
type: story
title: "An Environment view shows each config's variables and keeps secret ones in VS Code's secret storage"
parent: none
covers: []
after: [29]
assignee: ""
refined: false
hitl: true
risk: high
estimate: ""
---

# An Environment view shows each config's variables and keeps secret ones in VS Code's secret storage

## Description

With ticket 29, variables live in plain text in `redpandaConnect.env`, and nothing shows which value a config gets or where it comes from. When this is done, the Redpanda Connect sidebar has an Environment view for the active config. It lists the variables from the setting, the env file and VS Code's environment, shows which value wins, and flags a `${VAR}` the config uses but nothing sets. A variable can be marked secret: its value is kept in VS Code's secret storage, never in a settings file, and shown only masked. The person doing the manual checks (Notes) confirms secrets on each operating system's keychain.

## Acceptance Criteria

1. **The view shows each variable's source and the value that wins**
   **Given** a config whose folder has variables in the setting, the env file and VS Code's environment
   **When** the config is the active editor
   **Then** the Environment view lists them grouped by source, for that config's folder
   **And** a variable that another source overrides is marked as overridden, and the one the commands get is marked as used
2. **A used but unset variable is flagged**
   **Given** the config uses `${REGION}` and no source sets it
   **When** the view shows the config
   **Then** `REGION` is listed as missing with an action that adds it
   **And** the test panel's "could not run" result for it offers the same action
3. **A secret is stored only in the secret storage**
   **Given** a variable added or edited with Secret turned on
   **When** its value is saved
   **Then** the value is in VS Code's secret storage, keyed by its folder and name
   **And** no settings file holds the value, and `redpandaConnect.env` holds at most a marker that the name is secret
4. **A secret's value is never shown or logged unasked**
   **Given** a secret variable
   **When** it is listed, edited, used by a command, or a command fails
   **Then** its value is masked in the view and entered in a password input
   **And** it appears in no output channel line, error message or test panel result
   **And** it is shown in clear only after the user asks, for that variable alone
5. **A secret reaches the commands without touching the disk**
   **Given** a secret variable for the config's folder
   **When** lint, Run, the live Bloblang check or the test panel runs
   **Then** the command's process environment holds it
   **And** no file the extension writes holds it
6. **A clash with the env file is told, not hidden**
   **Given** a secret variable whose name the env file also sets
   **When** a command runs
   **Then** the env file's value wins, as Redpanda Connect applies it
   **And** the view marks the secret as overridden, and the output channel says so once, by name only
7. **Secrets can be cleared**
   **Given** stored secrets for the workspace
   **When** the user runs the clear command and confirms
   **Then** every secret of the workspace's folders is removed from the secret storage, and the view shows them as missing
8. **Without secrets or the view, nothing changes**
   **Given** no secret variables, and the view collapsed or hidden
   **When** any command runs
   **Then** its arguments and environment are those ticket 29 gives

## Boundaries

- Must not change: ticket 29's setting and its precedence for plain variables, the `envFile` setting, the commands' arguments, and the test panel's other results.
- Not part of this story: a full editor panel (prototype option C), syncing secrets between machines, and editing the env file's contents from the view.

## References

- parent — none
- related — _bmad-output/backlog/story-environment-variables-set-in-the-settings.md (ticket 29, the plain `redpandaConnect.env` setting)
- design — https://claude.ai/artifact/DaPANUeVy98mvkMr1YxtP5, artboard "B · Environment view in the Redpanda Connect sidebar" and "C · A missing variable, fixed from the test panel" (its quick input and Set action)

## Notes

- Decision (user, 2026-10-27): option B, the sidebar view, over the full editor panel (C); the built-in Settings UI table (A) comes with ticket 29.
- Assumption: secrets reach the binary through the child's process environment only, never a temporary env file, so a secret loses to the env file's value for the same name (AC6). Probed 2026-10-27: `--env-file` overrides the process environment on 4.100.0 and 4.112.0 (ticket 29's Notes).
- Assumption: secrets are per machine (VS Code's secret storage does not sync); another machine asks for them through the missing-variable action.
- Assumption: the prototype's B board has no Secret toggle yet; the toggle and the password input follow the same view, and the builder settles their exact place.
- High risk check: a person runs the secret flows by hand on Linux (libsecret), macOS (Keychain) and Windows (Credential Manager), or the ones available, and in a Remote / WSL window, and reads the output channel for leaked values. The Windows check waits on story 1 (Windows support) where it needs a Windows build.
- Open question: whether a secret marker in `redpandaConnect.env` is needed at all, or the view lists stored secrets by their own record; settle it at planning.
