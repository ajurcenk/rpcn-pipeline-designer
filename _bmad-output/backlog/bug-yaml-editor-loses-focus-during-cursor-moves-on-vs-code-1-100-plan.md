---
title: 'YAML editor loses focus during cursor moves on VS Code 1.100'
type: 'bugfix'
ticket: '15'
created: '2026-10-12'
status: done
baseline_revision: 'e9c0602628b03e1cb12353b492076c01cd8a01bb'
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

**Problem:** On a slow machine (CI on VS Code 1.100.0, 4 of 9 runs since f3242f4), the graph panel takes keyboard focus from the YAML editor after it opens. The CI diagnostic at the failing check showed `activeTextEditor` null, `panel.active` true, active tab "Graph: cursor.yaml" in group 2. The cause is the lock sequence:
- it reveals the panel with focus and waits `LOCK_WAIT_MS` (1 s) for the panel's group to become active;
- on timeout it gives up without locking and without returning focus;
- the delayed reveal then lands and takes focus, and nothing gives it back.

A second CI failure, F8_BROKEN's "nothing posted", is the same slowness: the real webview's late `ready` gets a snapshot inside the test's "nothing posted" window.

**Approach:** the lock sequence finishes late instead of giving up. When the wait times out, it keeps watching the panel for a bounded time; if the panel becomes active in that window, it locks the group as usual and returns focus to the YAML. Tests that assert nothing was posted ignore snapshots, which answer the real webview's `ready`, as `82-graph-markers.ts:135` already does.

## Boundaries & Constraints

**Always:**
- Same rules as today's sequence:
  - only a group holding nothing but graphs is locked;
  - focus returns to the YAML document in its column, and only while the panel is active;
  - never over another text editor the user made active since the timeout;
  - a disposed panel ends the sequence (F6_DISPOSE).
- The late window is bounded (5 s) and its listener is disposed on every path.
- `GraphPanels.open` still resolves when the timed wait ends: `showGraph` and auto-open don't wait the extra window.
- A test-only option `lockWaitMs` on `GraphPanelsOptions` (default `LOCK_WAIT_MS`) lets a test force the timeout.

**Never:**
- Weaken the CURSOR test's focus assertions.
- Change the 3.15 focus restore in the webview (`webview/src/Graph.tsx`), the spike 3.14 approach (reveal with focus, then lock), or `retainContextWhenHidden`.
- Raise `LOCK_WAIT_MS` as the fix.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LATE_ACTIVE | wait times out, then the panel becomes active within the window | the group is locked (only graphs), and focus returns to the YAML editor in its column | lock or focus failure is logged, as today |
| LATE_NEVER | the panel never becomes active within the window | nothing more happens; "did not become active" logged once | listener disposed at window end |
| LATE_USER_EDITOR | after the timeout the user makes another text editor active, then the panel becomes active | no focus moves to the YAML | none |
| LATE_DISPOSED | panel disposed (Hide graph, tab closed) during the window | sequence ends, no lock, no focus move, no error line | listener disposed |
| IN_TIME | the panel becomes active within `LOCK_WAIT_MS` | unchanged: lock, then focus back | as today |
| LATE_SNAPSHOT | the real webview's `ready` arrives during a test's "nothing posted" window | the test ignores the snapshot, and fails on any other message | none |

</frozen-after-approval>

## Code Map

- `src/adapters/graphPanel/panels.ts:52` -- `LOCK_WAIT_MS = 1_000`. Add a late-window constant (5 s).
- `src/adapters/graphPanel/panels.ts:567-608` -- `lock()`:
  - `reveal(undefined, false)`, `until(...)` (from `tabs.ts`), the only-graphs check, `lockEditorGroup`, then `showTextDocument(doc, {viewColumn: yamlColumn, preserveFocus: false})` only while `graph.panel.active`.
  - On a timed-out wait, start the late path (not awaited by `open`): `graph.panel.onDidViewStateChange` for `active` plus the group check, bounded by the window.
  - Then run the same lock and focus-back code, factored so both paths share it.
  - Record `vscode.window.activeTextEditor` at the timeout; skip the focus return if a different text editor became active since.
