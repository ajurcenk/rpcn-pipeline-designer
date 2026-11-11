---
id: 50
type: story
title: "Code health for the Cloud adapter and the panels"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# Code health for the Cloud adapter and the panels

## Description

Three retrospectives found code written more than once, helpers in the wrong layer, and two panel adapters that no unit test runs. This story is a refactor. When it is done, the Cloud adapter has one poll helper, one offset-to-line helper and one mapping-to-target resolution, and its presentation helpers sit outside the HTTP adapter. The graph model has one ancestor walk, errors are read through `errorText` everywhere, and the graph and Bloblang test panels each sit behind a named Source interface with unit tests. What the user sees does not change.

## Acceptance Criteria

1. **One poll helper**
   **Given** Deploy's follow and the Cloud view's Start, Stop and Delete waits
   **When** the code is read after this story
   **Then** they share one poll helper for the deadline, the failure cap and a 404
   **And** the "still … after N s" text is built in one place
2. **One offset-to-line helper**
   **Given** the pre-deploy check, the Bloblang names and the translation, which each turn a text offset into a line
   **When** the code is read after this story
   **Then** they use one helper, and the literal-argument pattern reuses the `env(` call pattern instead of copying it
3. **One mapping-to-target resolution**
   **Given** Deploy and the Cloud view's actions, which each turn a mapping into a cluster, a data plane address or "gone"
   **When** the code is read after this story
   **Then** both use one resolution, and its messages are written once
4. **Presentation helpers out of the HTTP adapter**
   **Given** the state text and the size choices
   **When** the code is read after this story
   **Then** they live outside the Data Plane HTTP adapter, which keeps only requests and their types
5. **One ancestor walk and `errorText` everywhere**
   **Given** the graph model's ancestor walks and id-to-node maps, and the inline `instanceof Error` reads
   **When** the code is read after this story
   **Then** one shared ancestor walk and id map serve the model, and every error is read through `errorText`
6. **The panel adapters have unit tests**
   **Given** the graph panel adapter and the Bloblang test panel adapter
   **When** the unit tests run
   **Then** each adapter reaches VS Code through a named Source interface, and unit tests drive it through a fake of that interface
7. **Behavior is unchanged**
   **Given** the code after this story
   **When** compile with lint, the corpus, webview, stable and multi-root suites run
   **Then** they all pass, and no existing integration or corpus test was changed to make them pass

## Boundaries

- Must not change: any command, message, log line, setting, tag or mapping format, or request sent to the Cloud; secret values staying out of logs and messages (bug 44); the webview protocol.

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md, findings A2, A3, A4 and A6, action item AI-5
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/epic-pipeline-graph-retrospective.md, findings F12, F15 and F17, action item AI-6
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/epic-bloblang-check-and-test-retrospective.md, finding G-1 and Previous-retro follow-through (AI-6 not landed)

## Notes

- Decision: epic 5's AI-5 and epic 3's AI-6 are merged into this one story (user, 2026-11-11, "use your recommendations").
- Code at 4fffc16: the polls are in `src/adapters/vscode/cloudDeploy.ts` (`follow`) and `src/adapters/vscode/cloudActions.ts`; the offset-to-line copies in `src/adapters/vscode/cloudCheck.ts`, `bloblangNames.ts` and `cloudTranslate.ts` (`LITERAL_ARG`; `ENV_CALL` in `envUsage.ts`); the mapping resolution in `cloudDeploy.ts` (`mappedTarget`) and `cloudActions.ts`; `pipelineStateText` and `sizeChoices` in `src/adapters/cloud/dataPlane.ts`; the ancestor walks in `nodeAt.ts`, `nodeStatus.ts` and `layout.ts`; the panel adapters in `src/adapters/graphPanel/panels.ts` and `src/adapters/bloblangPanel/panels.ts` (the latter has only `sampleStore.test.ts` beside it).
- Open question: the size. Seven criteria over two areas (Cloud, panels) may be more than one build; the plan may split the Cloud part from the panel part, with the user's yes.
- Open question: whether epic 3's AI-6 "shared test filters" (suites re-implementing what `graphHelpers.ts` has) and epic 4's G-1 split of the Bloblang panel registry (tabs, placement, focus) are in scope. Not in the criteria; the plan decides.
- Decision: no floor (VS Code 1.100.0) runs (user).
