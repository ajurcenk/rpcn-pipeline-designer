---
id: 2
type: story
title: "~user paths in path settings resolve to that user's home"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# ~user paths in path settings resolve to that user's home

## Description

Today only `~`, `~/…` and `~\\…` expand; `~name` and `~user/bin/rc` are treated as workspace-relative paths (rejected in review of 1.3). When this is done, `redpandaConnect.binaryPath`, `resourceFiles` and `envFile` expand a leading `~user` to that user's home directory on POSIX.

## Acceptance Criteria

1. **Other user's home**
   **Given** a path setting starting with `~<user>/` for an existing user on POSIX
   **When** it is resolved
   **Then** it becomes that user's home directory followed by the rest of the path
2. **Unknown user**
   **Given** a `~<user>/…` or bare `~<user>` value for a user that does not exist, and (for `binaryPath`) no usable binary on PATH
   **When** it is resolved
   **Then** the setting is reported as unusable with a reason naming the user, and nothing is spawned
4. **Bare ~user**
   **Given** a value that is exactly `~<user>` for an existing user
   **When** it is resolved
   **Then** it becomes that user's home directory
3. **Existing forms unchanged**
   **Given** `~`, `~/…`, absolute, relative and bare-name values
   **When** they are resolved
   **Then** the results are the same as before

## Boundaries

- Must not change: resolution order (AD-9), the bare-name-on-PATH rule for `binaryPath`.

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/story-refactor-sweep-plan.md, Implementation Notes (backlog list)
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-9

## Notes

- Assumption: Windows keeps `~` only (no `~user`).
- Open question: Node has no API for another user's home; the lookup needs `getent passwd` / `/etc/passwd` on Linux and Directory Services on macOS — confirm macOS is in scope.
- Open question: plain-words copy for the new unusable-path reason (per the 1.4 decision on invalid copy).
- Note: this reverses review rejection #2 of ticket 1.3 pass 2 ("rare, adds a branch") on purpose.
