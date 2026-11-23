---
title: 'Story 62: the metrics risks epic 7 left unverified are settled with tests'
type: 'bugfix'
ticket: '62'
created: '2026-11-23'
status: 'built'
baseline_revision: 'e193882cd556a5969118518e950de2176142fceb'
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

**Problem:** Epic 7's retrospective left risks C9–C12 unverified, and bug 61 added a `workspaceState` one. The investigation (2026-11-23) found:
- Five risks happen: C9's stale Cloud binding, C12's port rebind, C12's renamed file, C12's re-parse on every reading, and C12's "cluster gone" on Set up after a disconnect.
- Two exist in the code but no user can hit them: C11's unparsed URL and C12's masking race.
- C10's queued reads happen too, but only with three or more visible graphs.
- Two don't happen: the untitled graph's pick, and the `workspaceState` echo.

**Approach:** Each risk that happens gets a test that fails on today's code, then the smallest fix. Each one that doesn't keeps a test (or recorded evidence) that shows it. The verdicts are recorded in Implementation Notes.

## Boundaries & Constraints

**Always:**
- What the tab and the graph show for a live local run or Cloud pipeline stays as EXPERIENCE.md's Pipeline Metrics section says.
- Last-chosen-wins holds: Show metrics binds the Cloud, and Show Pipeline Metrics or a run the user starts binds back to local.
- AD-25's pace and per-cluster floor are unchanged.
- No secret appears in a message or log.

**Never:**
- No change to the structure of the metrics files beyond what a fix needs (that is story 63).
- No change to the logs tab (its Set up after a disconnect is unreachable: `stopped` offers no button).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| C9 remapped | A file's feed is Cloud-bound (graph visible, tab closed), then its `.cloud.json` maps another pipeline, or the pipeline leaves the Cloud view | The feed goes back to local; it never keeps reading the old pipeline | none |
| C9 sign-out | Cloud-bound, then signed out or access forgotten | `noAccess`, no reads (as today) | none |
| C12 rebind | Cloud-bound, then the run's automatic port rebind fires `running` again | Stays Cloud-bound | none |
| C12 rename | The tab shows a file that is renamed | The tab and the graph follow the new name; readings keep their rows; no "could not read" | none |
| C12 re-parse | N readings of an unchanged file | The config is read and parsed once, not per reading; it's parsed again only after a change | none |
| C12 disconnect | Tab Cloud-bound in `noAccess` after a sign-out; Set up metrics access… pressed | The Connect offer (`NOT_CONNECTED_FOR_METRICS_MESSAGE` with Connect), not `CLUSTER_GONE` | none |
| C11 | A Prometheus URL that fails `new URL` and carries userinfo | The host shown and logged never contains the userinfo | none |
| C12 mask | A tab action fails after the tab was rebound mid-action | Its log line is masked with the binding held at the start | none |
| untitled | The graph button on an untitled file | The pick (as designed; the existing NOT A FILE test stays) | none |
| flake | The "ACCESS REPLACED" feed test, a read held while the access changes | The held read takes its answer when it starts, so the read the change starts never takes the held read's `refused`; the test's own timeouts are honoured | none |

## Decisions

