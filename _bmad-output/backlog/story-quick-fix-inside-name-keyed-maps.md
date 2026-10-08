---
id: 7
type: story
title: "Unknown-field Quick Fix inside name-keyed maps"
parent: none
covers: ["CAP-3"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Unknown-field Quick Fix inside name-keyed maps

## Description

The "Change to `<name>`" Quick Fix for `field X not recognised` (2.5) walks the schema by key, but does not step through maps whose keys are free names (`additionalProperties`), such as `workflow.branches.<name>` or `dynamic.inputs.<name>`. A typo inside such an entry is flagged by lint on save but gets no fix. When this is done, the walk steps through a name-keyed map to its value schema, so these fields get the same fixes as anywhere else.

## Acceptance Criteria

1. **Fix inside a named branch**
   **Given** `pipeline.processors: - workflow: branches: a: request_mapp: …` flagged `field request_mapp not recognised`
   **When** Quick Fixes are requested
   **Then** "Change to `request_map`" is offered, preferred, and applying it changes only the key
2. **Map key itself not fixed**
   **Given** an unknown name used as a map key (`branches.<anything>`)
   **When** lint reports nothing for it
   **Then** no fix is offered for the key
3. **Elsewhere unchanged**
   **Given** the existing 2.5 and 2.14 cases
   **When** the suite runs
   **Then** their tests pass unchanged

## Boundaries

- Must not change: ranking, edit limit and preferred rule (2.5 decisions); the fix replaces only the key token (AD-19).

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-quick-fix-for-unknown-fields-plan.md, Review Triage Log A4 (recorded limit, test pins it)
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-refactor-sweep-plan.md, item 9

## Notes

- The pinning test from 2.5 (no fix inside a name-keyed map) must be inverted, not deleted.
