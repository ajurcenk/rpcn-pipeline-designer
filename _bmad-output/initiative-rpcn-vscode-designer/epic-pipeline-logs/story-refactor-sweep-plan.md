---
title: 'Refactor sweep'
type: 'refactor'
ticket: '9'
created: '2026-11-09'
status: 'done'
baseline_revision: 'da09628495f74f5543df9508fb7a8e2a782e2db3'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-open-the-log-from-the-command-the-row-menu-and-an-error-plan.md
  - src/adapters/vscode/cloudView.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 6 left one deferred code finding: the Cloud view's two palette target paths, `actionTarget()` (5.4: Start, Stop, Delete from the palette) and `logsTarget()` (6.5: Show pipeline logs), are two copies of the same work (the connect check, the active config's `.cloud.json`, every cluster's pipelines, the pick) that already differ. It also left four CI flakes in other epics' code, noted in `deferred-work.md` during epic 6.

**Approach:** Cleanup only: one shared target path in `cloudView.ts` that both callers use, each keeping exactly its current behaviour; the four flakes moved to the backlog; the epic's deferred entries closed.

**Decisions (user, 2026-11-09, the recommended options):**
- Merge `actionTarget()` and `logsTarget()` here.
- The four flakes (graph markers HELD, Environment view ticket 39 VALUE_DEFAULT, the Bloblang diagnostics 4.5 stall, the test panel's RENAME 4.17) move to one new backlog bug ticket for CI timing flakes, beside the existing bug 21; not fixed here.
- The strip's fewer-than-30 bars on some custom ranges is dropped (the presets give 42–60).
- Ticket 6.7's stale description ("a bar per hour") is fixed with `bmad-ticket` after the sweep, not by this build.

## Boundaries & Constraints

**Always:**
- Each caller keeps its behaviour, text for text: actions stop with their message when the mapped cluster or pipeline is gone, go to the pick on an unreadable `.cloud.json` without a message, return `{ kind: 'failed' }` on another read error, and keep their unsorted pick with "<cluster> · <state>"; logs fall through to the pick with their "Choose the pipeline whose logs to show." messages (gone, cluster gone, unreadable mapping logged and said), return nothing on another read error, and keep their pick sorted by cluster then name with the local file and "no log access set". The row (node) path of `actionTarget` stays as it is.
- The differences are parameters or small caller-supplied functions of the shared path, not flags spread through it; masking as today.
- Every suite passes unchanged: no test is edited to pass (a pure refactor needs no new tests).
- `deferred-work.md`: the merge entry gets `resolution: fixed by 6.9 …`; the four flake entries get `resolution: moved to backlog bug <N> "<title>" (6.9, user decision 2026-11-09)`.

**Never:**
- Behaviour or text changes in the Cloud view, the logs or the deploy; work on the flakes' code; the strip; a new dependency; editing ticket files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ACTION_MAPPED | Start from the palette, the config mapped | that pipeline, as today | none |
| ACTION_GONE | the mapped pipeline 404 | "Pipeline … is no longer on …", nothing started | as today |
| ACTION_PICK | no mapping | the unsorted pick, "<cluster> · <state>" | as today |
| LOGS_GONE | Show pipeline logs, the mapped pipeline 404 | the message, then the sorted pick | as today |
| LOGS_BAD | an unreadable `.cloud.json` | logged and said, then the pick | as today |
| NOT_CONNECTED | no account | Connect offered by both | as today |
| CLOSURE | deferred-work.md | five entries resolved | none |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudView.ts` -- `actionTarget(action, node)` (~:1902–1975), called at ~:1882; `logsTarget()` (~:2649–2718), called at ~:2535. Shared: `this.ready`, the account check with `CONNECT_ACTION`/`this.connect()`, `this.requested = true`, `loadClusters(false)` and its error message, the active detected file config, `readMapping(sidecarPath(...))`, `clusterById`/`dataplaneUrlOf`, `readPipeline`, `removePipeline` on 404, the clusters with a Data Plane, `loadPipelines(c.id, true)` for each, `this.fire()`, `unread` and the "No pipeline on the clusters to …" message, `this.ui.pickPipeline`. Note the order differs: `actionTarget` reads the config before `loadClusters`, `logsTarget` after; both read it before using it, so one order is fine if no test sees the difference (keep the node path's early return before `loadClusters`).
- Tests that pin the behaviour (must pass unedited): `src/test/integration/suites/96-cloud*.ts` (palette Start/Stop/Delete, the mapping, gone) and `97-logs.ts` (Show pipeline logs from the palette: mapped, gone, bad mapping, the sorted pick).
- `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` -- the entries at ~:126 (the merge), ~:123 (HELD), ~:129 (VALUE_DEFAULT), ~:132 (4.5 stall), ~:135 (RENAME 4.17).
- `CHANGELOG.md` -- none (no user-visible change).

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/vscode/cloudView.ts` -- one private palette-target method used by `actionTarget` (palette path) and `logsTarget`, the differences passed in.
- [x] `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` -- the resolution lines (the backlog bug's number and title are given by the orchestrator, who creates the ticket with `bmad-ticket`; leave `<N>` if not given).

**Acceptance Criteria:**
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute (vscode-test under `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`, each capped with `timeout`), then all pass with no test file changed.
- Given `cloudView.ts` after the change, when the two palette paths are read, then the connect check, the mapping read, the pipelines' load and the pick are written once.

## Implementation Notes

- `cloudView.ts`: `connectedFirst()` (ready + Connect offered), `activeConfig()` (the active detected file config) and `paletteTarget(config, how)` (clusters loaded, the mapping read, the pipelines loaded, the pick), written once; `actionTarget()` keeps its row path (and its early return before `loadClusters`) and maps `paletteTarget`'s `{ kind: 'target' | 'none' | 'failed' }` to `ActionTarget` / `NOT_STARTED` / `{ kind: 'failed' }` (a picked cluster without a Data Plane: `NOT_STARTED`, as before); `logsTarget()` maps it to its target or `undefined`. The differences are `PaletteTargetHow`: `pickAfterGone` (the sentence said after a gone or unreadable mapping before the pick; absent: gone stops, unreadable goes to the pick unsaid), `byName` (the sorted pick; `byName()` is now a module function), `nothingTo`, `title`, `describe` (masked by the shared path).
- After review (2026-11-09): `paletteTarget(configOf, how)` takes the config as a getter it calls after `loadClusters`, so each caller reads the active editor when it did before (actions before, for their row path; logs after the clusters load). No order change remains.
- `deferred-work.md`: the merge entry `fixed by 6.9`; the four flakes `moved to backlog bug 41 "CI timing flakes in the integration suites (epic 6 findings)"`.

## Plan Change Log

## Review Triage Log

Quick review (2026-11-09): 0 high, 0 medium, 2 low patched, 1 low rejected.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | `pickAfterGone` (checked in four places) and `byName` (twice) act as flags inside `paletteTarget`, against "parameters or small caller-supplied functions, not flags spread through it" | low | each option is read only in the block it governs (the mapping block; the pick's order); the alternative is a caller-supplied handler returning control flow, more code for no user-visible gain | reject (low; the fix adds complexity no one meets in use) |
| 2 | Show pipeline logs reads the active editor before `loadClusters` instead of after: a behaviour change while the clusters load | low | `logsTarget` passes `this.activeConfig()` evaluated before `paletteTarget` awaits `loadClusters(false)`; the frozen Never forbids behaviour changes in the logs | patch (a config getter called after the load) |
| 3 | The inline comment on `then` says a mapping without `pickAfterGone` stops there; an unreadable one falls through unsaid | low | `paletteTarget`'s `bad` branch | patch |

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass; `git diff --stat <baseline> -- src/test webview/src/**/*.test.tsx` empty. No floor run.

**Result (2026-11-09, after the review's patches, run by the orchestrator):** compile, corpus 156, webview 378, stable 1358 passing (1 pending), multi-root 10; `git diff --stat da09628 -- src/test webview/src` empty; no floor run.

**Manual checks:**
- None needed beyond the suites (no user-visible change); optionally Show pipeline logs and Start pipeline from the palette on the dev host.
