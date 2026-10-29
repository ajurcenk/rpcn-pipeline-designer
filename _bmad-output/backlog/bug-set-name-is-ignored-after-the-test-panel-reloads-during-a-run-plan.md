---
title: 'Set NAME… names the result it belongs to'
type: 'bugfix'
ticket: '36'
created: '2026-10-29'
status: done
baseline_revision: '680a2f35722eb75e65662c4582ed78e9eb0e3039'
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

**Problem:** The extension guesses which result a test panel's webview shows: it offers the names of the last result it posted and clears them on the webview's `ready`. When a hidden panel is shown again during a run, the result and the new webview's `ready` (two of them in development builds, StrictMode) can cross, and the webview shows a Set NAME… the extension ignores.

**Approach:** Each posted result carries an id (one counter per panel). The webview sends the id of the result it shows with `setVariableRequested`. The extension accepts a request only when that id is the latest result it posted and that result lists the name. `ready` no longer clears the names (the id decides); the no-binary and removed states still do, since the webview drops its result there.

**Decision (user, 2026-10-29):** result ids, over closing as won't fix and over the webview-only fix (which hid working buttons and missed the development build). This replaces ticket 32's "after `ready`, nothing is offered" with "only the shown result's id is accepted".

## Boundaries & Constraints

**Always:**
- A request is accepted only for the latest posted result's id and a name that result lists (masking as today); anything else is logged and ignored, as now.
- The id is validated like the other fields (a non-negative integer); a request without one is ignored.

**Never:**
- Changing the result kinds, the set action, the other messages, or what a result shows.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ACCEPTED | result id N lists REGION; request {REGION, N} | the set action runs | none |
| LATE_READY | result id N posted, then the webview's `ready` (once or twice), then request {REGION, N} | the set action runs (the webview shows N) | none |
| STALE_ID | result N, then result N+1 (lists nothing or other names); request {REGION, N} | ignored, logged | none |
| NO_ID | request {REGION} with no id, or a malformed id | ignored | none |
| NOT_LISTED | request {OTHER, N} for a name N does not list | ignored, logged | none |
| NO_BINARY_REMOVED | result N, then the no-binary or removed state; request {REGION, N} | ignored (the webview dropped N) | none |
| WEBVIEW_SENDS_ID | the webview shows result N and Set REGION… is clicked | it posts {REGION, N} | none |

</frozen-after-approval>

## Code Map

- `src/shared/bloblangProtocol.ts` -- the host `result` message (~:121) gains `id: number`; its parse (the host-message validation) accepts a non-negative integer. The webview message `setVariableRequested` (~:155, parsed ~:334) gains `resultId: number`, required: without a valid one the parse returns `undefined`.
- `src/adapters/bloblangPanel/panels.ts` -- `offered` (~:327) becomes the latest posted result's `{ id, names }`; a per-panel counter. The run loop (~:925-933) assigns the next id when it posts. `ready` (~:394-397) no longer clears; `post` (~:1015-1024) keeps clearing for the no-binary and removed states. `setVariable` (~:892) takes `(name, resultId)` and checks both. Update the file's ticket 32 comment (~:95-101).
- `webview/src/bloblang/TestPanel.tsx` -- `setVariable` (~:665) posts `{ type: 'setVariableRequested', name, resultId }` with the shown result's id; `OutputView.tsx` needs no change (it calls back with the name).
- Tests:
  - `webview/src/bloblang/TestPanel.test.tsx` (ticket 32's block, ~:1560): results sent in the tests get ids; POSTED asserts `resultId`; add WEBVIEW_SENDS_ID for the shown result's id after two results.
  - `src/test/integration/suites/90-bloblang-panel.ts` (Set NAME… block, ~:545): requests carry the id of the result the helper got (`run` returns the posted result message); RELOAD becomes LATE_READY (a `ready` after the result does not stop {name, id}); add STALE_ID, NO_ID, NO_BINARY_REMOVED (the removed state is simpler: delete the processor); UNKNOWN_REQUEST keeps its other checks with ids.
  - Protocol unit tests (the `bloblangProtocol` test file under `src/test/`): the new field on both messages, valid and malformed.
- Docs: `CHANGELOG.md` Fixed line; `README.md` only if it states the reload rule (check the test panel's Set NAME… paragraph).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/bloblangProtocol.ts` -- the two fields and their validation, with unit tests.
- [x] `src/adapters/bloblangPanel/panels.ts` -- ids, the check, `ready` no longer clearing.
- [x] `webview/src/bloblang/TestPanel.tsx` -- send the shown result's id.
- [x] Tests for every matrix row (webview, integration, protocol).
- [x] `CHANGELOG.md` (and `README.md` if needed).

**Acceptance Criteria:**
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass; ticket 32's tests change only by the id (RELOAD replaced by LATE_READY).
- Given LATE_READY, when its test runs on the baseline, then it fails (the defect), and it passes with the fix.

## Implementation Notes

- The webview test helper `send` gives a `result` sent without an `id` the next one, so the other result tests stay unchanged; the six `src/test/fixtures/bloblang/result-*.json` fixtures and `host.ts`'s `isOkResult` check gained an `id`.
- Only the removed state is tested for NO_BINARY_REMOVED (the plan's simpler case); the no-binary path clears through the same `post` branch as before.
- LATE_READY was checked against the baseline behaviour (the `ready` clear put back): it failed, and passes with the fix.

## Review Triage Log

Quick review of the id design (the first, webview-only change was reverted after its review: it could hide a working button and missed the development build's two `ready` messages; user decision 2026-10-29). Verdicts: 0 high, 0 medium, 4 low, 0 false. The reviewer confirmed the ids, the check, `ready` no longer clearing, the validation, that the webview does not keep a result across a reload (no stale id after one), and that LATE_READY fails on the baseline.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The CHANGELOG bullet is third, not first, under Unreleased | low | patch | Moved to the top (the repo's convention). |
| 2 | With nothing offered (removed, no binary), the log says "result N is not the latest" | low | patch | A separate "no result is offered" reason. |
| 3 | UNKNOWN_REQUEST gains a stale-id request and a renamed title, beyond "only the id" | low | noted | Extra coverage of the same rule (STALE_ID's), harmless; recorded here. |
| 4 | NO_BINARY_REMOVED tests only the removed state | low | patch | The no-binary half added (a missing binary, then a request with the old id is ignored). |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run test:webview` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot` and `npm run test:corpus` -- expected: pass.

**Manual checks:**
- Not reliably reproducible by hand (a hide and reveal inside one run); covered by LATE_READY.

Result (2026-10-29, after the review patches): stable 1058 passing (LATE_READY, STALE_ID, NO_ID and both NO_BINARY_REMOVED tests ran and passed; LATE_READY failed with the `ready` clear put back); multiroot 8 passing; corpus 156 passed; webview 318 passed (POSTED, WEBVIEW_SENDS_ID). Manual check: none (not reproducible by hand; LATE_READY covers it). Marked done by the user on 2026-10-29.
