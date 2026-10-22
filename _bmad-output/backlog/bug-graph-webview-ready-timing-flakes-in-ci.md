---
id: 21
type: bug
title: "Graph webview ready-timing flakes in CI"
parent: none
covers: ["CAP-10"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
severity: P2
estimate: ""
---

# Graph webview ready-timing flakes in CI

## Description

After bug 19 fixed the focus-dependent failures, CI on ada9853 (run 39699546577) passed 7 of 8 attempts. Attempt 6 failed `F6_DISPOSE` in `src/test/integration/suites/86-graph-interactions.ts` ("the panel closed while an edit's update is on its way: nothing posted after the model, no error line"), with "only the model posted before the close". The graph posted an extra `snapshot` before the close, presumably the real webview's own `ready` (it re-sends `ready` when it reloads, since `retainContextWhenHidden` is off) racing the test's post order. The same test failed this way once in a local full run during 4.17 ("the graph's real webview sent two extra `snapshot`s before the expected `model`").

Two other one-offs seen in bug 19's pinned runs had no cause found:
- suite 81 `DRIVING` / `DRIVING_CLOSED`: once in about 60 runs, the expected selection was not posted within 10 s. The test now logs the full focus state when it fails.
- suite 90's 4.10 undo tests (`DELETED + UNDO + TWO_PANELS`, `UNDO_RELINK`, with and without the graph): one attempt (proof2) failed all four twice in a row, then 13 runs passed on the same code.

When this bug is fixed, `F6_DISPOSE` checks its post order without depending on when the real webview sends `ready` (or the host's handling of a late `ready` makes the order deterministic), and the stable CI step passes 8 attempts in a row on one commit.

## Notes

- Evidence: bug 19's plan (`bug-focus-dependent-integration-tests-are-flaky-in-ci-plan.md`, Verification and Implementation Notes), the Epic 4 retrospective's CI table, and run 39699546577 attempt 6.
