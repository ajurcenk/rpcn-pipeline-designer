---
title: "Bug 58: Show Pipeline Metrics' Cloud step binds nothing, or the wrong source"
type: 'bugfix'
ticket: '58'
created: '2026-11-21'
status: 'built'
baseline_revision: '55e6693da478274861f996c1521e88963ef0bbaf'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** For a config that is mapped to a Cloud pipeline and not running, the Pipeline Metrics tab goes through Show metrics. Three things go wrong there: (a) a Show metrics that does not start leaves the tab unbound or stale; (b) Show metrics calls an existing pipeline gone until the Cloud view's account node has been expanded; (c) the tab's bind on opening can overwrite a choice the user made meanwhile, and after one failure it never retries.

**Approach:** The panel acts on Show metrics' result and falls through to the file's Not running state when it did not start. Show metrics loads the cluster list itself when it is not held, the way the palette target does. The bind on opening drops its Cloud bind when the user chose a source meanwhile, and can retry after the Cloud state changes.

## Boundaries & Constraints

**Always:** The resolver order from 7.9 stays the same: a file uri, then the active config, then running, then mapped Cloud, then the file as Not running. Show metrics' own messages are kept as they are. Every fix gets a test that runs the real Show metrics command (integration suite `99b`), and the unit tests make the fake `executeCommand` return a real `ShowMetricsResult`. Keep the layering: no `vscode` import in `src/core`, `src/shared` or `src/adapters/metrics`.

