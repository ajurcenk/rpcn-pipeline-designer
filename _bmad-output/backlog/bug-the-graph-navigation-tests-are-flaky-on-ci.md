---
id: 37
type: bug
title: "The graph navigation tests are flaky on CI"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
estimate: ""
---

# The graph navigation tests are flaky on CI

## Description

Two tests in the pipeline graph's navigation suite failed on CI in a row, each once, on the 2-CPU runner (VS Code 1.144.0); every other test passed in both runs. The stable run blocks CI, so `main` stays red until a rerun happens to pass. When this is done, the suite passes reliably on CI, and the fix says whether the cause is in the tests or in the graph's selection handling.

## Reproduction

1. Run the stable integration run on CI (or locally under load, several times).
2. Actual:
   - CI run 40886309546 (bug 35's push): `CURSOR / CURSOR_SAME / CURSOR_OUTSIDE / FOCUS` failed "one selection": after one cursor move into a node, the graph did not get exactly one new selection within 10 s.
   - CI run 40893960636 (bug 36's push): `DRIVING / DRIVING_CLOSED` failed with "active 1, group 1, visible 1, selections []": after the cursor moved to the output, the graph got no selection within 10 s.
3. Expected: both tests pass every run.

## Cause Hypothesis

Both failures are about the selection the graph gets when the editor's cursor moves (one too many or too few, or none at all), right after the test opened the graph. The tests may start moving the cursor before the graph's webview is ready, or before the selection the graph sends on opening has arrived, so a move is lost or counted against the opening selection. The same family as bugs 19, 21 and 27 (focus- and timing-dependent tests under xvfb on CI). Not reproduced locally.

## Acceptance Criteria

1. **The suite is reliable**
   **Given** the graph navigation suite
   **When** the stable run executes it repeatedly, also under load
   **Then** CURSOR and DRIVING pass every time, and so do the suite's other tests
2. **What the tests check stays**
   **Given** the fix
   **When** the tests run
   **Then** they still check the same behaviors (one selection per change, the node under the cursor, the driving editor, focus staying in the editor); no assertion is loosened to pass
3. **The cause is named**
   **Given** the fix
   **When** it is recorded
   **Then** its Notes say whether a user can meet the race (a cursor move the graph misses, or a duplicate selection), with the evidence; if a user can, the fix covers it and a test fails on the defect and passes on the fix
4. **Or: no change is needed, with proof**
   **Given** repeated runs
   **When** the failure cannot be caused or reproduced on the current code
   **Then** the evidence is recorded in Notes — this supersedes 1 to 3

## References

- parent — none
- related — _bmad-output/backlog/bug-flaky-focus-and-timing-dependent-integration-tests.md (bug 27: the shared focus helpers and earlier flakes)
- source — CI runs 40886309546 and 40893960636, step "VS Code tests (stable)"

## Notes

- Open question: whether these tests wait for the graph's ready snapshot (as bug 35's fix does for the test panel) before moving the cursor.
