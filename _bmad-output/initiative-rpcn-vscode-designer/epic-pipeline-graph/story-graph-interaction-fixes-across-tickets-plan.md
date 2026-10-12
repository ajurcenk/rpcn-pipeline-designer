---
title: 'Graph interaction fixes across tickets'
type: 'bugfix'
ticket: '15'
created: '2026-10-12'
status: done
baseline_revision: '0bd42ac1097ffa6a86b1e3d1469e27bda10f271c'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/epic-pipeline-graph-retrospective.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The epic 3 retrospective found bugs where tickets 3.6–3.11 meet, which no single ticket's review saw (F1–F8). It also found that no test drives those combined sequences (F11). The user will accept epic 3 only after this story and the 3.7 check land.

**Approach:** fix each finding with the smallest change in the code it names, and add one test per finding that drives the combined sequence. Behaviour outside these cases stays as it is.

- **F1, status in flight during `ready`:** a `nodeStatus` post still running when a snapshot is sent must not change what the host records as sent. The snapshot's status wins, and a later equal status is not skipped wrongly.
- **F2, Hide during a queued Show:** the file stays hidden and no panel opens. `open()` re-checks the Hide for every open, not only auto-opens.
- **F3, a way out in every state:** a region named "Pipeline graph, read-only" that can take focus and handles Esc (posting `focusEditorRequested`) exists in every view state:
  - before the first layout;
  - the no-binary and nothing-to-draw states;
  - the loading or no-schema canvas;
  - a first open on broken YAML.

  There is still exactly one region with that name.
- **F4, the live region repeats nothing:**
  - the banner is announced **once per appearance** (user decision 2026-10-12, "Once per appearance", which replaces "or when the error's message changes": parse messages carry the line and column, so that clause repeated the banner on almost every keystroke). That means only when the banner appears in a webview that has seen the file parse, and never while it stays up, whatever its message;
  - a recreated webview's snapshot and a schema drop and return announce nothing;
  - a snapshot with no model still sets the error baseline, so the first status announces only errors that are really new.
- **F5, focus after a remount:** if keyboard focus was in the graph when it unmounted (no-binary, or a schema drop), it returns to the graph's Tab stop when the graph draws again.
- **F6, disposal:** no post after a panel is disposed (no spurious "Graph" error lines), and the lock sequence stops once its panel is disposed.
- **F7, renames:** one batch with a chain or a swap (`a→b, b→c`; `a↔b`) re-keys `panels`, `seen`, `hidden` and `driving` as a whole. The driving entry is the visible editor of the new URI, not the old editor object.
- **F8 (user decision 2026-10-12, "a"):** while the YAML does not parse, a click or Enter on a node of the last valid graph stays a no-op. Each node's accessible name ends with ", navigation unavailable while the YAML has errors". The visible text does not change.

## Boundaries & Constraints

**Always:**
- Fix inside the files the findings name; AD-3, AD-15 and the never-throw + log pattern hold.
- No new protocol messages: F3 reuses `focusEditorRequested`.
- Every new test drives the combined sequence across tickets, not one ticket's path alone.
- **Green:** `npm test` (stable and 1.100.0), `npm run test:webview`, `npm run test:corpus` and CI.

**Never:**
- F9 items (AI-2), F10 (`pendingRenames`, backlog 14), or code-health refactors (AI-6);
- changes to the visible copy, settings or commands;
- Save As (backlog 12).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| F1_RACE | a `nodeStatus` post is pending when `ready` sends a snapshot with status B; then the diagnostics change to A | A is posted | — |
| F2_HIDE_QUEUED | Show graph queued behind a lock, then Hide graph before it runs | no panel; the file is hidden | — |
| F3_ESC | Esc in each listed state | `focusEditorRequested` posted; one named region exists | — |
| F4_LIVE | a snapshot with a parse error after a recreate; a schema drop and return on the same error; a snapshot with model null, then a status; a parse message that changes while the banner stays up | nothing is announced | the file heals (also during a schema drop) and breaks again → announced once |
| F5_FOCUS | focus on a node → hostStatus none → ok + model | focus is on the graph's Tab stop again | focus elsewhere → left alone |
| F6_DISPOSE | Hide (or tab close) while an update or a lock is awaiting | no post after dispose; no `lockEditorGroup` for it; no error line | — |
| F7_RENAME | one batch `a→b, b→c` with panels on a and b; a swap `a↔b` with a Hide on a | each panel and Hide follows its file; the driving editor is the new URI's | — |
| F8_BROKEN | the YAML broken; focus a node; click / Enter | no message's effect (no selection change); the node's name ends with the unavailable note | — |
| F11_LATE | a late schema with the cursor in the input and a lint finding | after the model: `selection` and `nodeStatus` | — |