- C10 is not fixed here. Story 62 records its verdict and a test of today's per-feed gap, and the shared per-cluster fetch (with AD-25 amended) becomes its own backlog ticket, filed with bmad-ticket after this build (the user, 2026-11-23).
- C9: only the stale binding is fixed. The graph gets no source label (the user, 2026-11-23).
- The "ACCESS REPLACED" test flake is fixed in this story (the user, 2026-11-23).

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/metricsFeed.ts`:
  - L260-275 `bindLocal` / `unbindCloud`
  - L278-310 `accessChanged`
  - L491-513 `runChanged`. A `running` change unbinds the Cloud; C12's rebind must not.
  - L593-643 `readCloud`; L646-649 and L757-787 the per-cluster floor
  - L826-836 `configOf`
- `src/adapters/vscode/run.ts` L560-598, L619-640 `rebind()`: relaunch on a new port within `BIND_WINDOW_MS`, firing `running` again. Mark it (`RunChange.rebind`).
- `src/adapters/vscode/metricsPanel.ts`:
  - L427-469 `act`: capture `binding` before the `try` (C12 mask)
  - L526-531 untitled → pick (keep)
  - L668-683 `bind`
  - L715-719 `updated` → `configOf` per reading
  - There is no rename handling today.
- `src/adapters/graphPanel/graphPanel.ts` L164-169 (resubscribes on rename), L185-194 (its subscription keeps the feed alive), L208-228 `sendFigures`.
- `src/adapters/vscode/cloudMetrics.ts`:
  - L178-195 `clear` / `removeAccess` fire `onDidChangeAccess`
  - L227-229 `setUpAccessNow` → `rowCluster` → `CLUSTER_GONE` when signed out
  - L316-322: the signed-out Connect offer to reuse
  - L374-387: the binding
- `src/adapters/vscode/cloudShared.ts` L327-338 `rowCluster`; `cloudActions.ts` L119-128 `connectedFirst`.
- `src/extension.ts` L286-299 `configFor`: a sync `readFileSync` and `parseYaml` per call. `src/adapters/vscode/parseCache.ts` L11-21 caches open documents by version.
- `src/adapters/metrics/source.ts` L175-181 `cloudAddress`: its catch returns the raw URL. Reuse the pattern of `src/adapters/cloud/http.ts` L92-98 `hostOf`.
- Tests to extend:
  - `src/test/adapters/vscode/metricsFeed.test.ts`: the Cloud suite's `binding()` fake (`answers`, `hold`, `accessChanged`), and "FLOOR per cluster" (L404) for C10.
  - `src/test/adapters/vscode/metricsPanel.test.ts`: "NOT A FILE" (L397-408) and the `binding(...)` factory (~L422).
  - `src/test/adapters/metrics/source.test.ts`: the Cloud source suite (L146). Nothing tests `cloudAddress` today.
  - `src/test/integration/suites/99b-cloud-metrics.ts`: "NO_ACCESS → Set up from the tab" (L506), "NOT SIGNED IN" (L620-632) and `disconnectSettled` (L95). "ACCEPTANCE (GRAPH)" (L314) already covers reading with the tab closed.
  - `src/test/integration/suites/98-metrics.ts`.
- `workspaceState`: the only other memento write is `panels.ts` L779-785 `storeHidden`. In VS Code 1.147.0, the main thread forwards only shared (global) keys (`_sharedStorageKeysToWatch`, `$acceptValue(!0, …)`), and the ext host replaces `_value` only when `o.shared === this._shared`. So the workspace memento never gets the echo. Record that evidence; no test is possible in the suite.

## Tasks & Acceptance

**Execution:**
- [x] `metricsFeed.ts`, `run.ts` -- C12 rebind: `RunChange.rebind`, and `runChanged` keeps the Cloud binding on a rebind -- a rebind isn't a run the user chose
- [x] `metricsFeed.ts` (+ the Cloud view's change event, as bug 58 wired `cloudChanged` in `extension.ts`) -- C9: on a Cloud change, a Cloud-bound feed whose file's mapping no longer names its pipeline, or whose pipeline is gone, goes back to local -- no endless reads of the old pipeline
- [x] `metricsFeed.ts`, `metricsPanel.ts`, `graphPanel.ts` -- C12 rename: on a file rename, re-key the feed and move the tab with it -- the tab otherwise reads a file that no longer exists
- [x] `metricsPanel.ts` / `extension.ts` -- C12 re-parse: the config model and paths are kept per file version or mtime; the disk is read and parsed again only when the file changes
- [x] `cloudMetrics.ts` -- C12 disconnect: `setUpAccessNow` offers Connect when signed out, before `rowCluster`
- [x] `metricsPanel.ts` -- C12 mask: `binding` is taken before the `try` in `act`
- [x] `source.ts` -- C11: `cloudAddress`'s catch returns a fixed text (`the Prometheus endpoint`)
- [x] `src/test/adapters/vscode/metricsFeed.test.ts` -- the flake: the Cloud fake's `read` takes its answer from `answers` before it awaits `hold`, and `until` honours its timeout argument (today it ignores it) -- "ACCESS REPLACED" otherwise fails when the read started by the access change runs first
- [x] Tests, each named "story 62 <risk>", for every Matrix row. Each one for a fix fails on the baseline source. C10 gets a test that records the per-feed gap with three feeds on one cluster (it should pass on today's code).

**Acceptance Criteria:**
- Given the Implementation Notes, when this is done, then every risk (C9, C10, C11, C12's six items, `workspaceState`) has a verdict and its test or evidence.
- Given the full stable suite, when it runs twice, then all pass and no existing test's expected values change.

## Implementation Notes

Verdicts, each with its test (all named "story 62 …"). "Fixed" tests fail on the baseline source (checked: the baseline `src/adapters` and `src/extension.ts` with the new tests, 15 failing, the passing ones being the "no fix" rows below).

| Risk | Verdict | Change | Test / evidence |
|------|---------|--------|-----------------|
| C9 stale binding (remapped / gone) | Happens. Fixed | `MetricsFeed.cloudChanged`: on the Cloud view's change (`cloudChanged` in `extension.ts`, now also given to the feeds), a file's Cloud-bound feed whose pipeline the view knows is gone (`CloudView.pipelineGone`: signed in, a list read without it), or whose own `.cloud.json` maps another pipeline, goes back to local (`bindLocal`), logged. No mapping (a file found by its tag) or a mapping of the same pipeline: kept. No source label on the graph (Decisions). | unit `metricsFeed.test` "story 62 C9 remapped"; integration `99b` "story 62 C9 gone", "story 62 C9 remapped" |
| C9 sign-out | Doesn't need a fix: `noAccess`, no reads, still the Cloud (signed out, `pipelineGone` is `false`) | none | unit "story 62 C9 sign-out" (passes on the baseline) |
| C10 queued reads | Happens with 3+ feeds of one cluster: the per-cluster floor queues them, so each feed reads less often than its interval (3 feeds, floor 30 ms, interval 40 ms: each about 90 ms apart). Not fixed (Decisions): the shared per-cluster fetch (AD-25 amended) is a backlog ticket still to be filed with bmad-ticket | none | unit "story 62 C10" (passes on the baseline, records the gap) |
| C11 unparsed URL | In the code, no user hits it. Fixed anyway: `cloudAddress` returns `CLOUD_ADDRESS_FALLBACK` ("the Prometheus endpoint") for a URL that does not parse or has no host, never the raw URL | `source.ts` | unit `source.test` "story 62 C11" (2) |
| C12 rebind | Happens. Fixed: the automatic restart on a new port fires `running` with `RunChange.rebind: true` (absent otherwise, so no existing expected change differs); a Cloud-bound feed ignores it | `run.ts`, `metricsFeed.ts` | unit `run.test` and `metricsFeed.test` "story 62 C12 rebind" |
| C12 rename | Happens. Fixed: `MetricsFeeds` follows `onDidRenameFiles` (registered before the graph panels', so a renamed graph finds its feed under the new name; the graph keeps a feed already moved), re-keys the feed (a folder's too, the batch as `renamedThrough` applies it), keeps its readings, and follows a run started under the old name until it ends (`runUri`); the tab follows through `onDidRekey`. | `metricsFeed.ts`, `metricsPanel.ts`, `graphPanel.ts` | unit `metricsFeed.test` (2), `metricsPanel.test` "story 62 C12 rename"; integration `98` "story 62 C12 rename" |
| C12 re-parse | Happens. Fixed: `metricsConfigReader` (`extension.ts`) keeps each file's config per document version, the file's mtime and size, and the schema; read and parsed again only when one changes | `extension.ts` | unit "story 62 C12 re-parse" (3) |
| C12 disconnect | Happens. Fixed: `setUpAccessNow` waits for the account read and, signed out, offers `NOT_CONNECTED_FOR_METRICS_MESSAGE` with Connect before `rowCluster` | `cloudMetrics.ts` | integration `99b` "story 62 C12 disconnect" |
| C12 mask | In the code, no user hits it (needs a rebind during a failing action). Fixed: `act` takes the binding before the `try` | `metricsPanel.ts` | unit `metricsPanel.test` "story 62 C12 mask" |
| untitled | Doesn't happen: the graph button on an untitled file is the pick, as designed (NOT A FILE stays) | none | unit "story 62 untitled" |
| `workspaceState` echo | Doesn't happen. Evidence (no test possible in the suite): `panels.ts` `storeHidden` is the only other memento write; in VS Code 1.147.0 the main thread forwards only shared (global) keys (`_sharedStorageKeysToWatch`, `$acceptValue(!0, …)`), and the extension host replaces `_value` only when `o.shared === this._shared`, so the workspace memento never takes an echo | none | recorded here |
| flake ("ACCESS REPLACED") | Test fake fixed: `read` takes its answer from `answers` before it awaits `hold`; the first suite's `until` takes a `tries` argument as the Cloud suite's does | `metricsFeed.test.ts` | unit "story 62 flake": fails with the old fake (checked), passes with the new one |

Verification (2026-11-23): compile, lint, `test:webview` (421), `test:corpus` (182), the `vscode-from` grep (no output), the `--grep "Extension tracer path|story 62"` run (27 passing), the full stable suite twice in a row (1762 passing, 1 pending, each) and `multiroot` (15 passing). Earlier full runs showed two failures, both now dealt with: the 98 rename test's "could not read" check also caught other suites' Cloud lines (it now matches only `Pipeline metrics: could not read`), and the C10 test's per-feed bound was too tight (it now checks each feed's mean gap is over the interval and their average is about three floors). One unrelated timeout (Bloblang panel REORDER + PATH_FALLBACK, during a run that took 37 min against the usual 14) did not come back.

Review patches (the Review Triage Log's 1–4). Each test below fails on the pre-review source (checked: 6 failing) and passes after:

1. C9 remap undid an explicit Show metrics: `bindCloud` now keeps the file's `.cloud.json` pipeline as it was at the bind (`boundMapping`); `cloudChanged` unbinds only when the mapping changed from that, to a pipeline other than the bound one. Test: `metricsFeed.test` "story 62 C9 mapped at bind".
2. "could not read <old>" between the rename on disk and `onDidRenameFiles`: the feeds follow `onWillRenameFiles` (`renamePending`, forgotten after 5 s if no rename comes); `configOf` of a pending file returns nothing with no log, and the tab leaves that reading's rows to be made under the new name (the pending mark is cleared only after the feed's move is told). Tests: `metricsFeed.test` and `metricsPanel.test` "story 62 C12 pending rename".
3. A rename onto an existing name: the displaced feed is announced (`onDidDisplace`), and a tab bound to it moves to the moved feed (the file's content now), dropping the old hold, so the displaced feed stops. The graph of the overwritten file is already closed by the graph panels. Test: `metricsPanel.test` "story 62 C12 rename onto the bound name".
4. `metricsConfigReader`'s cache: it has `forget(uri)`, which the feeds call (`forgetConfig`) when a feed is released, renamed away or displaced. Tests: "story 62 cache" (2).

Re-verified: compile and lint clean, `compile-tests`, the `--grep "Extension tracer path|story 62"` run (33 passing), and the full stable suite once (1768 passing, 1 pending).

Left: the C10 backlog ticket (shared per-cluster fetch, AD-25 amended) is to be filed with bmad-ticket.

- Verification by the orchestrator (2026-11-23, after the review patches): compile and lint clean; test:webview 421 passed; test:corpus 182 passed; layering grep empty; full stable twice in a row: 1768 passing, 1 pending, each; multiroot 15 passing.

## Review Triage Log

**Pass 1 (quick):** high 0, medium 1, low 3, false 0, maybe-false 0, plus 1 process note. Routes: 4 patch, 1 rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | C9's remap check undoes an explicit Show metrics when the file's mapping already named another pipeline at bind time | medium | patch | Confirmed. `CloudActions.metricsFileOf` → `CloudView.localFileOf` finds the file by the pipeline's config tag and never reads `.cloud.json`, so a file deployed twice (mapping names B; the older A still tagged) binds to A, and `MetricsFeed.cloudChanged` then unbinds it at the next tree change. That breaks last-chosen-wins (Always). Fix: keep the file's mapping as it was when the Cloud was bound, and unbind only when the mapping changes from that. Add a test of the already-different case. |
| 2 | A reading between the rename on disk and `onDidRenameFiles` logs "could not read <old>" | low | patch | Confirmed: the panel reads `configOf(this.uri)` with the old URI until `onDidRekey`. It contradicts the Matrix's "no 'could not read'" and can make the 98 rename test flaky. Fix: follow `onWillRenameFiles` so that a config read during a pending rename of that file is skipped quietly. |
| 3 | A rename onto an existing name displaces the target's feed: its subscribers keep a feed the map no longer holds, so one file has two feeds | low | patch | Confirmed (`this.feeds.set(to, feed)`). Rare (an overwrite rename). Fix, if small: the displaced feed's subscribers move to the moved feed (or the displaced one is released and its tab rebinds), with a test. If it isn't small, report back instead. |
| 4 | `metricsConfigReader`'s cache never drops entries | low | patch | Confirmed: it drops an entry only on a failed `stat`. Fix: drop the entry when the file's feed is released or renamed. |
| 5 | The C10 follow-up ticket isn't filed | — | reject | Not a code finding. Filing it is the orchestrator's job after the build (Decisions). |

## Verification

**Commands:**
- `npm run compile` -- expected: no errors
- `npm run test:webview` and `npm run test:corpus` -- expected: all pass
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no output
- `npm run compile-tests`, then `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 900 xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|story 62"` -- expected: the new tests pass (the tracer suite activates the extension for a `--grep` run)
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: all pass, twice; and `--label multiroot` -- all pass
- Run the integration suites one at a time. Never use `--label floor`.


## Manual Check

- 2026-11-23, the user, VS Code 1.143.1 dev host from `.vscode-test`: the manual checks passed with no issues. A locally running file renamed in the Explorer kept its tab (header and live rows under the new name, no "could not read"). After Show metrics on an rpc-vilnius pipeline and Disconnect, Set up metrics access in the tab offered Connect. The rebind, remap and masking fixes are covered only by the tests.
