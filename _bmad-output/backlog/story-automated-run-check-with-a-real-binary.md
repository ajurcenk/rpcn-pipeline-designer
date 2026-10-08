---
id: 9
type: story
title: "Automated Run and Stop check with a real binary"
parent: none
covers: ["CAP-11", "CAP-14"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Automated Run and Stop check with a real binary

## Description

The VS Code test suite runs Run and Stop (2.7) only against fake binaries; the real binary was checked through `runStreaming` and `buildRunArgs` outside VS Code, and the UI check (terminal output, Stop, exit status, terminal reuse) is manual (2.7 review V8). When this is done, a CI test drives Run and Stop in the extension host with real Redpanda Connect 4.100.0 and 4.112.0 on `test/corpus/fixtures/run_generate.yaml`.

## Acceptance Criteria

1. **Output streams**
   **Given** a real binary resolved by the extension and `run_generate.yaml` open
   **When** Run is executed
   **Then** the generated messages appear in the "Redpanda Connect: run_generate.yaml" terminal while the pipeline runs
2. **Stop and status**
   **Given** the running pipeline
   **When** Stop is executed
   **Then** the process ends within the grace period and the status bar shows "Pipeline stopped"
3. **Reuse**
   **Given** the ended run
   **When** Run is executed again
   **Then** the same terminal is reused
4. **No binary, no failure**
   **Given** a local run without `.cache/redpanda-connect`
   **When** the suite runs
   **Then** these tests are skipped with a message; in CI a missing binary fails them, as in the corpus harness

## Boundaries

- Must not change: the user's installed redpanda-connect, rpk or `~/.local/bin/.rpk.managed-connect`; only the pinned binaries in `.cache/` (`scripts/spike/fetch-binaries.sh`) are used.

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-run-and-stop-in-a-per-file-terminal-plan.md, Review Triage Log V8 and Verification (manual check)
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-refactor-sweep-plan.md, item 9

## Notes

- Terminal content is not readable through the VS Code API; the check can read the Pseudoterminal's writes through the test API (`ExtensionApi.run`).
