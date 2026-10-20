---
id: 19
type: bug
title: "Focus-dependent integration tests are flaky in CI"
parent: none
covers: ["CAP-8", "CAP-16"]
after: []
assignee: ""
refined: false
hitl: false
risk: medium
severity: P2
estimate: ""
---

# Focus-dependent integration tests are flaky in CI

## Description

On the 2-CPU GitHub runner, integration tests that depend on keyboard focus, the active editor or the editor-group layout fail now and then on the required stable VS Code step, so `main` turns red without a code fault. Seen on 7cc9bb5 (bug 4.19): run 39433758016 failed `PLACE_GRAPH_LEFT (4.17)` in suite 90 (the active group was 2, not 4), and its re-run failed `CURSOR / CURSOR_SAME / CURSOR_OUTSIDE / FOCUS` in suite 81 (3.7). Earlier: `PLACE_WITH_GRAPH` (4.17) and `CLOSE_UNSAVED + WITH_GRAPH` (4.10) before the 4.13 sweep fixed their specific races.

A comparison on 2026-10-20 ran suites 81, 84, 86 and 90 four times each on a9b5df2 and 7cc9bb5, pinned to 2 CPUs like the runner. Both commits flaked, 3 of 4 and 2 of 4 runs: suite 84 `LATE_USER_EDITOR` / `LATE_ACTIVE` (the group lock and late activation), and suite 90's 4.10 undo and close tests (`DELETED + UNDO + TWO_PANELS`, `UNDO_RELINK`, `CLOSE_UNSAVED`, with and without the graph). The failures followed slow runs, not a commit, so they are pre-existing timing races: tests that act on whatever editor is active (`undo`, `revertAndCloseActiveEditor`, `activeTextEditor` checks) or assert focus and layout before VS Code has settled. Logs: the session scratchpad's `base-N.log` / `new-N.log` and `summary.txt` (not kept in the repo).

When this bug is fixed, the stable suite passes at least 8 runs in a row on a 2-CPU-pinned machine and in CI, and these tests target their own document or group instead of whichever is active, or wait for the layout to settle before asserting.

## Notes

- Out of scope: the 1.100 floor (non-blocking in CI, user decision 2026-10-16).
- Candidates: give the undo/close tests an explicit target (focus the document, then check `activeTextEditor` is it before `undo`); a shared "settled layout" wait in `graphHelpers.ts`; the bug-15 confirm-and-retry pattern where the product itself moves focus.
