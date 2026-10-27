---
id: 27
type: bug
title: "Some integration tests fail now and then in CI and pass on rerun"
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

# Some integration tests fail now and then in CI and pass on rerun

## Description

A few integration tests fail at random, mostly in CI's 2-CPU runner, and pass when the same commit runs again. Each such failure turns a CI run red without a real regression and makes the next real one easier to dismiss. No user-facing behavior is known to be affected.

## Reproduction

- Suite 50 (lint): the Quick Fix tests (`QUICK_FIX`, `OPTION_FIX`, `FIX_ALL`, ticket 7's) sometimes get no action from the extension: the code actions list only "Fix" / "Explain". Locally about 1 run in 6 on the baseline and 2 in 6 with ticket 7; when it happens every Quick Fix test of that run fails.
- Suite 85 (graph keyboard, 3.11): `ESC (ticket 11): focusEditorRequested focuses the driving editor…` failed with "focus stays where it was" in CI run 40398418336 (stable).
- The same CI job's 1.100.0 floor run (non-blocking) failed `RETAKE_STEAL (bug 19)`.
- Not reproduced in 10 local runs pinned to two CPUs (bug 21): suite 81 `DRIVING` / `DRIVING_CLOSED` and suite 90's 4.10 undo tests.

## Cause Hypothesis

The Quick Fix tests likely request code actions before the lint diagnostics reach the provider: building a longer failure message before the assertion (a short delay) made 8 of 8 runs pass. The focus tests depend on keyboard focus under a virtual display on a busy runner, the family of bugs 19 and 21.

## Acceptance Criteria

1. **The Quick Fix tests are deterministic**
   **Given** suite 50
   **When** it runs 10 times pinned to two CPUs
   **Then** the Quick Fix tests pass every time, waiting for what they need instead of racing it
2. **Focus failures say why**
   **Given** a focus-dependent test that fails
   **When** its failure is reported
   **Then** the report shows the focus state at that moment (active editor and group, focused panel), so the next occurrence points at a cause
3. **CI stays green on one commit**
   **Given** one commit with these fixes
   **When** CI's stable step runs 5 times
   **Then** it passes every time, or each failure is recorded with its focus report and a follow-up
4. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the tests already pass consistently, with the evidence recorded in Notes — this supersedes 1 to 3

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the entries on the Quick Fix flake (ticket 7) and the ESC focus flake (CI)
- source — _bmad-output/backlog/bug-graph-webview-ready-timing-flakes-in-ci-plan.md, Implementation Notes (the reproduction loop)

## Notes

- Decision: the Quick Fix flake and the CI focus flakes are one ticket (user, 2026-10-27).
- Open question: running CI 5 times on one commit uses GitHub runner time; confirm before doing it.
