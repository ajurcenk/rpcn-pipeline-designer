---
id: 28
type: story
title: "An automated test run checks per-folder settings in a real multi-root workspace"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# An automated test run checks per-folder settings in a real multi-root workspace

## Description

Ticket 4 made `resourceFiles` and `envFile` per-folder, but its tests inject the folder; the real path (reading the settings for a file, its workspace folder, and where the value is defined) is checked only by hand. When this is done, a separate test run opens a two-folder workspace and checks that lint, run, the live Bloblang parse and the test panel use the folder each value comes from.

## Acceptance Criteria

1. **A folder's own value resolves against that folder**
   **Given** a two-folder workspace where folder B's settings set a relative `envFile`
   **When** lint, run, the live parse or the test panel is used on a config in B
   **Then** the env file passed is B's
2. **A workspace value resolves against the first folder**
   **Given** the same workspace with `envFile` only in the workspace settings
   **When** they are used on a config in either folder
   **Then** the env file passed is the first folder's
3. **The existing runs are unchanged**
   **Given** the existing stable and floor test runs
   **When** CI runs
   **Then** they still run with no workspace folder, and the new run is a separate step

## Boundaries

- Must not change: the suites that rely on no workspace folder being open.

## References

- parent — none
- source — _bmad-output/backlog/story-multi-root-workspace-folder-choice-plan.md, Review Triage Log row 2
- source — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the entry from ticket 4

## Notes

- Assumption: the new run is a third `vscode-test` configuration with its own `.code-workspace` fixture, also run in CI.
