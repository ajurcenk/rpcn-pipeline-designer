---
id: 55
type: story
title: "Code health for the graph model and the panel adapters (story 50 group B)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# Code health for the graph model and the panel adapters (story 50 group B)

## Description

The epic 3 and epic 4 retrospectives found the graph model walking ancestors and building id-to-node maps more than once, errors read inline with `instanceof Error` instead of `errorText`, and two panel adapters that no unit test runs. This story is a refactor. When it is done, the graph model has one ancestor walk and one id map, every error is read through `errorText`, and the graph and Bloblang test panel adapters each reach VS Code through a named Source interface that unit tests drive with a fake. What the user sees does not change.

## Acceptance Criteria

1. **One ancestor walk and `errorText` everywhere**
   **Given** the graph model's ancestor walks and id-to-node maps, and the inline `instanceof Error` reads
   **When** the code is read after this story
   **Then** one shared ancestor walk and id map serve the model, and every error is read through `errorText`
2. **The panel adapters have unit tests**
   **Given** the graph panel adapter and the Bloblang test panel adapter
   **When** the unit tests run
   **Then** each adapter reaches VS Code through a named Source interface, and unit tests drive it through a fake of that interface
3. **Behavior is unchanged**
   **Given** the code after this story
   **When** compile with lint, the corpus, webview, stable and multi-root suites run
   **Then** they all pass, and no existing integration or corpus test was changed to make them pass

## Boundaries

- Must not change: any command, message, log line, setting, focus or placement behavior of the panels, or the webview protocol.
- Not in scope: the Cloud adapter (story 50 group A, done); the Pipeline Logs panel (ticket 56).

## References

- parent — none
- source — _bmad-output/backlog/story-code-health-for-the-cloud-adapter-and-the-panels.md (story 50), criteria 5 and 6
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/epic-pipeline-graph-retrospective.md, findings F12, F15 and F17, action item AI-6
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/epic-bloblang-check-and-test-retrospective.md, finding G-1 and Previous-retro follow-through (AI-6 not landed)
- prior — _bmad-output/backlog/story-code-health-for-the-cloud-adapter-and-the-panels-plan.md (story 50 group A, done)
- deferred work — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, entry "Story 50 group B, the graph and the panels"

## Notes

- Decision: split from story 50 as its group B (user, 2026-11-12, "Split, build A first"); ticketed on 2026-11-13 ("make the tickets").
- Code at 77047dd: the ancestor walks in `src/core/nodeAt.ts`, `nodeStatus.ts` and `layout.ts` (paths may have moved; find them); the panel adapters in `src/adapters/graphPanel/panels.ts` and `src/adapters/bloblangPanel/panels.ts` (the latter has only `sampleStore.test.ts` beside it).
- Open question (from story 50): whether epic 3's AI-6 "shared test filters" (suites re-implementing what `graphHelpers.ts` has) and epic 4's G-1 split of the Bloblang panel registry (tabs, placement, focus) are in scope. Not in the criteria; the plan decides.
- Decision: no floor (VS Code 1.100.0) runs (user).
