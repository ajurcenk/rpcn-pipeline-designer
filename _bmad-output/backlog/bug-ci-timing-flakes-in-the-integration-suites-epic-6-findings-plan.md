---
title: 'The flaky integration tests wait on what they check'
type: 'bugfix'
ticket: '41'
created: '2026-11-09'
status: 'done'
baseline_revision: '9513ffbf71fc22d6b8d59d86ae40209422cfff82'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Five groups of integration tests fail now and then in a full stable run and pass on rerun (ticket 41, Reproduction 1–5). HELD (story 13) failed both attempts of CI run 42666712226 on ce1b557 (VS Code 1.145.2), which blocks the push of bugs 44 and 45's work; bug 44's local stable run passed it.

**Approach:** Each test waits on the condition it checks, with its assertions unchanged. The causes found by reading the code are below; none is a product race, so the product code does not change. A stall in the 4.5 suite cannot be pinned from the code; its unbounded wait gets a limit that names it, so a next stall says where.

**Decision (user, 2026-11-09):** build bug 41 before pushing; then push c8fdebd, e04c18f, 9513ffb and this work together, with a green CI.

## Boundaries & Constraints

**Always:** every assertion keeps its meaning and its message; a wait has a time limit and a message naming what it waited for; a fix in a shared helper keeps every current caller passing.

