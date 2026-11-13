---
id: 56
type: story
title: "Code health for the Pipeline Logs panel (story 50 group C)"
parent: none
covers: []
after: [53]
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# Code health for the Pipeline Logs panel (story 50 group C)

## Description

The epic 6 retrospective found the Pipeline Logs panel holding its read in flags that are reset by hand on a change, the record-count plural, zero padding and local-time formatting written several times across the logs adapter, protocol and webview, and the messages ticket 6.6 added named as commands where the panel's other messages are past-tense intents. This story is a refactor. When it is done, the read is held as one value per range with an explicit state, each helper is written once, and every webview message follows the past-tense intent convention. What the user sees does not change.

## Acceptance Criteria

1. **The log panel's read state is one value per range**
   **Given** the Pipeline Logs panel's tail, bounded range, around-the-error search and Load older
   **When** the code is read after this story
   **Then** the read is held as one value per range, with an explicit state (tail, range, search or older), and no flag is reset by hand on a change
2. **One plural, `pad` and local-time helper**
   **Given** the "N record(s)" text, the zero padding and the local-time formatting in the logs adapter, protocol and webview
   **When** the code is read after this story
   **Then** each is written once and shared, and the text they produce is unchanged
3. **The log panel's webview messages are past-tense intents**
   **Given** the webview-to-host messages ticket 6.6 added as commands (`stopReading`, `retryNow` and the others)
   **When** the code is read after this story
   **Then** they are named as past-tense intents, as the other log panel messages are, on both sides of the protocol
4. **Behavior is unchanged**
   **Given** the code after this story
   **When** compile with lint, the corpus, webview, stable and multi-root suites run
   **Then** they all pass, and no existing integration or corpus test was changed to make them pass, other than the message names criterion 3 renames

## Boundaries

- Must not change: any command, message text, log line, setting or record read; bug 51 group A's reading (per-partition positions, the left-out totals, the gap marker); bug 52's masking; the webview protocol, except the message names criterion 3 renames.
- Not in scope: the graph model and the panel adapters (ticket 55); slow search patterns (bug 54).

## References

- parent — none
- source — _bmad-output/backlog/story-code-health-for-the-cloud-adapter-and-the-panels.md (story 50), criteria 7 to 9
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs-retrospective.md, findings A3, A5 and A7 (Aggregate views), action item AI-4
- related — _bmad-output/backlog/bug-pipeline-logs-one-time-per-record-and-a-strip-that-matches-its-rows-epic-6-retrospective.md (bug 53, built first)
- prior — _bmad-output/backlog/bug-pipeline-logs-reading-and-state-edge-cases-epic-6-retrospective-plan.md (bug 51 group A, done)
- deferred work — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, entry "Story 50 group C, the Pipeline Logs panel"

## Notes

- Decision: split from story 50 as its group C (user, 2026-11-12, "Split, build A first"); ticketed on 2026-11-13 ("make the tickets").
- Decision: after bug 53 (the recommended order, 2026-11-13), so the read state is reshaped once, over the times and the strip bug 53 settles. This answers story 50's open question on the order with the logs bugs.
- Code at c783a4a: the read state in `src/adapters/vscode/logsPanel.ts`; the plural, `pad` and local-time copies in `src/adapters/logs/export.ts:22,34`, `webview/src/logs/LogsView.tsx:65,68,74`, `src/shared/logsProtocol.ts:252,370,388,676,681` and `src/adapters/logs/history.ts:77`; 6.6's commands in `src/shared/logsProtocol.ts:492-514` (lines may have moved since bug 51 group A).
- Decision: no floor (VS Code 1.100.0) runs (user).
