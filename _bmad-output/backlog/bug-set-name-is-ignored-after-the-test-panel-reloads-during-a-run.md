---
id: 36
type: bug
title: "Set NAME… is ignored after the test panel reloads during a run"
parent: none
covers: []
after: [32, 35]
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
estimate: ""
---

# Set NAME… is ignored after the test panel reloads during a run

## Description

The Bloblang test panel offers "Set NAME…" for a variable a test run found unset (ticket 32). When the panel is hidden and shown again while a run is still going, its webview is recreated, and the run's result can reach the new webview before the extension handles that webview's `ready`. The new webview then shows the "could not run" card with Set NAME…, but the extension has already forgotten the offered names, so a click does nothing; only the log says "setVariableRequested ignored". Pressing Run brings a working button back.

## Reproduction

1. A config whose mapping uses `${REGION}`, with REGION unset, and a run slow enough to switch tabs during it (for example, a slow binary or a loaded machine).
2. Open its test panel, start a run, and before it ends switch to another tab in the panel's group and back.
3. Actual: the result shows "The test could not run" with **Set REGION…**; clicking it does nothing.
4. Expected: the button either works or is not shown.

## Cause Hypothesis

With `retainContextWhenHidden: false`, showing the panel again creates a new webview. The extension posts a run's result to whatever webview is current and keeps its names as the offered ones; the new webview's `ready`, handled after that, clears them (a reloaded webview shows no result, ticket 32). The result is not tied to the webview that asked for it, so the new webview can show a result whose names the extension no longer offers.

## Acceptance Criteria

1. **The button and the extension agree**
   **Given** a run whose result lists unset variables
   **When** the panel's webview is recreated before or while that result arrives
   **Then** the webview either shows no Set NAME… for it, or a click on it runs the set action, never a button that does nothing
2. **The rule stays**
   **Given** a request for a name the result shown in the webview does not list
   **When** the panel gets it
   **Then** it is ignored and logged, as ticket 32 decided
3. **Nothing else changes**
   **Given** every other panel flow (runs, Retry, samples, reload without a run in flight)
   **When** it runs
   **Then** it behaves as today
4. **Tests cover the condition found and fixed**
   **Given** the test runs
   **When** they run
   **Then** a test that fails on the defect and passes on the fix covers the reproduction (the late `ready` simulated, as bug 35's tests can)
5. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the button already works or is not shown, with the evidence recorded in Notes — this supersedes 1 to 4

## References

- parent — none
- related — _bmad-output/backlog/story-the-test-panel-offers-to-set-an-unset-variable-plan.md (ticket 32: the offered names and the ignore rule)
- source — _bmad-output/backlog/bug-the-test-panels-set-name-tests-sometimes-get-their-request-ignored-plan.md (bug 35, Review Triage Log row 2)
- source — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the entry from bug 35 on a recreated webview

## Notes

- Open question: whether a message posted to a webview before it has loaded reaches it at all; if it never does, the reproduction may not occur (criterion 5).
