---
id: 4
type: story
title: "Multi-root workspaces use a defined folder for relative path settings"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Multi-root workspaces use a defined folder for relative path settings

## Description

Relative `binaryPath`, `resourceFiles` and `envFile` values resolve against the first `file:` workspace folder, which in a multi-root workspace may not be the folder whose settings define the value (rejected low finding in review of 1.3 pass 1 #5; the shared `firstWorkspaceFolderPath` came with 1.5). `resourceFiles` and `envFile` have no `scope` today (default `window`), so they cannot yet be set per folder. When this is done, both are `resource`-scoped and a folder-scoped value resolves against the folder that defines it.

## Acceptance Criteria

1. **Folder-scoped value**
   **Given** a multi-root workspace where folder B's settings set a relative `envFile`
   **When** lint or run arguments are built for a file in folder B
   **Then** the path resolves against folder B
2. **Workspace-scoped value**
   **Given** a relative value in the workspace (`.code-workspace`) settings
   **When** it is resolved
   **Then** it resolves against the first `file:` folder, as today
3. **Single-folder unchanged**
   **Given** a single-folder workspace
   **When** any relative path setting is resolved
   **Then** the result is unchanged

## Boundaries

- Must not change: PATH-first binary order (AD-9).

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/story-refactor-sweep-plan.md, Implementation Notes (backlog list)
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-9

## Notes

- Open question: `binaryPath` is resolved once per window, not per file; decide whether it follows the active file's folder or stays workspace-wide.
