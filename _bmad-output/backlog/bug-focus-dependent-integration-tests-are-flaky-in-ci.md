---
id: 19
type: bug
title: "Focus-dependent integration tests are flaky in CI"
parent: none
covers: ["CAP-8", "CAP-16"]
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P1
estimate: ""
---

# Focus-dependent integration tests are flaky in CI

## Description

On the 2-CPU GitHub runner, integration tests that read keyboard focus, the active editor or the editor-group layout fail now and then on the required **stable** VS Code step. `main` then turns red with no code fault. The Epic 4 retrospective (`_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/epic-bloblang-check-and-test-retrospective.md`, section "CI flakiness", findings CI-1–CI-4) has the full record. 27 of 58 CI runs on `main` failed during the epic. Commits that change only `_bmad-output/` flipped the result on an identical source tree (6ed1358 green / 7120f18 red, 5fa2870 green / be0d026 red, a9ece43 red / b1faf3b green).

The failures that block the build, all on stable:

- **PLACE_WITH_GRAPH / PLACE_GRAPH_LEFT (4.17, suite 90)**, by far the most frequent. They failed in 6 of 14 runs before the 4.13 sweep and in **4 of 9 runs after it** (39354646781, 39433758016 attempt 1, 39444568138, 39482409309). So **the 4.13 sweep did not fix them**.
  - Since the sweep, every failure is on the synchronous `tabGroups.activeTabGroup.viewColumn` assertion right after the focus check (`src/test/integration/suites/90-bloblang-panel.ts:2042`, `:2071`: `2 !== 1`, `2 !== 4`). The active group is the graph's (column 2).
  - Meanwhile the `activeTextEditor` waits pass. 4.13's `BloblangPanels.returnFocus` (`src/adapters/bloblangPanel/panels.ts:1376-1393`) confirms only `activeTextEditor`, not the active tab group.
  - The `2 !== 1` mode was already in a pre-sweep run (38990107216).
  - The logs can't tell whether this is product behaviour (the graph group taking the active group late, after the focus return) or only the test reading too early.
  - The graph's `lockLate` and the test panel's placement both move focus with no coordination (retro R-6).
- **CLOSE_UNSAVED + WITH_GRAPH (4.10)** and **OFFER + ACCEPT (4.16)**. CLOSE_UNSAVED has not failed on stable since 4.13's "no reopen on `ready`" fix.
- **VS Code freezing at startup** ("CodeWindow: detected unresponsive" before any test ran): 38429202033 attempt 1, and 39433758016 attempt 2. (Earlier text here said that attempt failed 3.7 CURSOR; its log shows the freeze.) This is runner load, not code.

A 2-CPU-pinned comparison (2026-10-20, suites 81, 84, 86, 90, 4 runs each on a9b5df2 and 7cc9bb5) flaked on both commits. It showed suite 84 `LATE_USER_EDITOR` / `LATE_ACTIVE`, and suite 90's 4.10 undo and close tests (`DELETED + UNDO + TWO_PANELS`, `UNDO_RELINK`, `CLOSE_UNSAVED`), which run `undo` / `revertAndCloseActiveEditor` on whatever editor is active.

## Acceptance Criteria

1. **Placement keeps the YAML's group active**
   - Given the graph is open and the user runs Test mapping (PLACE_WITH_GRAPH, PLACE_SECOND, PLACE_GRAPH_LEFT layouts),
   - When the test panel has been placed,
   - Then the YAML's editor group is the active tab group and the YAML is the active editor. The product confirms both signals, or the test waits for both, whichever the investigation shows is right, and the plan records which.
2. **Commands target their own editor**
   - Given a test that runs a command acting on the active editor (`undo`, `revertAndCloseActiveEditor`, the Fix all undo step),
   - When it runs,
   - Then it first makes its document the active editor and waits until `activeTextEditor` is that document.
3. **The lock and placement don't fight**
   - Given the graph's late lock (`lockLate`) and a test-panel placement happening close together,
   - When both move focus,
   - Then the final focus is defined: the YAML, in its own group. Suite 84's LATE_* tests and suite 90's PLACE_* tests pass together.
4. **A startup freeze is retried, not failed**
   - Given VS Code freezes at startup in CI before any test runs ("detected unresponsive"),
   - When that happens,
   - Then the CI step retries the launch once. A test failure is never retried.
5. **Proven stable**
   - Given the fix, when suites 81, 84, 86 and 90 run 8 times in a row pinned to 2 CPUs (`taskset -c 0,1`, under `xvfb-run -a`, alone), then all pass.
   - When CI runs 8 times in a row on the fixing commit (the push plus re-runs, counting every attempt), then the stable step passes every time.
   - Every attempt is recorded in the plan.

Out of scope: the 1.100 floor (non-blocking, user decision 2026-10-16).

## Notes

- Evidence: the retrospective's CI table and findings CI-1–CI-5 and P1–P7. A cleanly recorded comparison method is in its process notes (worktree per commit, `taskset`, separate `xvfb-run -n` displays).
- Candidates:
  - a shared "settled layout" wait in `src/test/integration/graphHelpers.ts`;
  - extend `returnFocus` to confirm the active tab group too;
  - the bug-15 confirm-and-retry pattern where the product moves focus.
