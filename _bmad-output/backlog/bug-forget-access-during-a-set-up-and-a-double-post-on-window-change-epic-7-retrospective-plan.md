---
title: 'Bug 60: Forget access during a running Set up, and a double post on a window change'
type: 'bugfix'
ticket: '60'
created: '2026-11-23'
status: done
baseline_revision: '7236d402d74191dffb3df8d0fdc5d6359600e0ac'
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

**Problem:** (a) Forget metrics access and Forget log access (`forgetAccess` in `src/adapters/vscode/cloudShared.ts`, called from the cluster row and the palette) never check the cluster's `SetUpGuard`. A Set up still running then stores the access again, so the "removed" message was false. Only the Pipeline Metrics tab's button checks today (`metricsPanel.ts` `act`, `!this.settingUp`). (b) The tab's `'window'` handler (`metricsPanel.ts` ~L385) decides whether the feeds already posted by comparing `this.posted.length`. That log is capped at `MAX_POSTED` (200), so once it is full every window change posts twice and fires `changed` twice.

**Approach:** (a) `ForgetHow` gains `settingUp(clusterId)`. Once `forgetAccess` has its cluster (row or pick), and before the "has no access set" check, a running Set up refuses: an info message `Set up <what> is already running for <cluster>; finish it first.` (the wording of `setUpRunningText` in `logsPanel.ts`), a log line, `notStarted`, and nothing removed. `cloudMetrics.ts` passes `this.settingUp.has` and `cloudLogs.ts` passes `this.settingUpLogs.has`. (b) The tab keeps a count of shows that is never capped. `postShow` increments it, and the `'window'` handler compares that count instead of `posted.length`.

## Decisions

- Forget while a Set up of the same access and cluster runs refuses with a message; it does not wait (the user, 2026-11-23).

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudShared.ts` L343-447 -- `SetUpGuard` (`has`), `ForgetHow`, `forgetAccess`. Add the refusal here, so the row, the palette and the tab (which runs the same command) all go through it.
- `src/adapters/vscode/cloudMetrics.ts` L207-218 `forgetAccess` and `src/adapters/vscode/cloudLogs.ts` L151 `forgetLogAccess` -- pass `settingUp`.
- `src/adapters/vscode/logsPanel.ts` L156 `setUpRunningText` -- keep its export and text; it may delegate to a shared `setUpRunningMessage(what, cluster)` in `cloudShared.ts`.
- `src/adapters/vscode/metricsPanel.ts` L385-394 the window handler; L735-760 `postShow`. Leave `posted` and `MAX_POSTED` unchanged (test seam). The tab's own `!this.settingUp` check stays.
- Tests: `src/test/integration/suites/99-metrics-access.ts` "SECOND" (L382: hold the first input with a promise, `setUp()`, `forget(clusterNode(VILNIUS))`); `src/test/integration/suites/97-logs.ts` (L2525 `view.forgetLogAccess`, L2773 the held Set up log access); `src/test/adapters/vscode/metricsPanel.test.ts` for the window test.

## Tasks & Acceptance

- [ ] `cloudShared.ts`, `cloudMetrics.ts`, `cloudLogs.ts` (and optionally `logsPanel.ts`) -- the Set up check in `forgetAccess`.
- [ ] `metricsPanel.ts` -- the uncapped show count; the window handler uses it.
- [ ] Tests named "bug 60", each failing without the fix: Forget metrics access from the row during a held Set up refuses (the message is shown, the access is stored after the Set up finishes, the result is `notStarted`); the same from the palette; the same for log access from the row; a window change after more than 200 posts posts once and fires `changed` once.

**Acceptance Criteria:**
- Given a Set up of metrics or log access running for a cluster, when Forget for the same access and cluster runs from the row, the palette or the tab, then it refuses with the message, removes nothing, and never reports a removal.
- Given a Set up running for another cluster, when Forget runs for this one, then it works as before.
- Given the tab with any number of posted messages, with or without readings, when the window changes, then it posts once and fires one change event.

## Implementation Notes

- Oneshot: one guard check in the shared Forget flow and one counter in the tab, plus tests (about 80 lines).
- `cloudShared.ts`: `ForgetHow.settingUp` is required. `forgetAccess` refuses once it has its cluster (row or pick) and before the "has no access set" check. The refusal is an info message from the new `setUpRunningMessage(what, cluster)`, a log line and `notStarted`. `cloudMetrics.ts` passes `this.settingUp.has`, and `cloudLogs.ts` passes `this.settingUpLogs.has`. `logsPanel.ts` `setUpRunningText` is left as it was; its text is the same.
- `metricsPanel.ts`: a private `shows` count, incremented in `postShow`, replaces `posted.length` in the window handler.
- Tests (each "bug 60"): `99-metrics-access.ts` (row and palette refused during a held Set up; Forget works again with another cluster's Set up held), `97-logs.ts` (row refused for log access), `98-metrics.ts` (a live feed and 210 sorts, then one window change: one show, one change). All three fail on the baseline source and pass with the fix (`--grep "bug 60"`).
- These tests are integration suites, not `metricsPanel.test.ts`: the window path needs the real feeds, and the Forget flow needs the Cloud fake.
- Review patches: the metrics test releases its held Set up in `finally`, and its gate promise is made before `script`. `setUpRunningText` delegates to `setUpRunningMessage`.

- Verification (2026-11-23, after the review patches): compile clean; test:webview 421 passed; test:corpus 182 passed; layering grep empty; stable 1739 passing, 1 pending; multiroot 15 passing.

## Review Triage Log

**Pass 1 (quick):** high 0, medium 0, low 4, false 0, maybe-false 0. Routes: 3 patch, 1 rejected. The reviewer found no bug in the production change.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The metrics "bug 60" test doesn't release its held Set up in a `finally`, so one failed assertion leaves `rpc-vilnius` guarded for every later test | low | patch | Confirmed: `release` ran only on the success path. Fix: the assertions sit in `try`, and `finally` releases. |
| 2 | Same test: if BYOC's input is never asked, `escape` stays a no-op and `await other` can hang until the timeout | low | patch | Confirmed: `escape` was assigned only inside the input function. Fix: the gate promise (and so `escape`) is made before `script`. |
| 3 | `setUpRunningText` (`logsPanel.ts`) and the new `setUpRunningMessage` duplicate the refusal text | low | patch | Confirmed. Fix: `setUpRunningText` delegates to `setUpRunningMessage('log access', …)`. There is no import cycle (`cloudShared.ts` imports `cloudView` for types only). |
| 4 | No test for "another cluster's Set up doesn't block Forget" with log access, nor for a window change with no readings | low | reject | Both flows share `forgetAccess`, and the other-cluster case is tested for metrics. The no-readings window path already posted once before the fix, so a test there couldn't fail on the defect. |

## Verification

**Commands:**
- `npm run compile` -- expected: no errors
- `npm run test:webview` and `npm run test:corpus` -- expected: all pass
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no output
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: all pass, the new tests included
- the same with `--label multiroot` -- expected: all pass


## Manual Check

- 2026-11-23, the user, VS Code 1.143.1 dev host from `.vscode-test`: the manual check passed with no issues. Forget access during a running Set up on rpc-vilnius was refused with the "already running" message from the row and the palette, and Forget worked once the Set up was escaped.
