---
id: 35
type: bug
title: "The test panel's Set NAME… tests sometimes get their request ignored"
parent: none
covers: []
after: [32]
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
estimate: ""
---

# The test panel's Set NAME… tests sometimes get their request ignored

## Description

Ticket 32's "Set NAME…" tests in the Bloblang test panel suite sometimes fail because the panel acts as if the variable was never offered: no set action runs, no value is set, and no `variableSet` is posted. The stable run blocks CI, so one such failure makes `main` red; a rerun usually passes. When this is done, those tests pass reliably, and the fix says whether the race is in the tests only or can also hit a user.

## Reproduction

1. Run the stable integration run several times (locally, or on CI's 2-CPU runner).
2. Actual, seen three times on 2026-10-28:
   - CI run 40794701387 (story 34's push, VS Code 1.144.0): `SET_RERUN (the run after it)` got no `variableSet` (1053 passing, 1 failing).
   - A local run (VS Code 1.143.1): `OTHER_NAME` ("the secret is set": no value) and `CANCEL` (nothing offered) failed together; the next run passed.
3. Expected: every run passes those tests.

## Cause Hypothesis

The tests post a `run` themselves and then `setVariableRequested`, while the panel's real webview loads in the test host. If the webview's own `ready` (which clears the offered names) or its own `run` (whose result replaces them) reaches the host after the test's run, the request names something the latest result does not list, and it is ignored and logged ("setVariableRequested ignored"). Ticket 32 decided that a request outside the latest result is ignored, so the defect is likely the tests' ordering, not the rule.

## Acceptance Criteria

1. **The tests are reliable**
   **Given** the Set NAME… tests
   **When** the stable run executes them repeatedly, also with the webview's own messages arriving late
   **Then** they pass every time
2. **The rule stays**
   **Given** a request for a name the latest posted result does not list
   **When** the panel gets it
   **Then** it is ignored and logged, as ticket 32 decided
3. **The race is named**
   **Given** the fix
   **When** it is recorded
   **Then** its Notes say whether a user can meet the race (a request ignored after the webview's own ready or run), with the evidence; if a user can, the fix covers that case and a test fails on the defect and passes on the fix
4. **Or: no change is needed, with proof**
   **Given** repeated runs
   **When** the failure cannot be caused or reproduced on the current code
   **Then** the evidence is recorded in Notes — this supersedes 1 to 3

## References

- parent — none
- related — _bmad-output/backlog/story-the-test-panel-offers-to-set-an-unset-variable-plan.md (ticket 32: the offered names and the ignore rule)
- source — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the entry from bug 33 on OTHER_NAME and CANCEL

## Notes

- Evidence: the local failing log is `.vscode-test/bug33-stable-run1.log` (git-ignored, on the machine that ran it); the CI log is run 40794701387's "VS Code tests (stable)" step.
- Open question: whether the "setVariableRequested ignored" output line was written in the failing runs (it would confirm the hypothesis).
