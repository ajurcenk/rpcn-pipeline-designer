---
id: 3
type: story
title: "Relative path settings re-resolve when workspace folders change"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Relative path settings re-resolve when workspace folders change

## Description

A relative `redpandaConnect.binaryPath` resolves against the first workspace folder, but only on activation, a setting change or `refresh()`; adding or removing workspace folders does not re-resolve it (judgement call in 1.3). When this is done, a workspace-folder change re-resolves the binary when the effective setting is relative.

## Acceptance Criteria

1. **Folder added**
   **Given** a relative `binaryPath` and no workspace folder open (state `invalid`, reason `relativePathWithoutWorkspace`)
   **When** a workspace folder containing that binary is added
   **Then** `binaryState` becomes `ok` without a reload
2. **First folder changes**
   **Given** a relative `binaryPath` resolved against the first folder
   **When** the first workspace folder changes
   **Then** the binary is re-resolved against the new first folder and `onDidChange` fires only if the state changed
3. **Absolute or bare settings**
   **Given** an absolute, `~` or bare-name `binaryPath`, or none
   **When** workspace folders change
   **Then** no re-resolution is triggered

## Boundaries

- Must not change: single-flight `refresh()`, notification once per transition (1.4).

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/story-refactor-sweep-plan.md, Implementation Notes (backlog list)
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-9

## Notes

- Open question: VS Code restarts the extension host when the first workspace folder changes, which re-activates and re-resolves; criteria 1–2 may already hold (validator finding, 2026-10-06).
- Decision: dropped (user, 2026-10-06) — VS Code restarts the extension host when the first workspace folder changes, so activation already re-resolves the binary; criteria 1–2 hold without this ticket.
