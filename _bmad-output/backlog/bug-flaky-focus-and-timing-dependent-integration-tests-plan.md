---
title: 'Some integration tests fail now and then in CI and pass on rerun'
type: 'bugfix'
ticket: '27'
created: '2026-10-27'
status: done
baseline_revision: 'fee97db9c21b6fa9293f9c7212f28049778b111f'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A few integration tests fail at random, mostly on CI's 2-CPU runner, and pass on rerun: suite 50's Quick Fix tests (about 1 run in 6 locally, all of them at once: the code actions list only "Fix" / "Explain"), and focus-dependent tests (suite 85's ESC in CI run 40398418336, `RETAKE_STEAL` on the 1.100.0 floor, suite 81's `DRIVING` in CI run 40539326874). Each red run without a regression makes the next real one easier to dismiss.

**Approach:** The Quick Fix tests ask for code actions once, right after the extension has the lint result; VS Code's copy of the diagnostics, which the request reads, can still be on its way. They wait for what they need: the request is repeated until the expected fix is offered (or a timeout, which fails with the titles seen). The focus tests that fail without saying why report the focus state at that moment (active editor and its group, active group and its active tab, visible editors), from one shared helper; suite 81 and `RETAKE_STEAL` already do. No product change.

**Decision (user, 2026-10-27):** after the push, CI's workflow runs 5 times on the pushed commit, and each result (and any failure's focus report) is recorded here.

**Decision (user, 2026-10-27, after the first loops):** FIX_ALL's undo (and redo) is retried when it did not change the text (up to three tries, the focus state printed on each retry): in 32 runs on two CPUs VS Code ignored the undo 3 times, while the Quick Fix requests never failed.

**Decision (user, 2026-10-27, at the push):** CI runs 2 times on the pushed commit, not 5.

</frozen-after-approval>

## Implementation Notes

Oneshot: a polling helper in suite 50, a shared `focusState` in `src/test/integration/helpers.ts` (suite 90's local one moves there), and ESC's assertions in suite 85 report it.

- Suite 50: `quickFixes(doc, range, want)` repeats the code action request until `want` is offered (10 s), in all five Quick Fix tests; `untilText(doc, command, text)` for FIX_ALL's undo and redo (Decision): a retry only when the document's version did not change, the focus state printed with it.
- `focusState()` in `src/test/integration/helpers.ts`: active editor and column, active group and its active tab (webview marked), visible editors. Suite 85 ESC's assertions carry it (before and after for "focus stays where it was"); suite 90 uses it instead of its own.
- Loops, suite 50 on two CPUs (`taskset -c 0,1`): with the request repeated, 9/10, then 8/10, then 12/12; all 3 failures FIX_ALL's undo leaving the fixed text (5 s wait), never a missing Quick Fix. With the undo retry: 10/10 (no retry printed).

## Review Triage Log

Quick review. Verdicts: 0 high, 1 medium, 3 low (2 rejected), 1 false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Suite 90: the removed `focusState`'s comment is left above `assertFocusKept` | low | patch | Removed. |
| 2 | `untilText` waits 2 s per try: an undo applied after 2 s is retried and undoes one step too many | medium | patch | 5 s per try, the wait the observed failures already had; a command applied by then changes the version and is not retried. |
| 3 | Three tries that all fail end silently; the assertion does not say a retry happened | low | patch | `untilText` returns the tries; FIX_ALL's messages carry them. |
| 4 | AC3 (5 CI runs) not recorded | false | — | It runs after the push (Decision); its results are recorded then. |
| 5 | Only ESC gains the focus report; other focus assertions (suites 84, 85 KEYBOARD, 90, 81's own format) have none | low | reject | The intent names the tests seen failing; suite 81 and RETAKE_STEAL already report; adding it everywhere is wider than the flakes. |

## Verification

**Commands:**
- `npm run pretest && taskset -c 0,1 xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|Lint"`, 10 times -- expected: the Quick Fix tests pass every time.
- `xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- After the push: the CI workflow, 5 runs on one commit -- expected: all pass, or each failure recorded with its focus report and a follow-up.

Local results (2026-10-27): suite 50 10/10 on two CPUs; full stable suite 946 passing; after the review patches, suites 50, 85 and 90 107 passing. CI 5 runs: after the push.

CI on c69102b (run 40558514970), 2 attempts (Decision): both succeeded. Stable 946 passing both times, no `[ticket 27]` retry printed; multi-root 3 passing both times. The 1.100.0 floor (non-blocking): attempt 1 failed `RETAKE_STEAL (bug 19)` with "focus stays in the YAML, in its group: editor none, group 2 (tab Graph: retake-steal.yaml [webview]), visible [retake-steal.yaml@1]" (the graph's webview group took focus back after the return, on 1.100.0); attempt 2 946 passing. Follow-up: deferred-work entry.
