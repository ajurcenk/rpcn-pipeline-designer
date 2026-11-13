---
title: 'Code health for the Cloud adapter (story 50 group A)'
type: 'refactor'
ticket: '50'
created: '2026-11-12'
status: 'built'
baseline_revision: '77047dd6ae2a23525500b47e6a25c5f311d1e0d6'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The epic 5 retrospective (A2, A3, A4, A6) found the Cloud adapter solving things twice: two poll loops with one skeleton and the "still … after N s" text built three times; the offset-to-line helper written three times and `LITERAL_ARG` copying `ENV_CALL`; the mapping-to-target resolution written twice with near-identical text; presentation helpers inside the Data Plane HTTP adapter.

**Approach:** Refactor criteria 1–4 of story 50 (group A) so each is written once, with behavior, messages, log lines and requests unchanged.

**Decision (user, 2026-11-12):** story 50 split into three groups; group A (criteria 1–4, the Cloud adapter) built first; groups B (criteria 5–6) and C (criteria 7–9) deferred to deferred-work. Criterion 10 (behavior unchanged; all suites pass; no existing integration or corpus test changed to make them pass) applies to this group. No floor (VS Code 1.100.0) runs (user).

**Decision (user, 2026-11-12, the recommended option):** criterion 3's "messages written once" means one resolver and one place that builds the gone messages, with each caller's exact current wording kept as a variant; no message changes.

## Boundaries & Constraints

**Always:** Every command, message, log line, setting, tag, mapping format and Cloud request byte-identical; the order and count of requests in a poll unchanged (tests count them); AD-15: `src/core` imports nothing from `src/adapters` or `vscode` (eslint `no-restricted-imports`); secret values stay out of logs and messages (bug 44).

