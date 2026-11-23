---
title: 'Bug 59: new metrics access leaves a pipeline on "No figures yet"'
type: 'bugfix'
ticket: '59'
created: '2026-11-21'
status: 'built'
baseline_revision: '6ea06ec07ee4aa478c432b957a11dad90b3e52cd'
route: 'oneshot'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** When a Cloud feed's metrics access is set or replaced, `accessChanged` in `src/adapters/vscode/metricsFeed.ts` clears the refusal and the failure count but keeps `notServed` and `noSeriesReads`. So `refreshState` puts the old not-served (or "No figures yet") state back, and the feed doesn't read on until the user presses Read again. The access-removed branch doesn't clear `notServed` either.

**Approach:** An access change starts the feed's state over: both branches also clear `notServed` and `noSeriesReads`, so the next read with the new access sets the state from its own result. A read in flight with the old access is still dropped, as now.

</frozen-after-approval>

## Implementation Notes

- Oneshot: one state reset in one function, plus tests (about 70 lines).
- `src/adapters/vscode/metricsFeed.ts` `accessChanged`: the set-or-replaced branch now also clears `noSeriesReads` and `notServed`, and the removed branch also clears `notServed`.
- `src/test/adapters/vscode/metricsFeed.test.ts`: the fake Cloud source gained a `'notServed'` answer (a not-served answer, not no-series). Four tests were added: replaced after no series (cause `noSeries`), replaced after a not-served answer (cause `answer`), replaced mid-count (the no-series count starts over), and removed, then set again. All four fail without the fix and pass with it (`--grep "bug 59"`).
- Surprise: `--grep` runs from `out/`, so `npm run compile-tests` must come first.

- Review patch: the set-or-replaced branch also drops the old access's readings (`readings`, `last`) and always goes to `waiting`. Without this, a feed that had gone live kept its old figures as Live after the replace. The header (L30) already says readings are dropped on an access change. A test covers this case.

- Verification (2026-11-21, after the review patches): compile clean; test:webview 421 passed; test:corpus 182 passed; layering grep empty; stable 1736 passing, 1 pending; multiroot 15 passing.

## Review Triage Log

**Pass 1 (quick):** high 0, medium 2, low 1, false 0, maybe-false 0. Routes: 2 patch, 1 rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | "ACCESS REPLACED mid-count" can pass without the fix: `answers` is set after `fire()`, so a read `resume()` starts at once takes the default `ok` | medium | patch | Confirmed: `resume()` reads synchronously when `floorWait` is 0, and the fake shifts `answers` before its first await. Fix: `answers` is set before `fire()`. |
| 2 | No test covers the removed branch's new `notServed` reset, and the reset is not observable | low | reject | Confirmed: `refreshCloudState` gives `noAccess` first, and every way out of it clears `notServed`. The reset is harmless and matches the plan's approach (both branches start over). A test can't observe it, and the fix would be a deletion with no user effect. |
| 3 | After a replace, a feed that had readings shows Live on the old access's figures, for up to 4 more no-series reads | medium | patch | Confirmed: `refreshCloudState`'s last branch gives `live` when `readings.length > 0`. Before the fix this case stayed `notServed`. Fix: drop `readings` and `last`, set `waiting`, and add a test. |

## Verification

**Commands:**
- `npm run compile` -- expected: no errors
- `npm run test:webview` and `npm run test:corpus` -- expected: all pass
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no output
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: all pass, the new `metricsFeed` tests included
- the same with `--label multiroot` -- expected: all pass

## Manual Check

- 2026-11-23, the user, VS Code 1.143.1 dev host from `.vscode-test`: the manual check passed with no issues: with `metrics_a` stopped the tab reached "No figures yet", and after starting it and setting up metrics access again with the same credentials the tab went Waiting, then Live, without Read.