</frozen-after-approval>

## Code Map

The retro findings in `epic-pipeline-graph-retrospective.md` carry the lens ids and line numbers; re-check them against HEAD.
- **F1:** `src/adapters/graphPanel/graphPanel.ts` `receive` → `ready` (:95–121; `sentStatus` at :119–121) and `postStatus` (:284–296; `postingStatus`, `sentStatus`).
- **F2:** `src/adapters/graphPanel/panels.ts`:
  - `show` (:338) deletes the Hide and enqueues `open(…, false)`;
  - `hide` (:360) adds the Hide and disposes only an open panel;
  - `open` (:420–436) re-checks `shouldAutoOpen` only when `auto`.
- **F3:**
  - `webview/src/Graph.tsx` `onKeyDown` (:221–223) returns while `!laidOut`; the container is `.rpcn-graph` (`role="region"`, `GRAPH_NAME`);
  - `webview/src/main.tsx` `App` (:278–293) mounts `Graph` only with a model, and `EmptyStateView` (:243) has no Esc handler.
- **F4:** `webview/src/state.ts` `liveAnnouncements` / `reduceLive` (:96–103, :164–168, :182–185), `LiveView.errors`; the host side is `graphPanel.ts` `hostChanged` (:184–192).
- **F5:** `Graph.tsx` `hasFocus` ref (:143), the refocus effect (:179–181); the remount happens in `main.tsx:281`.
- **F6:**
  - `graphPanel.ts` `post` (:242–244) and `dispose`;
  - `panels.ts` `lock` (:517–551; `until` predicate and `executeCommand`);
  - the Hide and TAB_CLOSE disposals (:360–372, :271).
- **F7:**
  - `panels.ts` `renamed` (:278–323; the panel loop :281–295, driving :296–302, seen, hidden);
  - the visible-editor pruning in `onDidChangeVisibleTextEditors` (:169–174);
  - `renamedKey` in `tabs.ts`.
