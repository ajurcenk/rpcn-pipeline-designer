---
title: 'Graph webview ready-timing flakes in CI'
type: 'bugfix'
ticket: '21'
created: '2026-10-26'
status: 'built'
baseline_revision: 'eb4ddbca735abce75de7e704e963c81c28893876'
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

**Problem:** `F6_DISPOSE` in `src/test/integration/suites/86-graph-interactions.ts` fails now and then in CI (and once locally): it pins the exact list of messages posted around a disposal, but the panel's real webview sends its own `ready` whenever it (re)loads, and the host answers each with a `snapshot` at a time the test does not control. Two other one-off failures (suite 81 `DRIVING` / `DRIVING_CLOSED`, suite 90's 4.10 undo tests) have no known cause.

**Approach:** The two `F6_DISPOSE` tests that pin post lists check what F6 is about, without depending on the real webview's `ready`: they record the post count at the moment of the disposal, and assert the exact posts before it (the edit's `model`; `ready`'s snapshot) and that nothing at all is posted after it. The edit test, where a real `ready` can be handled during its await, creates its panels with the existing test-only `ignoreWebviewMessages` seam, so only the test's own `receive` drives the protocol. No product change.

**Decision (user, 2026-10-26, after review):** use the `ignoreWebviewMessages` seam, not a filter that ignores snapshots (which would let a host regression posting an extra snapshot pass). The other two flakes are tried for a reproduction (looped locally, pinned to two CPUs like the CI runner); without one there is nothing to fix, and suite 81 already logs its full focus state on failure. The ticket's "8 CI attempts in a row" is checked only with the user's go-ahead, since it reruns the GitHub workflow.

</frozen-after-approval>

## Implementation Notes

Oneshot: one test helper and two tests in suite 86.

- `postedBetween(handle, from, to)`: the posted types in a range. "Hide graph while ready's snapshot is on its way": `atDispose` after Hide's synchronous part (no await between the counts, so a real `ready` can't post in the window); exactly `['snapshot']` before it, nothing after. "The panel closed while an edit's update is on its way": its panels use `ignoreWebviewMessages: true` (a real `ready` could be handled during the edit's await); `atClose` in the change listener just before `panel.dispose()`, declared before the listener; exactly `['model']` before it, nothing after.
- After review: first a filter that ignored snapshots; the user chose the existing `ignoreWebviewMessages` seam instead (Decision), and the first test keeps its exact check (its window was already deterministic). Full stable suite 936 passing (filter version); suite 86 with the seam, 5 runs pinned to 2 CPUs: the three F6_DISPOSE tests passed every time.
- Found on the way, not part of this ticket: in run 4 of that loop, story 12's `SAVE_AS (ticket 12)` HIDE test failed ("no graph auto-opened": 1 graph). The simulated Save As (create, fill, save, show) can take longer than the 2 s window on two busy CPUs, so it is not recognised. A real Save As takes about 50 ms. Reported to the user.
- Reproduction loop: suites 81, 86 and 90 (with suite 00), `taskset -c 0,1 xvfb-run`, 10 runs: 9 passed (129 each); run 5 lasted about 5 hours (the machine slept) and timed out one suite 90 test, `LABEL_PREFIX + WHOLE_LINE + BROKEN_YAML (4.10) + WITH_GRAPH`, after 90 s, which is the sleep, not a reproduction. `DRIVING` / `DRIVING_CLOSED` and the 4.10 undo tests never failed (the ticket's rate was about 1 in 60 runs for `DRIVING`).

## Review Triage Log

Quick review. Verdicts: 0 high, 1 medium, 1 low, 1 noted.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The ticket's "8 CI attempts in a row" is not shown | noted | user | Needs the GitHub workflow rerun 8 times; waits for the user's go-ahead. |
| 2 | The Hide test's check was loosened where nothing was flaky (no await between the counts) | low | patch | Exact `['snapshot']` again, plus nothing after the dispose. |
| 3 | Ignoring every snapshot in the edit test would hide a host regression; the existing `ignoreWebviewMessages` seam removes the race | medium | intent (user) | The user chose the seam (Decision); exact `['model']` kept. |
| 4 | `atClose` declared after the closure that sets it | low | patch | Declared before; asserted set. |

## Verification

**Commands:**
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "F6_DISPOSE"` -- expected: all pass.
- The reproduction loop above -- expected: no failure other than environmental ones.
- The full stable suite (alone) -- expected: all pass.
- With the user's go-ahead: the CI workflow's stable step, 8 attempts on one commit -- expected: all pass.
