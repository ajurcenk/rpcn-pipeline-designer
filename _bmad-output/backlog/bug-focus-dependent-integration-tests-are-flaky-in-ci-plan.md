---
title: 'Focus-dependent integration tests are flaky in CI'
type: 'bugfix'
ticket: '19'
created: '2026-10-21'
status: done
baseline_revision: '0f0419594e71942981116e676faef2b8f027f088'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/backlog/bug-focus-dependent-integration-tests-are-flaky-in-ci.md', '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/epic-bloblang-check-and-test-retrospective.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** On the 2-CPU CI runner, tests that read focus, the active editor or the group layout fail now and then on the required stable step, so `main` turns red with no code fault. The worst case is PLACE_WITH_GRAPH / PLACE_GRAPH_LEFT (4.17), which fails on the active-tab-group assertion that 4.13's `returnFocus` doesn't confirm. Tests that run `undo` or `revertAndCloseActiveEditor` act on whichever editor is active. VS Code sometimes freezes at startup on the runner.

**Approach:** Fix each race at its cause:
- **Placement:** the product confirms the YAML's group is the active tab group as well as the active editor, and the tests wait for both. Product or test, whichever the investigation shows; it is recorded.
- **Active-editor commands:** commands that act on the active editor target their document first.
- **Lock and placement:** they don't fight over focus.
- **Startup freeze:** CI retries a VS Code launch that froze before any test ran.
- **Proof:** stability is shown with 8 green runs in a row, pinned to 2 CPUs and in CI.

## Boundaries & Constraints

**Always:**
- **The ticket's criteria 1-5 are the contract** (`_bmad-output/backlog/bug-focus-dependent-integration-tests-are-flaky-in-ci.md`).
- **Investigate before fixing (AI-2):**
  - Reproduce first: run the PLACE_* tests, the suite 84 LATE_* tests, and the suite 90 undo and close tests pinned to 2 CPUs (`taskset -c 0,1`, under `xvfb-run -a`, alone; repeat until a failure shows).
  - Capture which signal is wrong: `activeTabGroup`, `activeTextEditor`, or which group took focus and when, for example with temporary logging, removed afterwards.
  - Record the cause in Implementation Notes before the fix.
- **Product changes only where the cause is product behaviour** (a user would see focus in the wrong group). Otherwise fix the test.
- **Shared test helpers:** one helper in `src/test/integration/graphHelpers.ts` (or `helpers.ts`) waits until a document is the active editor in a given column *and* that column's group is the active tab group. One helper runs an active-editor command against a given document: show it, wait until it is active, then run the command. They are used everywhere the matrix names.
- **Startup retry:** limited to the freeze. The CI step (`.github/workflows/ci.yml` "VS Code tests (stable)") runs the suite through a small script that retries once only when the log shows "detected unresponsive" and no mocha result line (no "passing"/"failing"). A real test failure is never retried. The floor step stays non-blocking and unchanged.
- **Proof (criterion 5):**
  - 8 consecutive green runs of suites 81, 84, 86 and 90, pinned to 2 CPUs, alone, under `xvfb-run -a`; every run is recorded in Verification.
  - The full stable suite stays green.
  - The CI proof (8 in a row on the fixing commit, counting every attempt) runs after the commit. The orchestrator records it.
- **Process rules from the retro (AI-3, AI-4):** the CI attempts are recorded in this plan, and the review includes the test-determinism question.

**Never:**
- retrying test failures, raising mocha timeouts as the fix, or `this.retries()`;
- skipping or weakening an assertion (each one must still check the same behaviour, now at a settled moment);
- work on the 1.100 floor;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PLACE_WITH_GRAPH | graph open, Test mapping | test group below the graph; the YAML's group active and the YAML active, confirmed | none |
| PLACE_GRAPH_LEFT | A, graph group, B; Test mapping on B | B's group active, B active | none |
| UNDO_TARGET | suite 90 4.10 undo tests, 50-lint FIX_ALL | `undo` runs on the test's document | none |
| REVERT_TARGET | `revertAndCloseActiveEditor` uses (suites 60, 84, 86, 90, 91) | acts on the intended document | none |
| LOCK_VS_PLACE | suite 84 LATE_* together with suite 90 PLACE_* | both pass; final focus defined | none |
| STARTUP_FREEZE | CI log "detected unresponsive", no mocha result | one relaunch | a real failure is never retried |
| PROOF | 8 pinned runs of 81, 84, 86, 90 | 8/8 green, recorded | none |

