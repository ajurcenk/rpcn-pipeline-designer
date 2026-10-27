---
id: 30
type: story
title: "Secret environment variables kept in the secret storage reach every command"
parent: none
covers: []
after: [29]
assignee: ""
refined: false
hitl: true
risk: high
estimate: ""
---

# Secret environment variables kept in the secret storage reach every command

## Description

With ticket 29, variables live in plain text in `redpandaConnect.env`, which is wrong for tokens and passwords. When this is done, a config's folder can declare secret names in a new setting, `redpandaConnect.secretEnv`, and commands set, change and remove their values, which are kept in VS Code's secret storage on this machine, never in a settings file. Lint, Run, the live Bloblang check and the test panel get them, and no value is ever shown or logged unasked. The person doing the manual checks (Notes) confirms secrets on each operating system's keychain. The sidebar view that lists them is ticket 31.

## Acceptance Criteria

1. **A secret is stored only in the secret storage**
   **Given** the user runs "Set secret variable" and enters a name and a value
   **When** it is saved
   **Then** the value is in VS Code's secret storage, keyed by the config folder and the name
   **And** the name is added to `redpandaConnect.secretEnv` at the scope the user chose, and no settings file holds the value
2. **A secret's value is entered and kept hidden**
   **Given** "Set secret variable" asks for the value
   **When** the user types it
   **Then** the input masks it
   **And** the value appears in no output channel line, error message or test panel result, from this or any command
3. **A secret reaches the commands without touching the disk**
   **Given** a declared secret with a value for the config's folder
   **When** lint, Run, the live Bloblang check or the test panel runs
   **Then** the command's process environment holds it
   **And** no file the extension writes holds it
4. **A declared secret without a value is told**
   **Given** a name in `redpandaConnect.secretEnv` with no value on this machine
   **When** a command runs for a config in that folder
   **Then** the command runs without it, and the output channel says once, by name, that it has no value here and how to set it
5. **A clash is told, not hidden**
   **Given** a secret whose name the env file or `redpandaConnect.env` also sets
   **When** a command runs
   **Then** that other value wins, as the binary and ticket 29 apply it
   **And** the output channel says so once, by name only
6. **Changing and removing a secret**
   **Given** a stored secret
   **When** the user sets it again or removes it
   **Then** the next command gets the new value or none, without a restart, and the live check does not keep a result the old value decided
7. **Secrets can be cleared**
   **Given** stored secrets on this machine
   **When** the user runs "Clear stored secrets" and confirms
   **Then** every secret this extension stored is removed from the secret storage
8. **Without secrets, nothing changes**
   **Given** `redpandaConnect.secretEnv` is unset or empty
   **When** any command runs
   **Then** its arguments and environment are those ticket 29 gives

## Boundaries

- Must not change: ticket 29's setting and its precedence, the `envFile` setting, the commands' arguments.
- Not part of this story: the sidebar Environment view and the test panel's set action (ticket 31), syncing secrets between machines.

## References

- parent — none
- related — _bmad-output/backlog/story-environment-variables-set-in-the-settings.md (ticket 29)
- related — _bmad-output/backlog/story-an-environment-view-shows-each-configs-variables.md (ticket 31, the view)
- design — https://claude.ai/artifact/DaPANUeVy98mvkMr1YxtP5, artboard "B · Adding a secret variable (toggle Secret)" (the quick input with the Secret switch and the password field)

## Notes

- Decision (user, 2026-10-27): split from the Environment view (now ticket 31); this story is secrets through commands.
- Decision (user, 2026-10-27): secret names live in a names-only setting, `redpandaConnect.secretEnv`, per folder like `env`; ticket 29's `env` stays strings only. VS Code does not merge list settings: the most specific level's list is used.
- Decision (user, 2026-10-27): secrets reach the binary through the child's process environment only, never a file, so the env file's or `env`'s value wins for the same name (AC5). Probed 2026-10-27: `--env-file` overrides the process environment on 4.100.0 and 4.112.0.
- VS Code's secret storage cannot list its keys on 1.100 (the engines floor): the extension keeps its own list of the keys it stored, on this machine only, for "Clear stored secrets".
- Assumption: secrets are per machine (the secret storage does not sync); another machine is told by AC4 and sets them itself.
- High risk check: a person runs the secret flows by hand on Linux (libsecret / GNOME Keyring), macOS (Keychain) and Windows (Credential Manager), or the ones available, and in a Remote / WSL window, and reads the output channel and Run's terminal for leaked values. Windows waits on story 1.
