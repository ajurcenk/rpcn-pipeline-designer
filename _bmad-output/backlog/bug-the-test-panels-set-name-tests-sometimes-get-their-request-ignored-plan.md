---
title: 'The Set NAME… tests wait for the webview before their run'
type: 'bugfix'
ticket: '35'
created: '2026-10-28'
status: done
baseline_revision: 'cb6bde5923f9db7e186a1328e895cf063b90e70b'
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

**Problem:** Ticket 32's Set NAME… tests post their own `run` right after the panel opens, while its real webview is still loading. When the webview's `ready` reaches the host after that run, the panel clears the offered names (a reloaded webview shows no result, ticket 32), and the test's `setVariableRequested` is ignored: no set, no `variableSet` (CI run 40794701387; a local run, OTHER_NAME and CANCEL).

**Approach:** The tests wait for the webview's ready snapshot before their run, as the suite's other panel tests do; the panel's rule (a name outside the latest result is ignored, `ready` clears the names) is unchanged.

</frozen-after-approval>

## Implementation Notes

Oneshot: one helper in the test suite.

- Whether a user can meet it: not in normal use. A result is posted for a `run` the webview sends, and a fresh webview sends one only after its `ready` (an empty input runs nothing, `TestPanel.tsx`); a later `ready` is a reload, which shows no result, so clearing the names is right. The one path left: a hidden panel's webview is recreated (`retainContextWhenHidden: false`) while a run the old webview sent is still in flight, its result reaches the new webview before the host handles the new `ready`, and the new webview shows a Set NAME… that the host no longer offers; with Run on change off, a click is then logged and ignored. That needs a hide and reveal inside one run, and a click shows nothing wrong beyond "nothing happens" (Run again offers it). Recorded, not fixed here (the ticket's rule stays).
- The webview's own `run` (the ticket's second late message) cannot race the tests: the new temp configs have no samples file and no stored view state, so the webview's input is empty and it runs nothing on `ready` or on `variableSet`.
- The test build is a development build (`npm run compile`), and `main.tsx` renders the panel in StrictMode, so the mount effect runs twice and the webview posts `ready` twice. `shown` therefore waits until no new snapshot comes for 500 ms, not only for the first one (review finding 1).
- The ticket's open question (was "setVariableRequested ignored" logged in the failing runs?) cannot be answered from the logs: the output channel is not in the test or CI logs. The cause is read from the code (`ready` clears `offered`; the tests ran before it) and confirmed by the reviewer.
- Files: `src/test/integration/suites/90-bloblang-panel.ts` only (`shown`, used by `stopped`, MASKED and UNKNOWN_REQUEST's second panel). The frozen Approach's "as the suite's other panel tests do" is loose: one other test waits for the ready snapshot; most panel tests do not depend on the offered names.

## Review Triage Log

Quick review. Verdicts: 0 high, 1 medium, 4 low, 0 false. The reviewer confirmed the cause in `panels.ts` and that every Set NAME… test now starts from a ready webview.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The test webview posts `ready` twice (StrictMode in the development build), so waiting for the first snapshot can still let the second `ready` clear the names after the test's run | medium | patch | Real: `main.tsx` renders in StrictMode, `npm run compile` builds with `NODE_ENV=development`. `shown` waits until no new snapshot comes for 500 ms. |
| 2 | "A user cannot meet the race" misses a run in flight while a hidden panel's webview is recreated | low | defer | Real but narrow (a hide and reveal inside one run, and a click that then does nothing); Notes reworded; recorded in deferred-work. |
| 3 | The notes do not say why the webview's own `run` cannot race the tests | low | patch | Notes: the temp configs have no samples or view state, so the input is empty and nothing runs. |
| 4 | The ticket's open question (the "ignored" log line) is unanswered | low | patch | Notes: the output channel is not in the test or CI logs; the cause is read from the code and confirmed by the review. |
| 5 | "as the suite's other panel tests do" overstates it | low | noted | Inside the frozen Approach, left as approved; Notes say one other test waits for the snapshot. |

## Verification Result

2026-10-28: with the first wait, the Set NAME… block passed 6 of 6 runs and stable 1054 passing. After the review patch (wait for the snapshots to settle): the block 6 of 6 (15 passing each), stable 1054 passing, multiroot 8 passing. Corpus and webview runs are not affected (a test file only). The CI run after the push is the check that matters (the failure was seen there once). Marked done by the user on 2026-10-29 at the push; no manual check (a test-only change).