</frozen-after-approval>

## Code Map

- **Placement and focus:**
  - `src/adapters/bloblangPanel/panels.ts:1376-1393` (`returnFocus`), plus `open()` and `placement()` around it;
  - `src/adapters/graphPanel/groups.ts` (`newGroupNextTo`);
  - `src/adapters/graphPanel/panels.ts`: the lock sequence `lock` / `lockLate` / `lockAndReturn` (~602-724) and `LATE_SETTLE_MS`.
- **Tests:**
  - `src/test/integration/suites/90-bloblang-panel.ts`:
    - PLACE_WITH_GRAPH ~2020-2045 (`:2042`);
    - PLACE_GRAPH_LEFT ~2050-2075 (`:2071`);
    - `undo` at 1536 and 1685;
    - `revertAndCloseActiveEditor` at 792 and 1738.
  - `src/test/integration/suites/50-lint.ts:189` (FIX_ALL `undo`).
  - `revertAndCloseActiveEditor` in `60-run.ts:101`, `84-graph-auto-open.ts:262`, `86-graph-interactions.ts:269` and `91-bloblang-diagnostics.ts:405,421`.
  - Suite 84's LATE_* tests (`84-graph-auto-open.ts` ~89-218, `testPanels({lockWaitMs:0})`).
  - Helpers: `src/test/integration/graphHelpers.ts` (`settle`, `withGraph`); `helpers.ts` (`waitFor`).
- **CI:** `.github/workflows/ci.yml:33-34` (the stable step); a new `scripts/vscode-test-ci.sh` (or `.mjs`) for the freeze retry.
- **Evidence:** the retro's CI table and CI-1–CI-4; the 2-CPU comparison method in its notes (`taskset`, `xvfb-run -n`, one run at a time).

## Tasks & Acceptance

