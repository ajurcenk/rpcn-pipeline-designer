---
id: 16
type: story
title: "Test mapping on a generate input"
parent: none
covers: ["CAP-16"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Test mapping on a generate input

## Description

The Bloblang test panel (epic 4, CAP-16) covers `mapping` and `mutation` processors only; the spec's Non-goals exclude every other Bloblang field. A `generate` input's `mapping` builds each message from nothing (`this` is empty), and developers write a lot of Bloblang there to produce test data. When this is done, a "▷ Test mapping" CodeLens also sits above `generate.mapping`, and its panel has no input pane: one run shows the message the mapping generates (content and metadata), or the binary's error, through the same AD-21 one-message `run` with the generate mapping as the input itself. The user asked for this while checking 4.2 in the dev host (2026-10-13). It builds on the test panel's error states (epic 4, ticket 4.8, done); that dependency was recorded as `after: ["4.8"]`, which `tickets.py` cannot resolve from the backlog folder, so it is kept here as text (2026-10-22).

## Acceptance Criteria

1. **Lens on generate**
   **Given** a detected config with an `input.generate.mapping` (also in a broker's inputs)
   **When** it is shown
   **Then** a "▷ Test mapping" CodeLens sits on the `mapping:` key line
2. **Output only**
   **Given** that panel
   **When** it opens or the user runs it
   **Then** it shows the generated content and metadata, with no input pane, and re-runs when the mapping changes
3. **Errors**
   **Given** a generate mapping that fails or does not parse
   **When** it runs
   **Then** the panel shows the binary's error as for processors (4.8)
4. **Spec**
   **Given** the change
   **When** the spec is read
   **Then** CAP-16 includes `generate` mappings and the Non-goal line no longer excludes them (through `bmad-spec`)

## References

- spec — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, CAP-16 and Non-goals
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-21
- epic — _bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/epic-bloblang-check-and-test.md (the panel and its states)

## Notes

- Waits on 4.8 because the panel's error states land there.
- Open question: whether `count`/`interval` of the generate input are respected (one message only, as in AD-21, is the default).