**Never:** No change to Show logs (its row-node gap is out of scope). No new tree events or Cloud view UI. Messages must not repeat on every reveal of the tab. Don't change bug 57's mapping lookup (`mappingOf`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MAPPED_STARTS | Mapped, not running, signed in, clusters held | The tab shows the Cloud pipeline (as now) | — |
| MAPPED_NOT_STARTED | Mapped, not running; Show metrics returns `notStarted` (not signed in, pipeline gone, no Prometheus endpoint, pick cancelled) | Show metrics' message, then the tab shows the file as Not running with Run | Message from Show metrics only |
| MAPPED_NO_ACCESS | Mapped; Show metrics returns `noAccess` | The tab stays bound to the Cloud pipeline (its no-access state) | — |
| CLUSTERS_NOT_LOADED | Signed in, cluster list never loaded this session, pipeline exists | Show metrics loads the clusters and the cluster's pipelines, then shows the metrics | A failed cluster load gives the Cloud view's existing error once, then `notStarted` |
| GENUINELY_GONE | Cluster list loaded, the pipeline is not in it | "That pipeline is no longer in the Cloud view…" and `notStarted` | As now |
| RACE | The bind on opening is waiting on Show metrics; the user shows another source (command, pick, a Show button) | The tab ends on the user's source | The bind's late Cloud bind is dropped |
| RETRY | The bind on opening did not start (e.g. signed out); then the Cloud account or cluster data changes; tab revealed again | The bind is tried again for the same config | Without a Cloud change, a reveal doesn't retry (no repeated message) |

## Decisions

- Race (user, 2026-11-21): a request token. The panel issues a token with each Cloud request it makes (its bind on opening, the Show button, the pick, `showFor`). The token goes on the Show metrics command's node argument as an optional field, and Show metrics carries it into the `CloudMetricsBinding`. `showCloud` drops a binding whose token is older than the panel's latest user choice (local `show` counts too). A binding with no token, from the Cloud view row, always lands.
- Retry (user, 2026-11-21): a failed bind on opening tries again on the next reveal after the Cloud view's account or cluster data changes (connect, disconnect, refresh). The panel gets an optional `onCloudChanged` event wired in `extension.ts`. With no change, a reveal doesn't retry.
- Plan size (user, 2026-11-21): keep the full plan (about 1,780 tokens).

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/metricsPanel.ts` -- `showFor` (~479) and `showMapped` (~504-519) ignore the command's result; `bindOnOpen` (~280-295) with `mappingTriedFor` (160, set before the attempt and never cleared) and `stillWanted = () => !this.uri` (checked once at 512, before the command's awaits); `'showMappedRequested'` (~382-388, the Show button); the pick's Cloud branch (~539); `show` (553), `showCloud` (569-579) and `bind` (582-596, the only place `this.uri` is set). There is no generation token in this file yet. The closest patterns are `opened()`'s `this.subscription === sub` check and `CloudView.loadClusters`' `generation`.
- `src/adapters/vscode/cloudMetrics.ts` -- `ShowMetricsResult` (80-84: `notStarted` | `noAccess` | `shown`), `NOT_STARTED` (70); `showMetrics` (305-361) loads pipelines only when `ctx.clusterById` finds the cluster (320-323); `metrics.showCloud(binding)` at 345.
- `src/adapters/vscode/cloudView.ts` -- `SHOW_CLOUD_METRICS_COMMAND` registered at 736 and returning the result (`showMetrics` 1481); `loadClusters(force)` (1035-1078) is on `CloudContext` (441). It is safe unexpanded: it dedupes, returns with no account, skips when loaded, drops stale results, and fires no tree event. Callers set `ctx.requested = true` first.
- `src/adapters/vscode/cloudActions.ts:143-151` -- `paletteTarget`, the model for (b): `requested = true; await loadClusters(false)`.
- `src/extension.ts:305-323` -- the `MetricsPanel` wiring. A Cloud-change hook for the retry would be passed here (e.g. the Cloud view's change event).
- Tests: `src/test/adapters/vscode/metricsPanel.test.ts` (the `executeCommand` fake at 85-88 returns `undefined`; the ticket 9 resolver suite at 263, MAPPED_NO_RUN 274, DIRECT_OPEN 347/366; the Show button at 196). `src/test/integration/suites/99b-cloud-metrics.ts`: `FakeCloud`; setup 178-199 connects; "ticket 9, MAPPED_NO_RUN, NOT SIGNED IN" (633-650) asserts the old stale title, so update it to Not running; MAPPED_NO_RUN 615-631. `96-cloud.ts:718-746` resets the Cloud view's loaded data through a stored-account change (the model for an unloaded cluster list).

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/vscode/cloudMetrics.ts` -- in `showMetrics`, when signed in and the cluster list is not loaded (`ctx.clusters?.kind !== 'ok'`), set `ctx.requested = true` and `await ctx.loadClusters(false)` before the cluster lookup -- (b)
- [x] `src/adapters/vscode/metricsPanel.ts` -- `showMapped` returns whether the tab got bound (`shown` or `noAccess`), and `showFor` falls through to `show(target)` otherwise. A token issued per user choice makes a bind-on-opening's late `showCloud` a no-op when the user chose meanwhile, and its fall-through is skipped too. `mappingTriedFor` is cleared on `onCloudChanged`; the request token per Decisions -- (a), (c)
- [x] `src/adapters/vscode/cloudMetrics.ts` -- the node argument's optional token is copied into the binding -- (c)
- [x] `src/extension.ts` -- pass `onCloudChanged` from the Cloud view's account or cluster data change -- (c)
- [x] `src/test/adapters/vscode/metricsPanel.test.ts` -- the fake returns a configurable `ShowMetricsResult`; add tests for MAPPED_NOT_STARTED, MAPPED_NO_ACCESS, RACE (a deferred command that calls `panel.showCloud` after a `panel.show(OTHER)`), and RETRY (no retry without a Cloud change; a retry after one)
- [x] `src/test/integration/suites/99b-cloud-metrics.ts` -- through the real command: NOT SIGNED IN now ends Not running; CLUSTERS_NOT_LOADED with the cluster list reset; GENUINELY_GONE still gives its message and Not running

**Acceptance Criteria:**
- Given any of the matrix's scenarios, when the existing 7.9 resolver tests run, then they still pass, apart from the NOT SIGNED IN expectation the fix changes on purpose.
- Given the full stable and multiroot suites, when they run, then they pass.

## Implementation Notes

- Tokens: the panel keeps `requestSeq`, `lastUserChoice` (bumped by `showFor`, the pick, the Show button, a public `show`, and a tokenless `showCloud`), `lastUserBind` (bumped when a user's tokened binding lands) and `openRequest` (the bind on opening's token). A user's request is stale once a later user choice was issued; the bind on opening's is stale once any user choice was issued or a user's binding landed after it (so a user's Show metrics issued before the bind started still wins when it lands first). The token travels as `request` on the node (`ShowMetricsNode` in `cloudMetrics.ts`) into `CloudMetricsBinding.request`.
- `show` is now a user choice; the resolver's and the bind on opening's own local steps use a private `showLocal`, so they don't supersede requests in flight.
- The bind on opening keeps its 7.9 fall-through (the only running file, else nothing); only `showFor` falls through to the file, Not running.
- Show metrics' cluster load: when the list is not `ok` it sets `requested` and calls `loadClusters(false)`; a fresh load that fails returns `notStarted` after the loader's own error. A list already in error is not re-read (`loadClusters(false)` skips it) and keeps the old "no longer in the Cloud view" message.
- `onCloudChanged` is the Cloud view's `onDidChangeTreeData` forwarded through an emitter in `extension.ts` (the view is built after the panel). It also fires for other tree changes (a pipeline upsert, an access read, the account name learned on the first token), so a retry can happen after those too.
- 99b: CLUSTERS_NOT_LOADED's error handling has its own test, "bug 58, CLUSTERS_NOT_LOADED, LOAD FAILS" (the FakeCloud's cluster list answers 503: the Cloud view's error once, no "no longer" message, the file Not running); the setup resets `fake.clustersError`.
- 99b: the NOT SIGNED IN test disconnects through `disconnectSettled` (the setup's Connect could be read back by its late store event before the delete settled; seen once in a full run).

- Verification (orchestrator, 2026-11-21, after the review patches): compile clean; test:webview 421 passed; test:corpus 182 passed; layering grep empty; stable 1731 passing, 1 pending; multiroot 15 passing. The review patches added a public `MetricsPanel.unbind()` test seam, exposed on the `ExtensionApi` metrics pick.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick):** high 0, medium 2, low 2, false 0, maybe-false 0. Routes: 2 patch, 2 rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `showFor`'s local fall-through doesn't count as a user binding, so a bind on opening that started after it (larger token) can overwrite it with its late Cloud binding | medium | patch | Confirmed: `showLocal` bumps neither `lastUserChoice` nor `lastUserBind`, and `stale(openRequest)` compares only those two. Fix: the fall-through marks a user bind before `showLocal`, and a unit test covers it. |
| 2 | Fix (c) has no integration test through the real command: neither the token drop nor the `onCloudChanged` wiring | medium | patch | Confirmed: the new `99b` tests cover only (a) and (b). This breaks the "every fix gets a test that runs the real Show metrics command" constraint. Fix: add `99b` tests for a stale token dropped through the real command, and for a retry after Connect. |
| 3 | A tree event fired during a failed attempt (the account name learned on the first token) clears `mappingTriedFor`, so the message repeats on the next reveal | low | reject | Confirmed: `cloudView.ts:881-883` fires only when the token's client name differs from the account's, which happens once per session. So the message repeats at most once. A fix needs added guards. |
| 4 | A list already in error, with a forced refresh in flight that fails: the error plus "no longer in the Cloud view"; a generation change during the load gives "no longer" | low | reject | Confirmed: `loadClusters` returns the in-flight promise before the `!force` skip. This needs a concurrent forced refresh on an errored list, which is rare in everyday use. A fix needs more branches. |

## Design Notes

The race needs the panel to tell its own bind's `showCloud` from the user's, because the same command calls both, and two command calls can be in flight at once. Decisions settle it with a request token.

## Verification

**Commands:**
- `npm run compile` -- expected: no errors
- `npm run test:webview` and `npm run test:corpus` -- expected: all pass
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no output
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: all pass
- the same with `--label multiroot` -- expected: all pass
