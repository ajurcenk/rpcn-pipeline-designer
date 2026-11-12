---
id: 54
type: bug
title: "Pipeline logs: slow search patterns are refused everywhere (epic 6 retrospective)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
severity: P3
estimate: ""
---

# Pipeline logs: slow search patterns are refused everywhere (epic 6 retrospective)

## Description

The Pipeline Logs search refuses regular expressions that could take too long, but only quantified groups that hold a quantifier or an alternation. Ungrouped adjacent quantifiers such as `.*.*.*x` pass, and on a long value they backtrack polynomially on the extension host. The webview's highlight runs the search on the whole row text with no length cap. When this bug is fixed, every slow pattern is refused before it runs, on the host and in the webview, and the highlight never runs on uncapped text.

## Reproduction

Paths are at 4f88554.

1. **C12, the host.** `slowPattern` (`src/shared/logsProtocol.ts:122`) refuses nested quantified groups only. Turn on regular expressions and search `.*.*.*.*x` with records whose values are near the 10,000-character match limit (`MAX_MATCH_CHARS`, `logsProtocol.ts:116`): the pattern is accepted and each match backtracks.
2. **C12, the webview.** `highlightParts` (`webview/src/logs/LogsView.tsx:119`) runs the search's global pattern on the full row text, with no cap such as the host's `MAX_MATCH_CHARS`, so a slow pattern can freeze the webview on a long message.

## Cause Hypothesis

6.4's refusal targeted the classic nested-quantifier shape; adjacent unbounded quantifiers on overlapping atoms are slow too. The highlight was added in the webview without the host's character cap.

## Acceptance Criteria

1. **Slow patterns are refused before they run**
   **Given** a regular expression that could take too long, nested or not (for example two or more unbounded quantifiers on overlapping atoms, such as `.*.*.*x`)
   **When** it is typed
   **Then** it is refused with the same message as other slow patterns, and nothing is matched with it
2. **The highlight is bounded**
   **Given** any accepted pattern and a long row
   **When** the webview highlights matches
   **Then** it runs only on text cut to the host's match limit, and refuses the same patterns the host refuses
3. **Ordinary patterns still work**
   **Given** the patterns the 6.4 tests accept (anchors, classes, single quantifiers, bounded repeats)
   **When** they are typed
   **Then** they are accepted and match as today
4. **Tests cover the conditions found and fixed**
   **Given** the logs unit tests and the webview tests
   **When** they run
   **Then** a test that fails on the defect and passes on the fix covers each of criteria 1 and 2
5. **Or: no change is needed, with proof**
   **Given** a case's reproduction
   **When** it is run on the current code
   **Then** the expected behavior already holds, or the finding was mistaken, with the evidence recorded in Notes — this supersedes that case's part of criteria 1 to 4

## Boundaries

- Must not change: plain-text search, Match case, the field filter and level chips; bug 51 group A's reading.
- Not in scope: one time per record and the strip (bug 53).

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs-retrospective.md, finding C12
- source — _bmad-output/backlog/bug-pipeline-logs-reading-and-state-edge-cases-epic-6-retrospective.md, criterion 6 (bug 51 group C)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-filter-and-search-the-log-plan.md (6.4, the search and its slow-pattern refusal)

## Notes

- Decision: split from bug 51 as its group C (user, 2026-11-11, "Start A"); ticketed on 2026-11-11 ("make the tickets").
- Open question: a static check of the pattern, or a time budget on matching (for example a worker with a timeout)? The plan decides; a static check needs no new dependency.
- Decision: no floor (VS Code 1.100.0) runs (user).