**Never:** product code changes; deleting, skipping or `retries()` on a test; a longer timeout as the only fix where a wrong signal is the cause; a floor (1.100.0) run; a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Cause (from the code) | Fix |
|----------|----------------------|-----|
| HELD (1) | the real webview's late `ready` answers with a snapshot carrying the new status; `postStatus` then skips it as already sent (F1_RACE, correct), so no `nodeStatus` follows and `statuses().length > before` never holds | wait for the webview's readies to settle (`graphReady`) before the seam's `ready`, in HELD and in every test of the suite whose panel has a live webview and counts `nodeStatus` |
| VALUE_DEFAULT (2) | `recordedKeys()` read synchronously after the remove; the memento's echo can lag | `waitFor` the record to go |
| 4.5 stall (3) | every wait has a limit except `handle.lockSettled` (graphHelpers) | a bounded wait naming it; the run keeps its outer `timeout` |
| RENAME (4) | the samples file moves asynchronously after the snapshot is posted | `waitFor` the old file to be gone, then the new file's content |
| Undo (5) | `undo` goes to the focused DOM element; a quick input left open or a window without OS focus makes it a no-op for every later test | one shared version-checked undo/redo helper (lint's `untilText`) that first closes quick open and focuses the active editor group, and logs window focus; the panel tests use it |

</frozen-after-approval>

## Code Map

- `src/test/integration/suites/82-graph-markers.ts` -- HELD :148 (`handle.receive({ type: 'ready' })` ~:177, the wait "the edit's model and status"); SAME/FROZEN :93 (ready :99); other `receive ready` at :57, :131, :215 -- check each panel for a live webview (`testPanels()` without `ignoreWebviewMessages`, `fakeDiagnostics().panels`).
- `src/test/integration/graphHelpers.ts` -- `graphReady` :90 (bug 37's wait for the webview's readies, reuse as is); `live` :56; `lockSettled` awaited at :137, :239.
- `src/adapters/graphPanel/graphPanel.ts` -- `postSnapshot` sets `postingStatus` :179-181; `postStatus` skips :363; `sendModel` :389-393. Read only; unchanged.
- `src/test/integration/suites/95-environment-view.ts` -- :294 "its record goes too".
- `src/test/integration/suites/90-bloblang-panel.ts` -- RENAME :2351, the assert :2367; undo tests DELETED + UNDO, UNDO_RELINK (with and without WITH_GRAPH) and DIRTY_RECORD around :1992, :2152, :2537.
- `src/adapters/bloblangPanel/panels.ts` ~:1250-1265 and `sampleStore.ts` :265-293 -- `void this.moveSamples(...)`; read only.
- `src/test/integration/suites/50-lint.ts` -- `untilText` :47, FIX_ALL :327.
- `src/test/integration/helpers.ts` -- `focusState` :47, `runOnEditor` ~:68, `waitFor`.
- `src/test/integration/suites/91-bloblang-diagnostics.ts` -- the 4.5 suite; `showGraph` with `lockSettled`.

## Tasks & Acceptance

**Execution:**
- [x] `82-graph-markers.ts` -- `graphReady(handle)` instead of the bare seam `ready` where the panel has a live webview -- HELD, SAME/FROZEN and any other the check finds.
- [x] `95-environment-view.ts` -- the record check as a `waitFor` (5 s) with the same message.
- [x] `90-bloblang-panel.ts` -- RENAME: `waitFor` the old samples file gone (10 s), then the new file read; the undo tests through the shared helper.
- [x] `helpers.ts`, `50-lint.ts` -- move `untilText` to helpers.ts as the shared version-checked undo/redo with the focus guards; `focusState()` adds `window.state.focused`; lint uses it unchanged in behavior.
- [x] `graphHelpers.ts` -- `lockSettled` awaited with a 15 s limit and a message naming it.
- [x] `_bmad-output/backlog/bug-ci-timing-flakes-in-the-integration-suites-epic-6-findings-plan.md` -- record CI run 42666712226 in Implementation Notes.

**Acceptance Criteria:**
- Given the change, when the changed suites run alone a few times and the full stable suite runs 3 times locally on one commit, then none of these tests fails and no run stalls; the run count and commit are recorded. (Decision, user 2026-11-10: option 1, in place of ticket criterion 1's 8 runs; the CI run after the push is the final check.)
- Given the push, when CI runs, then stable and multi-root pass on the first attempt.
- Given each fix, when the plan is built, then its cause and evidence are recorded in Implementation Notes, and a cause that turns out wrong is reported rather than covered by a longer timeout.

## Implementation Notes

- **CI run 42666712226** (push of ce1b557, VS Code 1.145.2): `VS Code tests (stable)` failed with 1357 passing, 1 pending, 1 failing -- HELD (story 13), `AssertionError: the edit's model and status`; multi-root, the floor, the corpus and the webview tests passed. The only failure is HELD, which matches cause (1).
- **HELD (1) and SAME/FROZEN** (`82-graph-markers.ts`): both panels are `testPanels()` without `ignoreWebviewMessages`, so their webview is live and posts its own `ready`s (two in the test build's StrictMode). A late webview `ready` answered after the republish or the edit posts a snapshot carrying the new status, sets `postingStatus` (graphPanel.ts :179-181), and `postStatus` then skips the status as already sent (:363) -- so no `nodeStatus` follows and a count of `nodeStatus` messages never grows. Both now call `graphReady(handle)` (bug 37's wait, unchanged) in place of the bare seam `ready`. The other seam `ready`s in the suite: :57 (SEND, after `withGraph`, which already waits) and :131 (SAME's deliberate re-ready, after the new wait) are snapshot checks on a settled webview; NO_PANEL (:215) does not count `nodeStatus` and already ignores snapshots, so it is unchanged.
- **VALUE_DEFAULT (2)** (`95-environment-view.ts`): the record check is a `waitFor` (5 s) with the same message; the memento's echo of the remove can lag it.
- **4.5 stall (3)** (`graphHelpers.ts`): `showGraph` and `autoOpened` now await `lockSettled(handle)`, a new exported helper that waits at most 15 s and fails with "the graph panel's lock sequence (lockSettled) did not end in 15 s: <uri>". The stall's root cause is not pinned from the code; the next one names where it is. The direct `await graph.lockSettled` calls in `90-bloblang-panel.ts` are outside this plan's scope and were left as they are.
- **RENAME (4)** (`90-bloblang-panel.ts`): `moveSamplesFile` (sampleStore.ts) moves with one `vscode.workspace.fs.rename`, after the snapshot is posted; the test now waits (10 s) for the old samples file to be gone, then reads the new one. One rename, so the old file gone means the new one is there.
- **Undo (5)** (`helpers.ts`, `50-lint.ts`, `90-bloblang-panel.ts`): `untilText` moved from lint to `helpers.ts`, with an optional `show`. Each try first runs `workbench.action.closeQuickOpen`, then shows the document (the caller's `show`, else its visible editor's column) and runs `workbench.action.focusActiveEditorGroup` as `runOnEditor`'s show step, so the command goes to the editor and not to a quick input or a webview; a window without OS focus logs `[bug 41] ... without OS focus` with the focus state. `focusState()` now ends with `window focused|not focused`. Lint calls it as before (same retries, same version check). DELETED + UNDO and UNDO_RELINK (with and without WITH_GRAPH) undo to `FOLLOW_CONFIG`; DIRTY_RECORD undoes to the text it saved.
- No product code changed; no assertion's meaning or message changed.
- **Runs (implementer, 2026-11-09/10)**, on 9513ffb plus this working tree (uncommitted): `npm run compile` 0; `test:corpus` 156 passed; `test:webview` 378 passed. Full stable runs: 1, 2, 3, 5 and 6 passed (1360 passing, 1 pending, 9-10 min each); none of the five tests failed in any run, and no run stalled. Run 4 failed one test outside this plan: 4.5 BURST / UNCHANGED (`parsed` was `[]` after `quiet()`, 91-bloblang-diagnostics.ts :326); that run took 15 min against about 9.5 and logged "No ptyHost heartbeat after 6 seconds", so the machine stalled. Its cause is not pinned (one reading: the debounced `update` found the binary state not `ok`, or ran after `quiet` saw 700 ms without a parse) and it is not fixed here. Run 7 was cut off with the session (no result) and runs 8 and multi-root were not run: the user stopped the repeated runs (2026-11-10); the orchestrator runs the rest.

## Plan Change Log

## Review Triage Log

Quick review (2026-11-10): 0 high, 0 medium, 2 low (1 patched, 1 rejected), 3 rejected (fix edits this plan), 1 deferred.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | The 15 s `lockSettled` bound cannot explain or surface a 44-minute stall: mocha's 90 s suite timeout would fail and name such a test; the helper's doc comment claims that cause | low | `91-bloblang-diagnostics.ts:95` `this.timeout(90_000)`; the frozen matrix row asks only for a bounded, named wait; the stall needs a blocked extension host or a runner hang outside mocha, not found from the code | patch (the doc comment says only what the helper does); the run keeps its outer `timeout` cap |
| 2 | VALUE_DEFAULT's cause has no evidence; `remove` awaits `memento.update` before the command returns | low | the investigation read the bundled VS Code 1.145.2 ExtHostMemento: an `onDidChangeStorage` echo for the key replaces its whole in-memory value from a 0 ms scheduler, so an echo of the earlier `set` can briefly bring the key back after `update` resolved; the `waitFor` checks the same condition with the same message | reject (the fix edits this plan's notes) |
| 3 | Undo: no evidence for the focus cause; the ticket's `applyEdit` undo-stop hypothesis not ruled out | low | the investigation read the `undo` command's handler order (focused code editor, then any focused input/textarea via native `execCommand`, then the active editor): a focus elsewhere makes `undo` a silent no-op; `applyEdit` resolves after its edit is pushed as its own undo step; the shared helper's version check and retry cover both | reject (the fix edits this plan's notes) |
| 4 | AC 1: the changed suites were not run alone; runs were on an uncommitted tree; BURST (4.5 suite) failed in run 4; no multi-root run | maybe-false | the suites-alone runs, the 3 full runs and multi-root are the orchestrator's verification, still to run on the reviewed tree; BURST is a 4.5 test the change does not touch (it uses neither `showGraph` nor `autoOpened`), failed once in a run that stalled the machine ("No ptyHost heartbeat") | defer (BURST, unverified medium); the rest is verification below |
| 5 | Other unbounded `await handle.lockSettled` calls remain outside the 4.5 suite (84, 86, 90) | low | each runs under its suite's mocha timeout, which names the test; ticket criterion 2 scopes the bound to the 4.5 suite; replacing them adds churn in suites with no reported stall | reject |

## Verification

**Commands:**
- `npm run compile` -- expected: 0, lint included.
- `npm run test:corpus`; `npm run test:webview` -- expected: pass.
- `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable`, 8 times in a row, alone, the dev host closed; then `--label multiroot` once -- expected: all pass every time. No floor run.

**Manual checks:**
- None; the proof is the repeated runs and the CI run after the push.

**Result (2026-11-10, after the review's patch, run by the orchestrator on 9513ffb plus this tree, unchanged across the runs):** compile (lint included) 0, corpus 156, webview 378. The changed suites alone (`--grep` the graph markers, Environment view, Bloblang test panel, Lint on save and Live Bloblang diagnostics suites), 3 times: 164 passing each time, with the Lint on save suite failing its `before all` only because `--grep` left out the suite that activates the extension ("not known or not activated"); Lint on save with the activation suite, 2 times: 19 passing. Full stable, 3 times in a row: 1360 passing, 1 pending, 0 failing each (9-10 min), no stall. Multi-root: 10 passing. The test settings clean before and after; no floor run. Decision (user, 2026-11-10): these runs in place of 8; the CI run after the push is the final check.