- **F8:** `graphPanel.ts` `activate` (:375–381) needs no change; the names come from `webview/src/layout.ts` `nodeAnnouncement` / `nodeSpokenName`, with the parse-error state from `ViewModel.parseError`.
- **Tests:**
  - host: `src/test/integration/suites/8x-graph-*.ts`, `graphHelpers.ts` (`testPanels`, `fakeDiagnostics`, `withAutoOpen`, `idle()`, the `posted` seam);
  - webview: `webview/src/keyboard.test.tsx` (happy-dom), `state.test.ts` (reducer chains), `layout.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `graphPanel.ts`: F1, the F6 post guard. Host.
- [x] `panels.ts`: F2, the F6 lock guard, F7. Host.
- [x] `webview/src/{main.tsx, Graph.tsx, state.ts, layout.ts}`: F3, F4, F5, F8. View.
- [x] Tests, one per matrix row, in the suites named above, on both versions.
- [x] `CHANGELOG.md` (one "Fixed" line); `README.md` only if a statement there becomes untrue.

**Acceptance Criteria:**
- Given the retro's findings F1–F8, when this story is done, then each has a test that failed before the fix and passes after it. Each one's row in the retro maps to a matrix row here.

## Implementation Notes

- **F1** (`graphPanel.ts`): every post carrying a status (snapshot or `nodeStatus`) takes a sequence number; only the latest one, when it resolves, sets `sentStatus` and clears `postingStatus` (`statusPosted`). The snapshot also sets `postingStatus` to its own status, so a diagnostics change while it is in flight compares against it.
- **F6** (`graphPanel.ts`, `panels.ts`): `GraphPanel.dispose` sets `disposed`; `post` then returns `false` without recording or posting, and a post the disposal interrupted logs nothing. `lock` returns at once for a disposed panel, its `until` predicate ends on disposal, and no lock or focus return runs after it.
- **F2** (`panels.ts`): `open` returns `undefined` for a hidden file, for every open (Show graph clears the Hide before it enqueues, so an explicit Show still opens).
- **F7** (`panels.ts`, `tabs.ts`): `renamedThrough` applies a batch in order (a chain `b→c, a→b` and a swap `a→t, b→a, t→b` both land each key on its own file); `renamed` rebuilds `panels`, `seen`, `hidden` and `driving` from the old keys at once. The driving editor is never the old editor object: its column is kept in `renamedDriving` (also when VS Code closes the old editors before it reports the rename, from `pendingRenames`) and the new URI's visible editor in that column is adopted on the visible-editors change and again when the rename is reported.
- **F3** (`main.tsx`, `Graph.tsx`): Esc on the graph container works before the first layout; the no-binary empty state is focusable (`tabIndex 0`) and handles Esc (from its buttons too); with no model to draw (loading, no schema, first open on broken YAML) a `CanvasRegion` is the named region. Exactly one region carries the name in each state. A focus ring for `.rpcn-empty:focus-visible` was added (no copy change).
- **F4** (`state.ts`, `graphPanel.ts`), once per appearance: a snapshot never announces. A `parseError` announces the banner only when the banner is not up and the webview has seen the file parse (`validSeen`: a snapshot with a model and no parse error, or any `model`, which the host sends only while the file parses; the contract is written in `protocol.ts`). A schema returning while the YAML does not parse now gets a full `snapshot` from `hostChanged` (was `model` + `parseError`), so the reducer never has to guess. A snapshot with no model sets the baseline from its status once the first model arrives.
- **F5** (`Graph.tsx`, `main.tsx`): `App` holds a `graphFocus` ref; `Graph` writes `hasFocus` to it on unmount and starts from it on mount, so the existing refocus effect returns focus to the roving Tab stop. When focus is found elsewhere at that point, `hasFocus` is cleared, so a later remount does not pull focus in.
- **F8** (`layout.ts`, `Graph.tsx`): `nodeAnnouncement(…, broken)` appends `NAVIGATION_UNAVAILABLE`; `Graph` gets `broken = view.parseError !== null`. The host's no-op is unchanged.
- **Tests:** host scenarios in the new suite `src/test/integration/suites/86-graph-interactions.ts` (F1_RACE in two orders, F2_HIDE_QUEUED, F6_DISPOSE ×3, F7_RENAME ×5, F8_BROKEN, F11_LATE); view scenarios in `keyboard.test.tsx` (F3_ESC ×4, F5_FOCUS ×3, F8_BROKEN), `state.test.ts` (F4_LIVE ×4 reducer chains) and `layout.test.ts` (F8 names).

## Plan Change Log

- 2026-10-12, F7 batches are simulated. VS Code 1.141.0 and 1.100.0 report each rename of a WorkspaceEdit as an event of its own, so a real chain or swap never reaches `renamed` as one batch, and the old code already handles separate events. The chain, swap and driving-column tests therefore build a registry whose `onWillRenameFiles` / `onDidRenameFiles` are test emitters (the real WorkspaceEdit runs, and the test reports it as one batch afterwards). A further test uses VS Code's own events.
- 2026-10-12, F7 driving limitation found. With VS Code's own events, VS Code reports one of the reopened editors as active (it briefly activates its group) after the rename, so that editor becomes the driving one, as any focus does. The driving entry is still a visible editor of the new URI, as the intent asks, but not necessarily the old one's column. The real-events test asserts only that. Telling this report apart from a real focus would need a heuristic, which is out of scope.
- 2026-10-12, an existing assertion changed with F4. `state.test.ts` "the banner text when a parse error appears, once" expected a broken snapshot to announce the banner; per F4 it now announces nothing.

- 2026-10-12, review round 1: F4 follows the amended intent (once per appearance). `hostChanged` sends a snapshot on a schema return while broken (`83` LOST updated). Esc on the banner; focus in the no-binary state and the empty canvas counts for F5, and focus elsewhere in the view clears it (App-level focus tracking); the empty canvas region has its own class `rpcn-canvas-region` and `aria-busy` while the binary is unresolved or the schema loads; `fail()` logs nothing after dispose; `renamed()` does not move a driving entry adopted for the batch again and drops remembered columns of disposed or colliding panels; unit tests for `renamedKey` / `renamedThrough` (`src/test/adapters/graphPanel/tabs.test.ts`); the batch rename tests assert the driving editors.

## Review Triage Log

Iteration 0 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Verdicts: 0 high, 4 medium, 11 low, 4 false/rejected; 1 intent gap resolved by the user.

| # | Finding | Lens | Verdict | Route | Evidence / action |
|---|---|---|---|---|---|
| 1 | Banner re-announced whenever the parse message changes, i.e. on almost every keystroke (messages carry line and column) | blind | medium | intent_gap → resolved | The frozen F4 line said "or when the error's message changes". User 2026-10-12: "Once per appearance"; the F4 line is amended. User chose "Amend and patch" over a full revert, so this is a recorded deviation from the workflow's revert rule. |
| 2 | A file healed while the schema is gone keeps `knownError`, so the same error later goes unannounced | gap, edge | medium | patch | `knownErrorAfter` keeps the error on a `model` unless the banner is up. Fixed with #1. |
| 3 | Esc does nothing from the banner button, against F3's "every state" | edge | medium | patch | The handlers sit on the region and container only. |
| 4 | No-binary region focus is not tracked for F5, and a stale flag is not cleared | blind, edge | medium | patch | Only `CanvasRegion` sets `focusReturn`. |
| 5 | `CanvasRegion` reuses `rpcn-graph`, so test waits pass on the placeholder | blind, intent | low | patch | `keyboard.test.tsx` waits around :105 and :345. |
| 6 | No `aria-busy` while loading | blind | low | patch | One attribute. |
| 7 | `fail()` still logs after dispose for non-post steps | edge | low | patch | One guard. |
| 8 | The `validSeen` comment does not match the code | blind | low | patch | Comment only. |
| 9 | The reducer's host contract (`selection` and `nodeStatus` only while parsing) is undocumented | blind, intent | low | patch | A comment in protocol.ts. |
| 10 | `.rpcn-empty:focus-visible` is not covered by the TOKENS/focus test | blind | low | patch | — |
| 11 | No unit tests for `renamedThrough` / `renamedKey` | blind | low | patch | — |
| 12 | A driving entry adopted before the batch is re-keyed twice; `renamedDriving` is not cleaned on dispose or collision | blind, edge | low | patch | Small guards; the batch tests extended. |
| 13 | `renamedDriving` leaks for a rename that is announced but never reported | blind, edge, gap | low | defer | Same family as backlog 14 (`pendingRenames`). Needs a timeout. |
| 14 | `pendingRenames` from unrelated operations can chain | blind | low | reject | Needs two overlapping rename operations on the same names; rare, and a fix adds per-operation tracking. |
| 15 | Rename collision: the moved file's panel is disposed and the overwritten one survives; two keys landing on one target depend on iteration order | blind, edge | low | defer | Behaviour from 3.10, not caused here. Grouped with retro F9 (AI-2). |
| 16 | `statusPosted` can leave `sentStatus` stale when the latest post fails | blind | false | reject | `post` returns false only when `postMessage` throws, i.e. a disposed webview; F6 now ends posting after dispose, so no later status depends on it. |
| 17 | The CHANGELOG entry does not use `### Fixed` | blind | false | reject | The file's Unreleased section uses flat bullets for every entry (3.4–3.11); this one follows that convention. |
| 18 | The F6 lock test is coupled to the order of `setContext` and `lock` | blind | low | reject | The test passes and would fail without the guard (the implementer's stash check); a seam inside `lock` adds surface for a test-only concern. |
| 19 | F7: the intent's examples (`a→b, b→c`; `a↔b`) read as simultaneous, while the diff applies renames in order | intent | — | accept | VS Code performs a WorkspaceEdit's renames one after another and reports them as separate events (1.100–1.141), so in-order is the faithful reading. The batch tests are synthetic, as noted in Implementation Notes. |
| 20 | Most intent surfaces (the screen reader, real Esc in a webview, commands rather than API calls) are tested at module seams only | intent | — | accept | The same pattern as 3.4–3.11. The webview DOM in a real VS Code frame is covered by the user's manual checks (AI-4 follows). |

## Verification

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass on stable and 1.100.0, 627 or more.
- `npm run test:webview` (128 or more) and `npm run test:corpus` (123): all pass.

**Manual checks:** entry AI-4 (3.7's navigation check) runs after this story, in the same dev host.

**Results (2026-10-12):**
- `npm run compile` (check-types, eslint, esbuild): exit 0.
- `npm test`: 640 passing on stable (1.141.0) and 640 on 1.100.0, exit 0.
- `npm run test:webview`: 140 passed. `npm run test:corpus`: 123 passed.
- **Failed before the fix:** with the source changes stashed and the new tests kept, the following failed.
  - Webview: F3_ESC ×4, F5_FOCUS ×2, F8 ×2 (names in keyboard and layout), F4_LIVE ×4 and the changed banner assertion (13 in all).
  - Host, on stable: F1_RACE ×2, F2_HIDE_QUEUED, F6_DISPOSE ×3, F7 chain, swap and driving column One.
  - These pass both before and after, as guards or gap coverage: F5's "focus elsewhere", F7 driving column Three and the real-events driving test, F8_BROKEN host (the host was already a no-op) and F11_LATE.
- CI: not run (nothing pushed).

**Final verification (2026-10-12, after the thorough-review patches, from a clean `rm -rf out` rebuild):**
- `npm run compile` and `npm run lint`: exit 0.
- `npm test`: 645 passing on stable 1.141.0 and on 1.100.0.
- `npm run test:webview`: 146 passed. `npm run test:corpus`: 123 passed.
- **An earlier failure that went away:** FIX_ALL (2.22) failed on three stable runs during this build, then passed after `out/` was rebuilt from scratch. It also passed on the baseline, and in the implementer's 8 runs. The likely cause is stale compiled output left in `out/` by the implementer's stash check (`tsc` never deletes outputs), not this change; it could not be proven.
