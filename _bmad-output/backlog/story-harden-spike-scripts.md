---
id: 6
type: story
title: "Spike scripts handle unusual repo paths and re-check extracted binaries"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Spike scripts handle unusual repo paths and re-check extracted binaries

## Description

`scripts/spike/run-matrix.sh` puts the repo path unescaped into a sed pattern, and `scripts/spike/fetch-binaries.sh` re-verifies the archive but trusts an already extracted binary (rejected low findings in review of 1.1). CI now depends on `fetch-binaries.sh`. When this is done, both scripts are safe for any checkout path and a replaced extracted binary is detected.

## Acceptance Criteria

1. **Any checkout path**
   **Given** a checkout whose path contains regex characters such as `.`, `[`, `(` or `#`
   **When** `run-matrix.sh` runs
   **Then** captures show `<ROOT>` in place of the path and the run succeeds
2. **Tampered binary**
   **Given** an extracted binary that differs from the verified archive's content
   **When** `fetch-binaries.sh` runs
   **Then** it re-extracts the binary from the verified archive instead of reusing it
3. **Unchanged happy path**
   **Given** a normal checkout with a valid cache
   **When** both scripts run twice
   **Then** the second run downloads nothing and the captures, corpus records and schema fixtures are byte-identical, as today (a guard)

## Boundaries

- Must not change: the pinned versions. The CI cache key is a hash of `fetch-binaries.sh`, so it changes once with this edit.

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/story-refactor-sweep-plan.md, Implementation Notes (backlog list)
- spike — _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-verify-redpanda-connect-cli-facts-and-seed-the-corpus-plan.md, Review Triage Log

## Notes

- Open question: how to detect a replaced binary cheaply (compare against the archive member, or keep a sha256 of the extracted binary).
