---
title: 'The graph tests wait for the webview''s own ready'
type: 'bugfix'
ticket: '37'
created: '2026-10-29'
status: 'built'
baseline_revision: 'e3efd515da310ce60d03f51f32bcaa1665cb1c5d'
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

**Problem:** `withGraph` (and the navigation suite's own opens) answer the graph with a simulated `ready`, but the real webview posts its own `ready` too (twice in the test build, StrictMode), often later. A late `ready` posts a snapshot that carries the node under the cursor and marks it sent (`graphPanel.ts` `sentSelection`), so a cursor move the test just made gets no `selection` message of its own, and the tests that count `selection` messages time out ("one selection" in CURSOR, "selections []" in DRIVING; reproduced once in 12 loaded local runs).

**Approach:** The graph panel counts the `ready` messages its real webview sent (a test seam on the handle); the tests open a graph and wait for at least one, then for the snapshots to settle, before moving the cursor. No assertion is loosened, and the panel's behavior is unchanged: a user's webview gets the selection inside the snapshot, so a user cannot meet this.

</frozen-after-approval>

## Implementation Notes

Oneshot: a counter on the panel handle (`webviewReadies`, `graphPanel.ts`), one helper in `graphHelpers.ts` (`graphReady`) used by `withGraph`. The navigation suite's two direct opens (CLICK, BANNER_CLICK) move no cursor and count no selection, so they keep the host seam's `ready` only (review finding 8).

- Reproduced before the fix: 1 failure in 12 runs of the navigation suite on 2 loaded CPUs (`taskset -c 0,1` with two busy loops), CURSOR's "one selection", as on CI.
- Cause (confirmed by the review): `postSnapshot` sets `sentSelection` to the cursor's node before posting (`graphPanel.ts` ~:165), and `sendSelection` posts nothing for the node already sent. `editor.selection = …` is seen by the panel a turn later (`onDidChangeTextEditorSelection`), so a webview `ready` handled in between puts the move's node into its snapshot and the move posts no `selection`.
- A user cannot meet it (ticket criterion 3): the snapshot carries `selection`, and the webview applies it (`webview/src/state.ts` ~:87, `selection: message.selection`); messages arrive in the order posted, so the highlight is right and nothing is sent twice. A release build posts one `ready` (no StrictMode double effect), and a user's cursor move after it is answered as usual.
- `graphReady` waits up to 30 s for the first webview `ready` (as PANEL, suite 80), then at most 20 × 500 ms for them to stop, with a message for each failure. It is for a panel the registry just created: a panel made with `ignoreWebviewMessages` never counts one, and a revealed (reloaded) panel has counted its first load already (no current caller does either).
- The counter is a test seam in the shipped panel, like `posted` and `lockSettled`; the panel's behavior does not change (`receive` catches everything; the counter only counts).

## Review Triage Log

Quick review. Verdicts: 0 high, 0 medium, 7 low, 0 false. The reviewer confirmed the cause and found no other test in the graph suites that counts exact `selection` messages on a real webview without `withGraph`.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Criterion 3's answer (can a user meet it) is not recorded with evidence | low | patch | Implementation Notes: the webview applies `snapshot.selection` (`state.ts`), order kept, one `ready` in a release build. |
| 2 | No repeated loaded runs of the fixed code recorded | low | patch | Verification Result below. |
| 3 | The 15 s wait for the webview is half what PANEL allows | low | patch | 30 s. |
| 4 | For a revealed (reloaded) panel the wait can pass before the new `ready` | low | patch | Documented as the helper's limit; no caller reveals a panel before it. |
| 5 | An `ignoreWebviewMessages` panel would fail with a misleading message | low | patch | The message names that case. |
| 6 | The settle loop has no bound | low | patch | At most 20 rounds, with its own message. |
| 7 | A test-only counter and an async listener in the shipped panel | low | noted | As the existing seams; behavior unchanged. |
| 8 | CLICK and BANNER_CLICK gain the wait for nothing | low | patch | Reverted to the host seam's `ready`. |

## Verification Result

2026-10-29, after the review patches: every graph suite ("Pipeline graph") 10 times on 2 loaded CPUs: CURSOR and DRIVING passed in all 10 (before the fix, CURSOR failed 1 in 12 loaded navigation runs); stable 1058 passing; multiroot 8 passing. In those loaded runs `LATE_USER_EDITOR` (suite 84, the lock sequence of bug 19) failed 2 of 10, and once in an earlier loaded loop; it does not use `withGraph` or the new wait, and it has not failed on CI: recorded in deferred-work as an older flake under heavy load (user decision, 2026-10-29). Webview and corpus runs are not affected (no webview or core change). CI after the push is the check that matters.
