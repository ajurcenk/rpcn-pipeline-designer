---
title: 'Refactor sweep'
type: 'refactor'
ticket: '10'
created: '2026-11-21'
status: 'built'
baseline_revision: '3398877b2f8270cedd10f6a7dc2490561608e363'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 7 left no review row routed to defer, but its build left copies: metrics access (`cloudMetrics.ts`) repeats log access (`cloudLogs.ts`) almost line for line (forget, the one-at-a-time set-up guard, the cluster messages); the metrics feed borrows its retry delays from the logs protocol; `metricsPanel.ts` re-exports feed constants nobody imports through it. Two `deferred-work.md` entries come from the epic: the tab's direct open (done by 7.9) and the spike's `created_by` captures (the user's decision).

**Approach:** Cleanup only, no behaviour or text change: one shared per-cluster credential helper both access classes use, each keeping its own masking and texts; the retry delays moved to a neutral shared module; the dead re-exports removed; the epic's deferred entries closed. The mapping difference recorded as a backlog bug and the spike captures redacted, per the Decisions.

## Boundaries & Constraints

**Always:**
- Each caller keeps its behaviour text for text: metrics masks a forget failure with `maskError`, logs with `ctx.mask`; prompts, picks, results (`ForgetMetricsAccessResult`, `ForgetLogAccessResult`, `MetricsAccessResult`, `LogAccessResult`) and messages unchanged.
- The differences are parameters or small caller-supplied functions of the shared helper, not flags spread through it. Metrics' `hold()` and `onDidChangeAccess`, and logs' session revoke, stay in their classes.
- Every suite passes with no test edited to pass, except import paths of moved symbols.
- `deferred-work.md`: each entry the sweep closes gets `resolution: <how> (7.10, <date>)`.
- The layering grep stays clean; `src/shared` imports no `vscode`.

**Never:** behaviour or text changes in the Cloud view, the logs, the metrics or the Run; a new dependency; editing existing ticket files (the one new backlog bug is written from the template); touching git history; merging the feed's read loops or the two `StatePanel`s; changing the mapping lookup.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FORGET_METRICS | Forget metrics access, from the row and the palette pick | as today | a failure masked with `maskError`, as today |
| FORGET_LOGS | Forget log access, row and pick | as today | masked with `ctx.mask`, as today |
| SETUP_GUARD | a second Set up of the same cluster while one runs (metrics, logs) | ignored, as today | — |
| GONE_CLUSTER | Forget/Set up on a cluster no longer in the view | "That cluster is no longer in the Cloud view…", as today | — |
| BACKOFF | Cloud metrics and logs unreachable | 5, 10, 20, 30, 60 s, then 60 s, as today | — |
| CLOSURE | `deferred-work.md` | both epic 7 entries resolved per the Decisions | — |
| REDACTED | `grep -rE '"created_by": ?"[a-z0-9]{20}@' _bmad-output` | no match | — |

## Decisions

- (user, 2026-11-21) The metrics mapping lookup (`extension.ts:314`, no `folders`/`tagOf`) is left as it is; a new backlog bug ticket records the difference from the Cloud actions' tag-aware lookup (bug 47), as 6.9 did for its flakes.
- (user, 2026-11-21) The metrics feed's local and Cloud read loops are left as they are.
- (user, 2026-11-21) `created_by`: redacted to `"<redacted>"` (the captures' existing placeholder) in the four pushed spike 6.1 capture files, and `created_by`/`updated_by` added to the redaction keys of `scripts/spike/logs-probe.mjs` and `scripts/spike/cloud-probe.mjs` (as `metrics-probe.mjs` has); git history is not touched. The deferred entry is resolved so.
- (user, 2026-11-21) The direct-open entry is resolved by 7.9 (binds on open; no re-front, its Decision).
- (user, 2026-11-21) Plan over 1600 tokens: keep the full plan.

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudMetrics.ts` -- `passwords()` L165, mask L171 (`maskCredentials(this.ctx.mask(text), this.passwords(), 1)`), `storedAccess` L195, `forgetAccess` L204-258, `setUpAccess` L260 (the one-at-a-time guard, ~17 lines), set-up offers L410.
- `src/adapters/vscode/cloudLogs.ts` -- `passwords()` L104, mask L118, `forgetLogAccess` L151-200 (catch masks with `this.ctx.mask` L195), `storedLogAccess` L219, `setUpLogAccess` L229 (guard), offers L396/L459/L513.
- `src/adapters/vscode/cloudShared.ts` -- the Cloud adapters' shared helpers (`findMapping` L110, `mappedPipeline` L289): the home for the credential helper (pick of clusters with access, forget, guard, the gone-cluster/choose-a-cluster messages).
- `src/shared/logsProtocol.ts` -- `RETRY_DELAYS_MS`, `retryDelayMs`; importers: `metricsFeed.ts:41`, `logsPanel.ts`, `adapters/logs/platformaticReader.ts`, tests `platformaticReader.test.ts`, `97-logs.ts`. Move to a neutral `src/shared/` module (e.g. `retry.ts`), keeping a re-export from `logsProtocol.ts` only if it avoids editing tests beyond imports.
- `src/adapters/vscode/metricsPanel.ts` L63-66 -- re-exports from `metricsFeed`; the only consumer through it is `98-metrics.ts` (`METRICS_INTERVAL_MS`): keep that one or point the test import at `metricsFeed`; confirm the rest with `tsc` after removal.
- `src/extension.ts` L131-135 -- the run-on doc comment of `ExtensionApi.metrics`: rewrite as one plain sentence.
- `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` L219 (`created_by`), L223 (direct open; 7.9's Decisions settled both halves: binds on open, no re-front). Unredacted `created_by` is only in the four spike 6.1 files named in the tasks (`grep -rlE '"created_by": ?"[a-z0-9]{20}@' _bmad-output`); never print the values.
- Do not touch: `findMapping` callers (`extension.ts:314`, `cloudActions.ts:156/307/622`, `cloudDeploy.ts:229`) -- they differ in behaviour (no `folders`/`tagOf` for metrics) unless a Decision says so; the two `StatePanel`s (they differ in wording and layout); `metricsFeed.ts` read loops unless a Decision says so.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/vscode/cloudShared.ts`, `cloudMetrics.ts`, `cloudLogs.ts` -- the shared credential helper; both classes call it -- removes ~80-100 duplicated lines.
- [x] `src/shared/<retry module>.ts` + importers -- move `RETRY_DELAYS_MS` / `retryDelayMs` -- metrics no longer depends on the logs protocol.
- [x] `src/adapters/vscode/metricsPanel.ts` -- remove the dead re-exports.
- [x] `src/extension.ts` -- the doc comment.
- [x] `_bmad-output/backlog/bug-<slug>.md` -- new bug from `.claude/skills/bmad-ticket/assets/bug-template.md` (next free backlog id; format as `bug-ci-timing-flakes-in-the-integration-suites-epic-6-findings.md`, id 41): "Metrics ignores a shared sidecar's owner tag" -- the lookup difference, `extension.ts:314` vs `cloudActions.ts:156`, P3.
- [x] `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/spike-6-1-findings/captures{,-run-1}/{04-pipeline-create,31-pipeline-wait-running-final}.json` -- `created_by` (and `updated_by` if unredacted) → `"<redacted>"`; `scripts/spike/logs-probe.mjs` L98, `scripts/spike/cloud-probe.mjs` L75 -- add `created_by|updated_by` to `SECRET_KEY`.
- [x] `deferred-work.md` -- resolutions.

**Acceptance Criteria:**
- Given the full verification, when it runs after the sweep, then every suite passes and no test changed beyond import paths.
- Given `cloudMetrics.ts` and `cloudLogs.ts`, when read, then forget and the set-up guard exist once, in the shared helper.

## Implementation Notes

- Shared helper in `cloudShared.ts`: `rowCluster` (the choose-a-cluster / gone-cluster messages, `CHOOSE_A_CLUSTER`, `CLUSTER_GONE`), `SetUpGuard` (the one-at-a-time Set up per cluster; metrics passes a callback that fires `settingUpChanged`, logs none) and `forgetAccess(ctx, node, how)` (the row/palette flow; `ForgetHow` carries `what`, `userOf`, `key`, `remove`, `noneSet`, `forgotten`, `mask`: metrics `maskError`, logs `ctx.mask`). `hold()`, `onDidChangeAccess` and the logs' revoke stay in their classes (inside `removeAccess` / `removeLogAccess`, passed as `remove`). The guard's log and change callbacks are lazy arrows, so field order does not depend on parameter-property assignment.
- Retry waits moved to `src/shared/retry.ts`; `metricsFeed.ts` and `logsPanel.ts` import it; `logsProtocol.ts` re-exports both (as it already re-exports from `logsText.ts`) so `97-logs.ts` and `LogsView.test.tsx` stay unedited. `platformaticReader.ts` never imported them (its `retryDelayMs` is its own option).
- `metricsPanel.ts`: removed the dead re-exports (`CLOUD_METRICS_INTERVAL_MS`, `CLOUD_MIN_GAP_MS`, `CloudMetricsBinding`, `MetricsConfig`, `MetricsRun`, `MetricsSourceFactory`); kept `METRICS_INTERVAL_MS` (98-metrics) and `NO_SERIES_READS`, `QUIET_FAILURES` (`metricsPanel.test.ts` imports them through it, which the Code Map missed), so no test import changed.
- Backlog bug 57 (next free id): `_bmad-output/backlog/bug-metrics-ignores-a-shared-sidecars-owner-tag.md`.
- Redaction: only `created_by` was unredacted in the four files (one per file); no `updated_by` there.
- Verification (2026-11-21): compile clean; webview 421, corpus 182 passed; stable 1718 passing, 1 pending, 1 failing (Environment view "ticket 39 VALUE_DEFAULT … its record goes too", the known flake of bug 41 item 2), and that suite alone then passed 34 of 34; multiroot 15 passing; the layering grep is empty; `git diff --stat 3398877 -- src/test webview/src` is empty (no test edited).

## Plan Change Log

## Review Triage Log

Pass 1 (quick lens, 2026-11-21): 5 findings — high 0, medium 0, low 5, false 0, maybe-false 0. 4 patched, 1 rejected. The reviewer confirmed the behaviour is unchanged (forget, guard, masking, firing order).

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `cloudShared.ts` header says "no state", but `SetUpGuard` holds state | low | patch | Header L1-4 vs the class. Reworded. |
| 2 | `logsProtocol.ts` value re-export of `retry.ts` breaks AD-15 (shared modules import each other type-only) and its header | low | patch | AD-15 rule, architecture L149. Patch: re-export removed, importers pointed at `retry.ts` (import paths only). |
| 3 | `ExtensionApi.metrics` doc comment still a run-on list | low | patch | `extension.ts` L130-134. Rewritten as one short sentence. |
| 4 | `SetUpGuard` doc omits that a call with no cluster-row node is neither guarded nor notified | low | patch | `guard` runs `run()` directly when `node` is not a cluster (as before). Comment amended. |
| 5 | The plan's "removes ~80-100 lines" overstates the saving (net +17) | low | reject | The fix would edit this build's plan; the criterion (forget and the guard exist once) is met. |

The four patches applied by the implementer (#5 rejected); the retry waits' two test importers now import `retry.ts` (import lines only). Verified after them: `npm run compile`, `test:webview` 421, `test:corpus` 182, stable 1719 passing / 1 pending / 0 failing, multiroot 15 passing; no `vscode` import in `src/core`, `src/shared`, `src/adapters/metrics`; `git diff 3398877 -- src/test webview/src` shows import lines only; no unredacted `created_by` in `_bmad-output`.

## Verification

**Commands:**
- `npm run compile` -- expected: no errors.
- `npm run test:webview` and `npm run test:corpus` -- expected: all pass (421, 182).
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` -- expected: all pass; then `--label multiroot`.
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no matches.
- `git diff --stat <baseline> -- src/test webview/src/*.test.tsx` -- expected: import lines only.


## Manual Check

- 2026-11-21, the user, in the dev host (VS Code 1.143.1 from `.vscode-test`, extension at `15c4b2b`, restarted on the build) on Forget and Set up of the metrics and log access in the Cloud view: "tested, no issues".