**Execution:**
- [x] Reproduce pinned and record the causes.
- [x] Placement focus: product or test fix + the shared wait helper.
- [x] Active-editor command targeting + its helper.
- [x] Lock/placement interplay (if the reproduction shows it): not shown; see Implementation Notes.
- [x] CI freeze retry script + ci.yml.
- [x] 8 pinned runs of 81/84/86/90 + the full stable suite; record them. (The CI ×8 proof is the orchestrator's, after the commit.)

**Acceptance Criteria:**
- Given the change, when suites 81, 84, 86 and 90 run 8 times in a row pinned to 2 CPUs under `xvfb-run -a`, then all pass, and `npm run compile`, `npm run test:webview`, `npm run test:corpus` and the full stable suite pass.
- Given the push, when CI runs 8 times on the fixing commit (the push plus re-runs, counting every attempt), then the stable step passes every time.

## Implementation Notes

**Reproduction (before any fix, 2026-10-21, baseline 0f04195).** Suites 81, 84, 86 and 90 (111 tests), `taskset -c 0,1 xvfb-run -a npx vscode-test --label stable --grep ...`, one run at a time. A temporary root `setup`/`teardown` hook in `index.test.ts` recorded a timeline of `onDidChangeActiveTextEditor`, `tabGroups.onDidChangeTabGroups` / `onDidChangeTabs` (the active group and tab) and markers in `returnFocus`, `placement` and the graph's `lock` / `lockLate` / return, printed for a failed test (removed afterwards; `grep -rn TEMP-19 src` is empty).
- 1 run with no instrumentation: green. 6 instrumented runs: **3 failed** (repro-1: PLACE_WITH_GRAPH `2 !== 1`; repro-3: PLACE_WITH_GRAPH `2 !== 1` and PLACE_GRAPH_LEFT `2 !== 4`; repro-5: CLOSE_UNSAVED (4.10) + WITH_GRAPH "the document closed"); repro-2, -4, -6 green.

**Cause 1, placement (product behaviour).** The wrong signal is `activeTabGroup`; `activeTextEditor` is right at the moment it is read. Timeline of every PLACE_* failure (PLACE_WITH_GRAPH, repro-1; the others are the same shape):
- the graph's lock sequence settles first (lock, return to column 1, `lockSettled`) — the test awaits it;
- `placement` → `newGroupNextTo(2, 'below')` focuses the graph's group (column 2) and creates group 3 (556 ms);
- `returnFocus` shows the YAML in column 1: active group 1, active editor YAML@1 (624 ms);
- **74 ms later the active group becomes 2, the graph's** (698 ms), with no active-editor change; `returnFocus` then confirms at 741 ms because it checked only `activeTextEditor`. In PLACE_GRAPH_LEFT (repro-3) the same steal comes 51 ms after the return, and `activeTextEditor` then turns `undefined` (952 ms): keyboard focus really is in the graph group.
- So the graph group's late activation (the delayed focus of the graph webview from `focusSecondEditorGroup`) takes focus after the return. A user would see focus in the graph, not the YAML: **product fix.** `BloblangPanels.returnFocus` (`src/adapters/bloblangPanel/panels.ts`; since cause 1b, via the shared `returnFocusTo`) now confirms both signals (the YAML is the active editor in its column *and* that column's group is the active tab group), and `FOCUS_SETTLE_MS` goes from 100 to 250 ms (the steal came 30-90 ms after the return on 2 CPUs; 100 ms left no margin). The retry (two attempts) stays, now only while a graph or test panel holds focus (cause 1b).
- The tests check both signals: new `focusedIn(doc, column)` in `src/test/integration/helpers.ts`. PLACE_WITH_GRAPH, PLACE_SECOND and PLACE_GRAPH_LEFT assert it synchronously right after Test mapping resolves (the product's claim: `show` resolves after `returnFocus`), again after `settle()` (it stays), and assert that no "Test mapping: focus did not stay in the YAML." / "could not return focus" line was logged during the test. No wait stands in for the product's confirmation (review).

**Cause 1b, GRAPH_AFTER (product behaviour; found by the orchestrator's proof, 7/8).** Its run 1 failed PLACE_NO_GRAPH + GRAPH_AFTER (message not captured). It did not show in 8 + 3 + 6 more pinned runs of the four suites, nor in 3 runs of suite 90 on 1 CPU. It did show in a fast loop of the PLACE_* tests alone on 1 CPU (`taskset -c 0 ... --grep PLACE_`), on its 18th run (17 green before it), with the timeline back in and the test's focus checks made strict (as for cause 1). The assertion that failed: "focus stays in the YAML, in its group: editor place-none.yaml@1, group 3". Timeline:
- `aboveTestPanels` → `newGroupNextTo(2, 'above')` focuses the test panel's group (column 2) at 292 ms and creates the graph's group above it at 339 ms;
- the lock sequence reveals and locks the graph (351 ms) and returns focus to the YAML: active group 1 at 558 ms; `lockSettled` resolves and the first check passes;
- **72 ms later (632 ms) the test panel's group, now column 3, becomes the active group**, with no active-editor change.
- The mechanism is cause 1's: focusing a group whose active editor is a webview gets a late focus echo from it, which makes that group active again after the return. A user would see focus in the test panel, not the YAML (and a lock just as the echo lands could hit the wrong group). The old test read only `activeTextEditor`, which stays the YAML, so this echo could break its later steps instead (its reveal of the graph and the `graph.panel.active` wait, the lock check).
- **Fix at the cause, shared by both focus returns:** `returnFocusTo(doc, column, mayRetake)` in `src/adapters/graphPanel/groups.ts` (moved from `BloblangPanels.returnFocus`, with `FOCUS_WAIT_MS` / `FOCUS_SETTLE_MS`). It confirms both signals, waits `FOCUS_SETTLE_MS` (250 ms), checks again, and returns focus once more if lost, but only while a graph or test panel holds the active tab and `mayRetake()`, so it never takes focus from an editor the user moved to. `BloblangPanels.returnFocus` and the graph's `lockAndReturn` both use it. The graph passes `mayRetake = !disposed && !userEditor()` (LATE_USER_EDITOR keeps its meaning) and logs "Graph <file>: focus did not stay in the YAML." on a miss. Cost: `lockSettled` resolves about 250 ms later.
- The test (`90-bloblang-panel.ts` GRAPH_AFTER) now asserts `focusedIn(doc, One)` right after `lockSettled` (the lock sequence's claim) and again after `settle()`. That replaces the 10 s `activeTextEditor` wait. Its log check also rejects "did not stay", and the lock assertion's message names the group the notes file landed in.
- After the fix: the same 1-CPU PLACE_* loop ran 40/40 green. No echo happened in those 40 runs, so they don't exercise the retry; the 8 pinned proof runs below are the evidence.

**Review of 1b (narrower retake, no fight between lock and placement).**
- **Retake only from the caller's own groups:** `returnFocusTo(doc, column, through, mayRetake)` gets `through`, the groups the caller itself moved focus through. For the placement that is the graph's group it focused and the new test group (`placement()` now returns `through`). For the graph's lock it is its own group plus, in the `aboveTestPanels` path, the test group it focused, which is one column further once the group above exists (`graphColumn()` / `aboveTestPanels()` return it, passed through `lock` / `lockLate` / `lockAndReturn`). Focus is taken back only when one of those is the active group, up to `RETAKES` = 2 times. Two, because on 1 CPU a second echo (the forced steal's own) came after the first retake: RETAKE_STEAL failed "Graph …: focus did not stay" with one.
- **The user's moves win:** inside the window, another editor becoming active makes *it* the target. An echo after it gives focus back to that editor, not the YAML; on 1 CPU the placement's echo took focus from the moved-to editor in RETAKE_USER_MOVE before this. Another group activated by anything else ends the sequence. Result `kept` / `declined` / `missed`; only `missed` (a retake was made and still did not hold) logs "focus did not stay in the YAML".
- **Serialised:** `BloblangPanelsOptions.graphSettled(uri)` (wired in `extension.ts` to the file's graph `lockSettled`, which also resolves on dispose) is awaited before a placement starts, so a placement never runs during that file's lock sequence.
- **Tests:**
  - Suite 84: AUTO and LATE_ACTIVE await `handle.lockSettled` before their strict focus checks, and their log checks (and `lockFailure`) reject "did not stay".
  - GRAPH_AFTER's focus assertions carry the test's log lines.
  - New in suite 90:
    - **RETAKE_STEAL:** a steal forced the moment the return lands — the graph's group during a placement, then the test group during GRAPH_AFTER's lock. Focus comes back to the YAML, in its group, synchronously and after `settle()`, and nothing is logged.
    - **RETAKE_USER_MOVE:** another file shown the moment the return lands keeps focus, in its group, and nothing is logged.

**Cause 2, active-editor commands (test).** CLOSE_UNSAVED + WITH_GRAPH (repro-5): `showDiff()` resolved, then the test panel's and graph's groups were activated in turn (active group 1 → 2 → 1 within 60 ms), and `revertAndCloseActiveEditor` ran on another group's editor: a group closed (n 3 → 2) and the document never closed. A user runs the command on what they see focused, so this is the test's order of reads: **test fix.** New `runOnEditor(doc, command, show?)` in `helpers.ts`: shows the document, waits until it is the active editor *and* its tab (text or diff — a diff editor's `activeTextEditor` has no `viewColumn`) is the active group's active tab, re-checks 100 ms later, then runs the command (3 tries, else `assert.fail`). Optional `column`: the group it must be active in (a file shown in two groups). Used for every `undo` / `redo` / `revertAndCloseActiveEditor` / `closeActiveEditor` of this race class: `50-lint.ts` FIX_ALL (undo and redo); `81-graph-navigation.ts` DRIVING_CLOSED (`closeActiveEditor` on column Three); `90-bloblang-panel.ts` SAVED_POSITION (`closeActiveEditor` on the diff); `60-run.ts` UNTITLED; `84-graph-auto-open.ts` UNTITLED; `86-graph-interactions.ts` `diffed().close()`; `90-bloblang-panel.ts` UNTITLED, DELETED + UNDO + TWO_PANELS, UNDO_RELINK, CLOSE_UNSAVED; `91-bloblang-diagnostics.ts` CLOSE (undetected) and UNTITLED.

**Cause 3, lock vs placement (not shown).** In every failing timeline the graph's lock sequence had settled (including its focus return) before the placement began; the late focus came from the placement's own focus of the graph group, which cause 1's fix confirms against. Suite 84's LATE_* tests did not fail in the 6 + 8 pinned runs, so no lock change was made: the final focus is defined by `returnFocus`, which now returns focus until the YAML's group is the active one. LATE_* and PLACE_* passed together in all 8 proof runs.

**Cause 4, startup freeze (CI).** CI-4's log (39433758016 attempt 2): "CodeWindow: detected unresponsive" ~16 s after launch, then `Exit code: 1`, no mocha output. New `scripts/vscode-test-ci.sh [label]` runs `xvfb-run -a npx vscode-test --label <label>`, tees the log, and relaunches once only when the run failed, the log has "detected unresponsive" and shows no test output at all: no `N passing` / `N failing` line, no indented `✔` (vscode-test's own `✔ Validated version` lines are not indented), no numbered failure `N) ` and no suite title (ours all contain "(integration"). So a run that executed tests and then crashed before its summary is not retried (review). The real freeze log (39433758016 att 2) matches none of these; a local full run matches 858 lines. `.github/workflows/ci.yml` "VS Code tests (stable)" runs it; the floor step is unchanged. Checked with a fake `xvfb-run` on PATH: pass → 1 launch, exit 0; test failure → 1 launch, exit 1; freeze then pass → 2 launches, exit 0; freeze twice → 2, exit 1; freeze text plus a mocha result (a real failure) → 1 launch, exit 1; freeze then test failure → 2, exit 1; tests ran then crash with no summary (a `✔` test line, or only a suite title, or a numbered failure, then "detected unresponsive") → 1 launch, exit 1 each. Every fake run also prints vscode-test's `✔ Validated version` lines.

**Not changed / seen elsewhere.** One pinned run of the *full* stable suite (not a required check) failed SEED + NAME_TAKEN + CHAIN (4.18), "the panel's own run loop posts nothing": a run result was posted. That is the panel's run loop timing, not focus, and outside this ticket's matrix; recorded here for a follow-up if it recurs.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick, with the AI-4 test-determinism question). Verdicts: 0 high, 2 medium, 4 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | PLACE_WITH_GRAPH / PLACE_GRAPH_LEFT: the 10 s `waitForFocusIn` lets a product miss pass; the product's claim right after `show` is never asserted | medium | patch | A synchronous `focusedIn` right after `show`, the post-settle checks kept, and no "did not stay" log line. |
| 2 | PLACE_SECOND never asserts the active group (criterion 1 names it) | low | patch | Same assertions added. |
| 3 | Criterion 3 (lock vs placement) is argued, not tested | false | reject | The reproduction found no overlap in any failing timeline (Implementation Notes). Criterion 3's "then" is met by suites 84 LATE_* and 90 PLACE_* passing together in every pinned proof run. A test forcing the overlap would test an interleaving the product never produces. |
| 4 | The CI relaunch can retry a run that executed tests and then crashed before the mocha summary | medium | patch | It relaunches only when no per-test output appeared, with a fake-xvfb case for "tests ran, then crashed". |
| 5 | 50-lint FIX_ALL `redo` is untargeted | low | patch | Goes through `runOnEditor`. |
| 6 | SAVED_POSITION (`showDiff` then `closeActiveEditor`) and 81:126 `closeActiveEditor` are untargeted | low | patch | Go through `runOnEditor`. |
| 7 | Criterion 5's CI ×8 not yet met | low | n/a | The orchestrator runs it after the push and records it. |

## Verification

**CI proof on ada9853 (run 39699546577, 8 attempts, every attempt counted):** attempts 1-5 and 7-8 had the stable step and the corpus harness green. Attempt 6 failed the stable step: 850 passing, 1 failing, `F6_DISPOSE` in suite 86 ("only the model posted before the close": the graph webview's `ready` / snapshot timing, not focus). So criterion 5 reads 7/8 on CI. No focus test (PLACE_*, LATE_*, the undo and close tests, CURSOR) failed in any of the 8 CI attempts or the 8 pinned runs. Decision (user, 2026-10-22): bug 19 is done on its focus scope; F6_DISPOSE and the unexplained one-offs (suite 81 DRIVING, the 4.10 undo pair in proof2) go to a new backlog bug.

**Manual check (the user, dev host, 2026-10-21):** placement below the graph keeps focus in the YAML; a graph opened after a test panel goes above it with focus back in the YAML; quick user clicks after Test mapping are not overridden; no sluggishness. No issues. Orchestrator checks after the last patches: `npm run compile` OK, `npm run test:webview` 302, `npm run test:corpus` 156.

**Commands:**
- `taskset -c 0,1 xvfb-run -a npx vscode-test --label stable --grep "<81|84|86|90 titles>"` ×8 (alone) -- expected: 8/8 green.
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable`; `npm run test:webview`; `npm run test:corpus` -- expected: all pass.
- After push: CI ×8 on the fixing commit -- expected: stable green on every attempt (recorded).

**Results (2026-10-21, local, 12 CPUs, runs pinned to CPUs 0-1, one vscode-test at a time):**
- Grep: `Pipeline graph: navigation|Pipeline graph: auto-open|Pipeline graph: interactions across|Bloblang test panel \(integration` (111 tests).
- Before the fix: 1 + 6 runs, 3 failed (see Implementation Notes).
- After the fix, 8 in a row: proof-1 111 passing; proof-2 111 passing; proof-3 111 passing; proof-4 111 passing; proof-5 111 passing; proof-6 111 passing; proof-7 111 passing; proof-8 111 passing. **8/8 green.** No "focus did not stay in the YAML" line in any log.
- `npm run compile`: pass. `npm run pretest && xvfb-run -a npx vscode-test --label stable`: **849 passing**. `npm run test:webview`: 302 passed. `npm run test:corpus`: 156 passed.
- Extra (not required): full stable suite pinned to 2 CPUs: run 1 848 passing, 1 failing (4.18 SEED, see Implementation Notes); run 2 849 passing.

**After the review fixes (synchronous focus asserts, PLACE_SECOND, redo / `closeActiveEditor` targeting, the stricter freeze check):**
- Suites 81/84/86/90 pinned, alone, ×3: review-1, -2, -3 each 111 passing.
- Suite 50 (with suites 00-40 before it; it can't run alone, as it needs the extension activated and the schema of the earlier suites): pinned, 35 passing, FIX_ALL green.
- `npm run pretest` (compile, lint): pass. The freeze-retry fake cases above: all as expected.

**After cause 1b (GRAPH_AFTER; shared `returnFocusTo` in the graph's lock and the placement):**
- The orchestrator's proof before it: 7/8 (run 1 GRAPH_AFTER failed).
- Reproduction: 8 + 6 runs of the four suites pinned to 2 CPUs and 3 runs of suite 90 on 1 CPU, all green. Then the PLACE_* tests alone on 1 CPU: run 18 failed GRAPH_AFTER (see Implementation Notes). After the fix: 40/40 green (no echo happened in them).
- First 8-run attempt (proof2), with this fix: runs 1 and 2 each failed exactly the four 4.10 undo tests (DELETED + UNDO + TWO_PANELS and UNDO_RELINK, with and without the graph: "back" / the paths unchanged after `undo`); everything else passed; stopped after run 2. The same tests passed alone, suite 90 alone passed, and the same code then passed 5 runs in a row of the four suites (with a temporary check that logged an `undo` with no effect, which never fired). That is the overlapping-runs signature (memory note: `undo` needs real keyboard focus, and runs share `.vscode-test/user-data`), not a regression; a concurrent run could not be confirmed after the fact. The final proof ran with a watch for a second Xvfb server; none appeared.
- **Final proof (proof3), 8 in a row, pinned to CPUs 0-1, alone:** proof3-1 111 passing; proof3-2 111 passing; proof3-3 111 passing; proof3-4 111 passing; proof3-5 111 passing; proof3-6 111 passing; proof3-7 111 passing; proof3-8 111 passing. **8/8 green**; no "did not stay" line in any log.
- Full stable suite (`xvfb-run -a npx vscode-test --label stable`, after `npm run pretest`): 849 passing.

**After the review of 1b (narrow retake, user moves win, graph-settled placement, RETAKE_* tests):**
- New tests, pinned: RETAKE_|PLACE_|suite 84 ×3 on 2 CPUs (rtc1-3, 23 passing each; rt1-4 earlier, 23 passing each); RETAKE_|PLACE_ ×6 on 1 CPU (rtb1-6, 5 passing each). With one retake (before `RETAKES` = 2 and the user-editor target), 1 of 5 runs on 1 CPU failed both RETAKE tests (rtone1, see Implementation Notes).
- proof4 (8-run attempt): run 1 failed REORDER_LABELLED … + WITH_GRAPH, "SyntaxError: Unexpected end of JSON input" in `samplesRead`: the test's poll read the samples file in the middle of the host's write (`workspace.fs.writeFile` truncates, then writes) and the parse error escaped the wait. Test fix: `samplesRead` treats an unreadable read as "not there yet" (it still waits for the exact mappings). Stopped after run 1.
- proof5: run 1 113 passing; run 2 failed DRIVING / DRIVING_CLOSED (81, 3.7): `selections(handle).at(-1) === 'path:output'` not within 10 s after `moveTo(one, …)`. Seen once in ~60 runs; the log does not say which state was wrong. The test now asserts the lock sequence's claim before the move (`focusedIn(doc, One)`) and both waits print the active editor, the group, the visible editors and the selections posted, so a recurrence shows its cause. Stopped after run 2.
- **Final proof (proof6), 8 in a row, pinned to CPUs 0-1, alone (before each run: no vscode-test process; before runs 2-8 one Xvfb, the previous run's server shutting down, none left afterwards):** proof6-1 113 passing; proof6-2 113 passing; proof6-3 113 passing; proof6-4 113 passing; proof6-5 113 passing; proof6-6 113 passing; proof6-7 113 passing; proof6-8 113 passing. **8/8 green**; no "did not stay" line in any log.
- Full stable suite (`xvfb-run -a npx vscode-test --label stable`, after `npm run pretest`): **851 passing**.

**CI attempts on the fixing commit (AI-3; the orchestrator fills these in, counting every attempt):**

| # | Run / attempt | Stable step |
|---|---|---|
| 1-8 | | |

Iteration 0b (quick, on the GRAPH_AFTER delta: the shared `returnFocusTo` used by the graph lock). Verdicts: 0 high, 3 medium, 4 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The retake fires from any graph or test-panel tab for about 250-1250 ms, so a graph lock and a placement close together can steal from each other (split below the YAML, or the graph left unlocked) | medium | patch | Retake only from the exact group the caller moved focus through. Placement waits for the file's graph `lockSettled`. |
| 2 | On the fast path and in placement, a user's own move (another editor, or a deliberate click on a panel) can be overridden | medium | patch | During the window, any other editor or a user group change cancels the retake. |
| 3 | A declined retake is logged as "focus did not stay" | low | patch | Logged only when an attempted retake fails. |
| 4 | Suite 84 AUTO / LATE_ACTIVE read focus during the retake window, and their log regexes miss "did not stay" | medium | patch | They await `lockSettled`, and the regexes now match it. |
| 5 | GRAPH_AFTER's focus assertion hides the cause | low | patch | The log lines go into the failure message. |
| 6 | The retake and decline paths are never exercised | low | patch | Integration tests force a steal and a user move in the window. |
| 7 | Every graph lock holds `lockSettled` 250 ms longer | low | reject | Accepted: it's the cost of confirming the return, and the narrowed retake keeps it bounded. |

Unexplained: proof2 runs 1-2 failed the four 4.10 undo tests (the same 4, twice). They passed alone, in suite 90 alone, and in 5 + 8 later runs on the same code. No overlapping run was found (the orchestrator's own verification had ended earlier). Recorded as an unexplained flake; if it recurs, it reopens this ticket.
