---
id: 5
type: story
title: "Resource files with glob characters in their names are passed literally"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Resource files with glob characters in their names are passed literally

## Description

`--resources` treats its value as a glob, so a detected resource file whose name contains `*`, `?` or `[` is expanded as a pattern instead of naming that file (rejected low finding #3 in review of 1.5). When this is done, detected files are always passed as literal paths, while glob entries in the `resourceFiles` setting keep working as patterns.

## Acceptance Criteria

1. **Literal detected file**
   **Given** a detected resource file whose name contains a glob character
   **When** lint or run arguments are built
   **Then** Redpanda Connect loads exactly that file and no other
2. **Setting globs still work**
   **Given** a `resourceFiles` entry such as `res/*.yaml`
   **When** arguments are built
   **Then** every matching file is loaded, as today
3. **No duplicate loading**
   **Given** a setting glob that matches a detected file
   **When** arguments are built
   **Then** that file is loaded once

## Boundaries

- Must not change: long-flag argv shape and lint/run parity (1.5).

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/story-refactor-sweep-plan.md, Implementation Notes (backlog list)
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-9

## Notes

- Open question: whether Redpanda Connect supports escaping glob characters in `--resources`; if not, detected files may need expanding in the builder.
- Assumption: a setting glob that also matches a detected file loads that file twice today; unverified.
- Open question: what Redpanda Connect does when it gets the same resource file twice (fails, warns or dedupes); if it dedupes, criterion 3 already holds and is a guard.