- `src/adapters/graphPanel/panels.ts:63` -- `GraphPanelsOptions`: add `lockWaitMs?: number`, a test seam, documented as such.
- `src/adapters/graphPanel/graphPanel.ts` -- `isDisposed` and `panel`. Dispose the late listener with the panel.
- `src/test/integration/graphHelpers.ts:116` -- `testPanels(overrides)`. Tests pass `{ lockWaitMs: 0 }` to force the late path.
- `src/test/integration/suites/84-graph-auto-open.ts:50-77` -- the AUTO test's lock and focus assertions to reuse: a file opened with no column goes beside, not into the locked group; no "not locked" / "could not" log lines.
- `src/test/integration/suites/86-graph-interactions.ts:459` -- F8_BROKEN `handle.posted.slice(count)`: filter out `snapshot`.
- `src/test/integration/suites/81-graph-navigation.ts:256` -- the same strict check, same fix.
- `src/test/integration/suites/81-graph-navigation.ts:155` -- the CURSOR test. Leave its assertions as they are.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/graphPanel/panels.ts` -- late completion of the lock sequence and the `lockWaitMs` option, per the matrix. This is the fix.
- [x] `src/test/integration/suites/84-graph-auto-open.ts` -- with `testPanels({ lockWaitMs: 0 })`: tests LATE_ACTIVE (locked, focus back in the YAML), LATE_USER_EDITOR, LATE_DISPOSED (no error line) and LATE_NEVER, if the window can be shortened through the same option. These pin the late path deterministically on any machine.
- [x] `src/test/integration/suites/86-graph-interactions.ts`, `81-graph-navigation.ts` -- the two strict checks ignore `snapshot` (LATE_SNAPSHOT).
- [x] `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` -- AD-1's lock-sequence line notes the late completion (AI-8).
- [x] `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` -- the CURSOR flake entry gets a line saying it is fixed by bug 15.

**Acceptance Criteria:**
- Given VS Code 1.100.0 and 1.141.0, when the full suite runs, then it passes with every focus assertion unchanged.
- Given the fix pushed, when CI runs at least three times (the push plus reruns), then every run is green.

## Implementation Notes

- `lock()` waits `lockWaitMs ?? LOCK_WAIT_MS`. On a timeout it starts `lockLate()`, which is not awaited, and returns, so `open` resolves when the timed wait ends.
- `lockLate()` runs one bounded poll over the whole late window: `until(() => done || graph.isDisposed || inItsGroup(graph), lockLateWindowMs ?? LATE_LOCK_WINDOW_MS)`. This also catches a panel that is already `active` at the timeout and whose group becomes active later, which is the state the CI diagnostic showed.
  - When the poll succeeds, the code waits `LATE_SETTLE_MS` (100 ms) so that focus changes already on their way reach the extension host, then calls `lockAndReturn`.
  - When the poll fails, the code logs "did not become active" once.
  - A `window.onDidChangeActiveTextEditor` listener sets `userEditor` when an editor becomes active that is neither the one active at the timeout nor the YAML in its column. The listener is disposed on every path: in `finally`, and through `GraphPanel.own()` when the panel or the registry is disposed (LATE_DISPOSED is silent).
- `lockAndReturn(…, userEditor)` is shared with the in-time path, which passes `() => false`. Right before `lockEditorGroup` it re-checks `userEditor()` and `inItsGroup(graph)`. If another editor became active, or the panel's group is no longer the active one, it skips both the lock and the focus return and logs that the group was not locked. The focus return checks `graph.isDisposed` before it reads `graph.panel.*`.
- The unlock guard from the first pass, which ran `unlockEditorGroup` after the lock, is gone. It could unlock a group the user had locked, or the wrong group. In its place are the re-check and the settle delay. Without the settle delay, LATE_USER_EDITOR fails every time: the user's `showTextDocument`, issued right after the reveal, has not reached the extension host when the re-check runs, so `lockEditorGroup` locks the user's group.
- `lockLateWindowMs` is a test seam (default `LATE_LOCK_WINDOW_MS`). With `0`, the poll's real expiry path runs: the predicate is checked once, before the reveal lands. The LATE_NEVER test checks that the line is logged exactly once, that focus does not move afterwards, that a later activation logs and locks nothing, and that the group is not locked.
- Observed while testing: on these hosts `onDidChangeActiveTextEditor` does not fire while the graph takes focus, and on 1.100 `activeTextEditor` can name the YAML while the graph has focus. So LATE_ACTIVE watches the panel's view state, and LATE_USER_EDITOR checks the panel and the active tab group rather than `activeTextEditor`.

## Plan Change Log

- 2026-10-12: an unlock guard after the lock, added for LATE_USER_EDITOR; later replaced (see below).
- 2026-10-12: `lockLateWindowMs` test seam and the LATE_NEVER test (coordinator's matrix audit).
- 2026-10-12 (review): the event-driven late check became one bounded poll; the unlock guard became a re-check of `userEditor` and `inItsGroup` before the lock, after a 100 ms settle delay; LATE_DISPOSED now asserts that nothing was locked.
- 2026-10-12 (floor run): the tests waited only for `open`, not for the late sequence, so on 1.100 the CURSOR test asserted while the graph still held focus. They now await `lockSettled`, a test seam on `GraphPanelHandle` that resolves once the panel's whole lock sequence has ended. `showGraph` (and so `withGraph`) and `autoOpened` await it.
- 2026-10-12 (stable run): F1_RACE and F11_LATE caught the real webview's late `snapshot` inside their windows. The helpers now also await `webviewReady`, a second test seam that resolves once the real webview's first `ready` has been answered or the panel is disposed. The helpers wait at most 30 s and then fail with a clear message. With 10 s, floor failed in about half of the combined 81/84/86 runs: the real webview's `ready` can take 10 to 30 s on 1.100 (AUTO once took 29 s). The seam also resolves as soon as the real webview's snapshot is recorded in `posted`, without waiting for `postMessage` to settle.
- 2026-10-13 (CI on 535afaf): the `webviewReady` wait is removed, because on CI 1.100 the real webview often never posts `ready`. In its place is a test seam, `GraphPanelsOptions.ignoreWebviewMessages`: the panel does not subscribe to `webview.onDidReceiveMessage`, so only the test's `receive()` drives the protocol. 86's `ownDiagnostics` (F1_RACE in both orders, F11_LATE) passes it. Strict tests on the production registry filter out `snapshot`, per LATE_SNAPSHOT; F8_BROKEN and 81's OTHER_FILE already did.

## Review Triage Log

Iteration 0 (quick). Verdicts: 1 high, 4 medium, 2 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `lockLate` only reacts to view-state events after it subscribes; a panel already active at the timeout (the CI diagnostic's state) is never locked or given back | high | patch | Real: the active event fired before subscription. The late path is now one bounded poll (`until(... inItsGroup ..., window)`). |
| 2 | No retry after the 500 ms group wait fails; events during `checking` are dropped | medium | patch | Same fix: the whole window is polled; `LATE_GROUP_WAIT_MS` removed. |
| 3 | `graph.panel.viewColumn` read after the awaited lock command with no disposed check | medium | patch | A disposed panel's getter throws, logging an error line; disposed checks added before every post-await read. |
| 4 | The post-lock unlock guard can unlock the user's own or the wrong group and log a false line | medium | patch | `unlockEditorGroup` acts on the active group. Guard removed; the late path skips lock and focus return when another editor became active, re-checked just before the lock command, after a 100 ms settle. |
| 5 | LATE_NEVER took a zero-window early return, never the real expiry | medium | patch | Early return removed; `lockLateWindowMs: 0` now expires through the poll. |
| 6 | LATE_USER_EDITOR can pass without reaching its scenario | low | reject | Test-strength only; forcing the order needs more machinery than the defect warrants. |
| 7 | LATE_DISPOSED does not assert "no lock" | low | patch | Placement check added (no column → group One, one tab group). |
| 8 | Acceptance criteria not evidenced | false | reject | Verification runs after review (below). |

Follow-up after the patches (full run, floor): the CURSOR test failed locally because the helpers returned before the late sequence ended; `lockSettled` (test seam) is awaited by `showGraph`/`autoOpened`. Then late real-webview snapshots flaked F1_RACE and F11_LATE on stable; `webviewReady` (test seam) is awaited too, bounded at 30 s because 1.100's first `ready` can take 10–30 s. No assertion was changed.

## Design Notes

A user who clicks the graph within 5 s of it opening, while the delayed reveal is still pending, can have focus returned to the YAML once. This is accepted: it's rare, and it's what the sequence does today when the reveal lands in time.

## Verification

**CI (2026-10-13):** run 38345523607 on c3617aa green on all 3 attempts (the push plus two reruns), stable and floor.

**Results after removing `webviewReady` (2026-10-13):** `npm run compile` exit 0; `npm test` 649 passing on stable and on floor; webview 146; corpus 123. CI on 535afaf: stable green 3/3, floor red 3/3 from the `webviewReady` wait, hence its removal.

**Earlier results (2026-10-13):** `npm run compile` exit 0; `npm test` twice, 649 passing on stable (1.141.0) and 649 on floor (1.100.0) both times (floor 3–4 min, up from 2, from the `webviewReady` waits); `npm run test:webview` 146; `npm run test:corpus` 123. CI: see the commit's runs.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` -- expected: all pass on stable and floor (645 or more).
- `npm run test:webview` and `npm run test:corpus` -- expected: unchanged counts (146, 123), all pass.
- After the push: CI green on the push and on two reruns (`gh run rerun`).
