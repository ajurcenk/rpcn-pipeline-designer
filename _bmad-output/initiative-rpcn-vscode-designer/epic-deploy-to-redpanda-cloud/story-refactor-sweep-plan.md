---
title: 'Refactor sweep'
type: 'refactor'
ticket: '9'
created: '2026-11-09'
status: 'in-review'
baseline_revision: '3e36882538c000794e166e9c191b8b8cfe50c09a'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud.md
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - src/adapters/vscode/cloudView.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epics 5 and 6 grew `src/adapters/vscode/cloudView.ts` to about 2,900 lines: the Cloud view, the deploy flow, the pipeline actions and the log access all in one class, so each change reads and risks the whole file. Epic 5 also left three deferred entries open: the undo flakes, and 5.6's two split parts.

**Approach:** Cleanup only: split `cloudView.ts` into four modules with the same behaviour, the view keeping its public surface; move the undo flakes to backlog bug 41 and 5.6's two parts to two backlog stories; close the epic's deferred entries.

**Decisions (user, 2026-11-09, the recommended options):**
- Split four ways: the view (account, Connect/Disconnect, the clusters and pipelines cache, the tree), the deploy flow, the pipeline actions, the log access and log entry points.
- The undo flakes (Lint on save FIX_ALL; the test panel's DELETED + UNDO, UNDO_RELINK, DIRTY_RECORD) join backlog bug 41.
- Resource files in a deploy and warnings for local-only parts become two backlog stories (`bmad-ticket`, by the orchestrator).

## Boundaries & Constraints

**Always:**
- No behaviour or text change: every command, message, prompt, mask, request and its order as today.
- `CloudView` stays the one class `extension.ts` builds and registers, with the same public methods and test seams; `cloudView.ts` keeps exporting every name it exports today (re-exported from the new modules where they move), so `extension.ts`, `96-cloud.ts` and `97-logs.ts` are not edited.
- The new modules reach the shared state (the account, the clusters and pipelines cache, `ui`, `mask`, `log`, the messages, `fire`) through one small context interface the view implements, not through each other; no module imports another's internals; no import cycle.
- Code moves as written; changes only where moving needs them (the context's calls instead of `this.`).
- Every suite passes with no test file changed.
- `deferred-work.md`: the undo-flakes entry gets `resolution: moved to backlog bug 41 …`; the two 5.6 entries get `resolution: moved to backlog story <id> "<title>"` (the ids and titles given by the orchestrator).
- AD-23 or AD-24 amended only if they name `cloudView.ts`'s layout.

**Never:**
- Behaviour changes, new features (resource files, local-only warnings), fixes to the flakes, a new dependency, editing test files or ticket files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SUITES | the full runs | all pass, no test file changed | none |
| SURFACE | `cloudView.ts`'s exports | the same names as at the baseline | none |
| NO_CYCLE | the four modules | no import cycle; only the view builds the others | none |
| CLOSURE | deferred-work.md | the three entries resolved | none |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudView.ts` (2,911 lines), by method (line numbers at the baseline):
  - The view, stays: constants and types ~123–503, `CloudView` constructor/`register` ~568–635, account and secrets ~636–886 (`connect`, `disconnect`, `readAccount`, `call`), the cache ~887–1035 (`loadClusters`, `loadPipelines`, `upsertPipeline`, `removePipeline`, `clusterById`, `dataplaneUrlOf`), the tree ~1036–1219 (`getChildren`, `getTreeItem`, `buildItem`, `localFileOf`, `items`), `provideTextDocumentContent` ~1220.
  - Deploy flow → new `src/adapters/vscode/cloudDeploy.ts`: `showDiff` ~1225, `deploy`/`deployFile` ~1240–1427, `checkBeforeSending` ~1428, `maskValue`, the secrets questions ~1504–1622, `pickTarget`/`askName`/`newTarget`/`mappedTarget`/`writeMapping` ~1623–1802, `sendFailed`, `report` (following the state) ~1803–1905.
  - Pipeline actions → new `src/adapters/vscode/cloudActions.ts`: `pipelineAction`, `actionTarget`, `connectedFirst`, `activeConfig`, `paletteTarget`, `offered`, `startOrStop`, `mappingsOf`, `deleteTarget`, `deleteMappings`, `rowAction`, `readNow`, `setDeployed`, `openDeployed`, `localFileFor`, `compare`, `deployAgain` ~1906–2430.
  - Log access → new `src/adapters/vscode/cloudLogs.ts`: `readLogAccess`, `removeLogAccess`, `storedValue`, `logsNotSupported`, `storedLogAccess`, `setUpLogAccess`(`Now`), `showLogs`, `showLogsAroundError`, `openLogs`, `logSource`, `logsTarget`, `showErrorWithLogs` ~2431–end.
  - Shared by several: `connectedFirst`, `activeConfig` and `paletteTarget` are used by actions and logs (6.9): keep them in one place both reach (the actions module exporting them, or the context), not copied. `showErrorWithLogs` is called from the deploy flow and start: the deploy and actions modules reach it through the context.
- Importers (must not change): `src/extension.ts`, `src/test/integration/suites/96-cloud.ts`, `97-logs.ts`.
- `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` -- the undo-flakes entry (~:120) and the two 5.6 entries (~:114, ~:117).
- `CHANGELOG.md` -- none (no user-visible change).

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/vscode/cloudDeploy.ts`, `cloudActions.ts`, `cloudLogs.ts` and the context in `cloudView.ts` -- the split, the public surface kept.
- [x] `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` -- the three resolution lines.

**Acceptance Criteria:**
- Given the change, when compile (with lint), unit, webview, stable, multi-root and corpus runs execute (vscode-test under `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`, each capped with `timeout`), then all pass and `git diff --stat <baseline> -- src/test webview/src src/extension.ts` is empty.
- Given the split, when `cloudView.ts` is read, then it holds the view, the account, the cache and the tree, and each moved method is in exactly one module.

## Implementation Notes

- Recorded by the orchestrator from the implementer's report (2026-11-09): `cloudView.ts` 1,308 lines (the view, the account, the cache with `readPipeline`, the tree, the `CloudContext` interface and its builder `context()`, the public methods as one-line delegations, every baseline export re-exported); `cloudDeploy.ts` (`CloudDeploy`: the deploy, the check, the secrets questions, the target and mapping, create/update, `follow`, `report`); `cloudActions.ts` (`CloudActions`: Start, Stop, Delete, the row actions, `connectedFirst`, `activeConfig`, `paletteTarget`); `cloudLogs.ts` (`CloudLogs`: the log access state and flows, `logsTarget`, `showErrorWithLogs`, `lastDeployOf`). Code moved by script; only `this.` → `this.ctx.` changed. Test seams are read live through the context's getters. `readPipeline` stays in the view (a cache call all three modules use). The resolution lines name bug 41 and stories 42 and 43.

## Plan Change Log

## Review Triage Log

Quick review (2026-11-09): 0 high, 0 medium, 2 low patched, 2 low rejected, 3 false.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | The feature modules import each other (actions and logs from deploy, logs from actions) for helpers private at the baseline; `CloudContext.follow` is typed from `CloudDeploy` | low | `cloudActions.ts:15-18`, `cloudLogs.ts:13-14`, `cloudView.ts` ~:400; against "not through each other" | patch (the shared pure helpers to one stateless module; `follow`'s parameters written out) |
| 2 | `CloudContext` (~47 members) is not "one small context interface" | low | its members are the categories the plan lists (account, cache, `ui`, `mask`, `log`, messages, `fire`), the test seams read live, and the cross-module calls the Code Map routes through the context; narrowing it means a context per module, more interfaces for no behaviour gain | reject |
| 3 | `readPipeline` stays in the view, and several moved helpers are not named in the Code Map or recorded | low | `readPipeline` is a cache call used by all three modules; the fix is a plan edit | reject (a plan edit; recorded under Implementation Notes by the orchestrator) |
| 4 | Bug 41's file edited against "editing ticket files"; its text incomplete for the new item | false (the edit) / low (its text) | the orchestrator edited it, not the implementer; References, Cause Hypothesis and Notes did not cover item 5 | the text completed by the orchestrator |
| 5 | The two new backlog story files are in the diff | false | the orchestrator created them with `bmad-ticket` | reject |
| 6 | No verification results recorded | false | the orchestrator runs and records the full verification after the patches | reject |

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass; the test-file diff above empty. No floor run.

**Result (2026-11-09, after the review's patches, run by the orchestrator):** compile (lint included), corpus 156, webview 378, stable 1358 passing (1 pending), multi-root 10; `git diff --stat 3e36882 -- src/test webview/src src/extension.ts` empty; no floor run. After review: the shared constants and pure helpers moved, unchanged, to a stateless `cloudShared.ts` that the view and the three modules import, so no feature module imports another; `CloudContext.follow` lists its parameters.

**Manual checks:**
- Optional: on the dev host, Connect, Deploy, Start/Stop and Show logs once each (no user-visible change is expected).
