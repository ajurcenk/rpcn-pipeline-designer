---
id: 63
type: story
title: "The metrics and access code is split and its duplicates merged, behaviour unchanged (epic 7 retrospective)"
parent: none
covers: []
after: [62]
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# The metrics and access code is split and its duplicates merged, behaviour unchanged (epic 7 retrospective)

## Description

Epic 7 left the metrics panel and the metrics feed as two large classes. The panel does the webview, the resolver, the pick, the state actions and the status-bar rate. The feed holds both read loops. Epic 7 also left several copies of code that the logs and metrics accesses share. When this is done, the panel's resolver and pick and the feed's Cloud loop are their own units, the duplicates are one copy each, and nothing a user sees or a test checks has changed. It follows story 62, so the risks are settled before the code moves.

## Acceptance Criteria

1. **The large units are split**
   **Given** the metrics panel and the metrics feed
   **When** this story is done
   **Then** the panel's source resolver and pick are a unit of their own, and so is the feed's Cloud read loop. Each split-off unit is used by the code that held it before, and nothing else.
2. **Each duplicate is one copy**
   **Given** the duplicates listed in Notes
   **When** this story is done
   **Then** each exists once and is used by both callers. The logs and metrics accesses keep their own texts and masking.
3. **Behaviour is unchanged**
   **Given** the test suites as they stand after story 62
   **When** they run after the change
   **Then** all pass, and no test's expected values are changed. A test may change only where it imports the code that moved.
4. **The layering holds**
   **Given** the layering check (no `vscode` import in the core, shared or metrics-adapter code)
   **When** it runs
   **Then** it finds nothing

## Boundaries

- Must not change: any message, state, button, setting, command or stored record of Pipeline Metrics, Pipeline Logs or the Cloud view; the reading pace (AD-25); the two `StatePanel`s, the mapping lookup and the feed's local loop, which stay as they are.

## References

- parent — none
- source — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics-retrospective.md`, Findings A2 and A3; action item AI-8
- related — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/story-refactor-sweep-plan.md` (7.10, the shared Set up guard and Forget flow this builds on)
- related — `_bmad-output/backlog/story-the-metrics-risks-left-unverified-by-epic-7-are-settled-with-tests.md` (story 62, its prerequisite)

## Notes

- The duplicates (retrospective A3):
  - the Set up test-and-store flow of log and metrics access
  - `maskError`
  - the two access parsers
  - the two "active config → mapped pipeline → pick" resolvers (logs and metrics)
  - the ninth copy of `isObject`
  - `clockText`'s padding
  - the two styles of quick-pick test seam
- Decision (retrospective A3): the feed's two loops, the two `StatePanel`s and the mapping lookup (bug 57) stay as they are.
- Decision: AI-8 split into two stories, story 62 first and this one after it (the user, 2026-11-23).
- Assumption: risk medium. It moves shared code that every metrics and access test exercises, and a slip can pass review. The check outside the ticket's own criteria is the full stable suite run twice.
- Open question: should AI-5's ticket-tag comment convention (the full ref, `7.9` not `ticket 9`) be applied to the metrics files in this sweep? The retrospective says "in the next sweep", and the convention isn't in AGENTS.md yet.
- Decision: no floor (VS Code 1.100.0) runs (the user).