**Never:** Changing an existing integration or corpus test's assertions; re-exporting moved helpers from `dataPlane.ts` (that keeps them in the HTTP adapter); merging the two polls' timing (deadline before vs after the GET) or their 404 meaning; groups B and C.

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudDeploy.ts` -- `follow` :837-889 (deadline :844 checked before the sleep :860; grace `restartGraceMs` :856; unknown state :850 and `FINAL_STATES` :853 end it; 404 or `MAX_POLL_FAILURES` → failed "could not read its state: …" :879-881); Deploy's timeout text `report()` :913-918; `mappedTarget` :721-748 (detailsUnread :723-726, cluster gone :730-736) and `goneTarget` :751-767; `rangeOf` :953 uses `lineOf`.
- `src/adapters/vscode/cloudActions.ts` -- `startOrStop` :235 already reuses `ctx.follow` (:270); its timeout text :285-288 (`ACTION_TEXT[action].ongoing`); Delete wait in `deleteTarget` :358-381 (GET first, 404 = deleted :368, deadline after the GET :376, cap message "it was deleted, but its state could not be read: …" :373; timeout text :406-407); `paletteTarget` :140-215, mapping part :166-190 (no log line, no detailsUnread; texts :173, :186; `how.pickAfterGone`); used by `actionTarget` :86 and `cloudLogs.ts:477` `logsTarget`.
- `src/adapters/vscode/cloudShared.ts` -- `MAX_POLL_FAILURES` :24, `sleep` :27, `pipelineStateDescription` :29, `stateWord` :168; home for the shared poll and the shared mapping resolver.
- `src/core/cloudCheck.ts:185` `lineOf` (exported); `src/core/bloblangNames.ts:38` identical private copy; `src/core/cloudTranslate.ts:94` `lineCounter` (incremental); `LITERAL_ARG` :46 vs `src/core/envUsage.ts:17` `ENV_CALL` (cloudTranslate already imports envUsage).
- `src/adapters/cloud/dataPlane.ts` -- presentation: `resourcesText` :42, `isRunning` :103, `stateKey` :122, `canStart` :127, `canStop` :132, `pipelineStateText` :137, `SizeChoice`/`sizeChoices` :332-355. Importers: cloudShared.ts:7, cloudActions.ts:11, cloudDeploy.ts, cloudView.ts:116.
- Tests pinning texts: `src/test/integration/suites/96-cloud.ts` :534 (still starting), :832 (grace), :1614, :1662, :1735 (delete 404), :2640, :2688, :892-911 (mapped gone), :1798-1831 (palette), `97-logs.ts:2801`; unit `src/test/core/{cloudCheck,bloblangNames,cloudTranslate,envUsage}.test.ts`, `src/test/adapters/cloud/{errors,lifecycle,update}.test.ts`. No test covers the delete-timeout text.

## Tasks & Acceptance

**Execution:**
- [x] `src/test/integration/suites/96-cloud.ts` -- first, add DELETE_TIMEOUT: a delete whose pipeline stays listed past `timeoutMs` shows the "is being deleted … until it is gone." info and the "still listed N s after its delete." log -- pins the one untested text before the refactor.
- [x] `src/adapters/vscode/cloudShared.ts` -- add one poll helper (deadline, sleep, GET, failure cap, 404) parameterized by: what a read means (done or continue), what a 404 means, where the deadline check sits, the progress and failure texts; and one `stillText`/seconds builder for the "still … after N s" log and info pairs -- criterion 1.
- [x] `src/adapters/vscode/cloudDeploy.ts`, `cloudActions.ts` -- `follow` and the Delete wait use the helper; Deploy's, Start/Stop's and Delete's timeout texts come from the one builder -- criterion 1.
- [x] `src/core/textLines.ts` (new) -- `lineOf` and `lineCounter`; `cloudCheck.ts`, `bloblangNames.ts`, `cloudTranslate.ts` import them (keep `lineOf` exported from cloudCheck only if callers need it; prefer updating imports) -- criterion 2.
- [x] `src/core/envUsage.ts`, `cloudTranslate.ts` -- export the `env(` + quoted-name source once; `ENV_CALL` and `LITERAL_ARG` are built from it with their own flags and tails -- criterion 2.
- [x] `src/adapters/vscode/cloudShared.ts`, `cloudDeploy.ts`, `cloudActions.ts` -- one mapping resolver (cluster by id, data plane address, pipeline read, 404 → removed) returning cluster-gone / pipeline-gone / failed / found; the gone messages built in one place with each caller's exact current wording -- criterion 3.
- [x] `src/adapters/cloud/pipelineText.ts` (new, no vscode import) -- move the presentation helpers listed in the Code Map; update every importer and the unit tests' imports; `dataPlane.ts` keeps requests, their types and the state constants -- criterion 4.
- [x] Unit tests -- a test for the poll helper (deadline, cap, 404 both ways) and for the mapping resolver's outcomes, where a fake `call` allows it; move or add `lineOf`/`lineCounter` tests to `src/test/core/textLines.test.ts`.

**Acceptance Criteria:**
- Given the code after this change, when the Cloud adapter is read, then criteria 1–4 hold as the ticket states them.
- Given compile with lint, corpus, webview, stable and multi-root runs, when they run, then all pass and no existing integration or corpus test assertion changed.

## Implementation Notes

- Poll: `pollPipeline` (cloudShared) does the deadline, the progress and wait, the GET, the failure cap and the 404; `PollHow` gives `deadline: 'beforeRead' | 'afterRead'`, `done` (checked at each round's start: Deploy's unknown-state, final-state and grace rules), `read`, `progress`, `notFound: 'failed' | end` (Deploy: a logged failure; Delete: `deleted`, not logged), `failed`, `timedOut`. `stillText` builds the three timeout log/info pairs. Deploy's GET uses the followed pipeline's id (`first.id`) where it used `current.id` (the id the answer carried, the same pipeline).
- Mapping: `mappedPipeline` returns found / clusterGone (`named`) / pipelineGone (removed from the cache) / failed; `mappingGoneText` builds both gone texts with each caller's ending (Deploy: "Nothing was sent." / "Create a new pipeline on another cluster?" / `nothingSent` / "Create a new pipeline?"; palette: `pickAfterGone`). Deploy keeps its detailsUnread check and its own log lines before and around it.
- Lines: `src/core/textLines.ts` (`lineOf`, `lineCounter`); `cloudCheck` no longer exports `lineOf` (cloudDeploy and cloudCheck.test import textLines). `ENV_LITERAL_CALL` (envUsage) is the shared source; `ENV_CALL` and `LITERAL_ARG` are built from it (sources and flags checked equal to the old literals).
- Presentation: `src/adapters/cloud/pipelineText.ts`; `dataPlane.ts` keeps requests, types, `resourcesOf`/`unitsOf`/`sameResources`, `MIN_UNITS`/`MAX_UNITS` and the state constants.
- Tests: DELETE_TIMEOUT in 96-cloud.ts (a 200 `{}` DELETE via `fake.failures`, so the pipeline stays listed); `src/test/adapters/cloud/poll.test.ts`, `src/test/core/textLines.test.ts`.

## Plan Change Log

## Review Triage Log

Thorough review (2026-11-12; blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Verdicts: 0 high, 1 medium, 15 low (7 patched, 8 rejected), 2 false; intent-alignment descriptive. Routes: 8 patch, 0 defer, 0 bad_plan, 0 intent_gap.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 1 | VG | Delete's capped-failure ending ("it was deleted, but its state could not be read", `sent: true`) run by no test | medium | patch | Only the Stop unreadable test (96-cloud :1662) hits a cap, through follow; add DELETE_UNREADABLE. |
| 2 | EC, IA | Follow GETs `first.id`; the old loop GET'd `current.id` | low | patch | A request could differ if a read answered another id; boundary says requests unchanged. `id` as a function, `() => current.id`. |
| 3 | BH | `MappedPipeline` clusterGone's `cluster` never read | low | patch | Deletion. |
| 4 | BH | paletteTarget appends its ending two ways | low | patch | Direct correction: `then(mappingGoneText(…))`; text unchanged. |
| 5 | BH | DELETE_TIMEOUT does not count the wait's GETs | low | patch | The test added to pin the delete wait leaves its timing unpinned; assert the GET count. |
| 6 | BH | Poll unit tests miss the cap under `beforeRead`, the raw error passed to `failed`, `done` with `afterRead` | low | patch | Deploy's `onFailure` depends on the raw error; added cases. |
| 7 | BH | Nothing pins the rebuilt `ENV_CALL`/`LITERAL_ARG` to the old literals | low | patch | Source/flags assertion for `ENV_CALL`; LITERAL_ARG through behavior. |
| 8 | BH | `lineCounter` past-the-end offset untested | low | patch | One test case. |
| 9 | EC | `lineCounter` gives a stale line for a decreasing offset, now a shared export | low | reject | Its doc requires increasing offsets and its one caller walks forward; the fix adds a guard branch. |
| 10 | BH | `mappedTarget` looks the cluster up twice | low | reject | `clusterById` is a synchronous cache read with no await between the two calls, so they cannot differ; the fix adds a parameter. |
| 11 | BH | The gone message's name chosen in two places | low | reject | No caller diverges: both names come from the mapping and cluster as before; cosmetic. |
| 12 | BH | `stillText` discriminates with `'still' in what` | low | reject | Cosmetic; both callers typed. |
| 13 | BH | `PollHow.done` cannot end with `undefined` when `T` includes it | low | reject | No caller's `T` includes `undefined`; the fix adds a constraint or wrapper for no present case. |
| 14 | BH | `ENV_LITERAL_CALL`'s numbered backreference breaks after a capturing group | low | reject | Both users put it first; hypothetical future pattern. |
| 15 | BH | DELETE_TIMEOUT does not cover the `also` suffix | low | reject | `stillText`'s unit test pins the suffix; the caller passes `also` unchanged from before. |
| 16 | IA | Deploy, Start, Stop "still … after N s" log lines unasserted in integration | low | reject | Pre-existing gap; `stillText`'s unit test now pins both lines. |
| 17 | BH | `pipelineText.ts` imports pure helpers back from `dataPlane.ts` | false | reject | Presentation depending on the API module is the intended direction; criterion 4 is that the HTTP adapter holds no presentation, which holds. |
| 18 | IA | `cloudLogs.lastDeployOf` has the resolver's shape but is left alone | false | reject | It resolves a view node's pipeline, not a mapping; criterion 3 names Deploy and the Cloud view's actions. |

Intent-alignment notes (descriptive): criterion 1 read as one helper with each caller's own timing and Delete's "still listed" text in the same builder; criterion 2 as one module with two line functions and both env patterns from one shared fragment; criterion 3 as one resolver and one text builder, log lines and Deploy's detailsUnread check at the callers; criterion 4 as the state text, the state rules and the size choices moved, the API's state constants and unit conversions kept (the plan's Design Notes).

## Design Notes

`isRunning`, `stateKey`, `canStart`, `canStop` are UI rules over a state (what to offer, the view's context value), so they move with `pipelineStateText`; `isKnownState`, `KNOWN_STATES` and `FINAL_STATES` describe the API and stay. The two polls keep their own timing: Deploy reads after a sleep and checks the deadline first; Delete reads first and checks the deadline after the read, and tests count requests in both.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (lint included)
- `npm run test:corpus`, `npm run test:webview` -- expected: pass
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: 0 failing
- same with `--label multiroot` -- expected: 0 failing
- `git diff 77047dd -- src/test/integration src/test/integration-multiroot test/` -- expected: only the added DELETE_TIMEOUT test

**Manual checks (if no CLI):**
- None: no behavior change.

**Result (2026-11-12, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 381, multi-root 15 passing. Stable: the first run took 2 h of wall-clock time and failed one hook, the "before each" of Pipeline logs REFUSED (bug 52), on a 60 s timeout right after "No ptyHost heartbeat after 6 seconds" (the machine paused; the suite is not touched by this change); rerun: 1492 passing, 1 pending, 0 failing (11 min). The test settings clean; the integration tests changed only by the two added tests (DELETE_TIMEOUT, DELETE_UNREADABLE, +48 lines); no floor run.
