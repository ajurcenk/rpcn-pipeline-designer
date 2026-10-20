---
title: 'Refactor sweep'
type: 'refactor'
ticket: '13'
created: '2026-10-17'
status: 'built'
baseline_revision: 'b602126aec1d73df1a923107f2435d668a2c6bd4'
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

**Problem:** The epic left deferred findings, and two of them keep `main`'s CI unreliable:
- The graph reopens a closed YAML on every webview `ready`, which keeps it open for minutes. This makes CLOSE_UNSAVED + WITH_GRAPH flaky.
- The test panel's placement can lose the YAML's focus after creating its group. PLACE_WITH_GRAPH failed on stable in CI with "focus is back in the YAML".
- `pendingRenames` (graph and test panels) and the graph's `renamedDriving` leak when a rename is announced but never reported (backlog story 14 for the graph).

**Approach:** Cleanup only, with three fixes and their tests. The other deferred findings move to named tickets or close as won't-fix (decision below).

**Decision (user, 2026-10-17):** scope as proposed.
- **Fixed here:**
  1. no reopen on `ready`;
  2. expiring pending renames in both registries;
  3. the placement focus race.
- **Moved to backlog:**
  - the rename-overwrite panel bug (backlog bug 17);
  - the 300 ms graph-marker blink (backlog story 18).
- **Closed:** the 3.7 CURSOR flake on the 1.100 floor is won't-fix (the floor is out of scope and non-blocking in CI).

## Boundaries & Constraints

**Always:**
- **No reopen on `ready`:**
  - On the webview's `ready`, the graph uses its document only if it is already open (`openDocument(key)`). It never calls `openTextDocument` there.
  - **Document closed:** the graph posts a snapshot from its last model and status, when it has one. With no last model it posts nothing, and the panel closes with its last tab as today (TAB_CLOSE).
  - **Other uses:** they keep their current behaviour.
  - **Test:** suite 86 F6_DISPOSE is reworked for the new premise, keeping its intent (Hide while `ready` is pending disposes cleanly).
  - **Workaround:** suite 90's `maybeGraph().settled()` workaround (4.12) is removed and CLOSE_UNSAVED + WITH_GRAPH still passes.
- **Expiring pending renames:**
  - **Shared helper:** one helper in `src/adapters/graphPanel/tabs.ts` keeps announced renames for both registries. An entry is removed when its rename is reported, or 30 s after its announcement, whichever comes first.
  - **Graph:** `renamedDriving` entries that are still unreported are dropped at the same time.
  - **After an entry goes:** tab close and auto-open behave as if no rename had been announced; for the test panels, so do tab close and the 4.10 close reset.
  - **Tests:** unit tests use a fake clock. Suites 84, 86 and 90 keep their rename tests green. A new integration test per registry announces a rename that is never reported, then shows tab close working after the expiry (through a test seam for the time limit).
  - **Backlog story 14** is resolved by this fix and is marked done.
- **Placement focus:**
  - After a test panel is created, focus returns to the YAML's group.
  - **Confirmation:** the registry then waits, up to 1 s, for `activeTextEditor` to be the YAML in that group. If it isn't, it returns focus once more and waits again. A miss after that is logged, not thrown. This is the bug-15 pattern from the graph's lock sequence.
  - **Test:** PLACE_WITH_GRAPH's assertions stay unchanged.
- **Deferred-work closure:** each entry this ticket handles gets a `resolution:` line in `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md`: fixed by 4.13, moved to backlog 17 or 18, or won't-fix for the floor.
- **Docs:** AD-1 is amended where it states the reopen, pending-rename and placement rules; CHANGELOG ("Fixed").
- **Tests:** at least as many tests as before (the ticket's Verify).

**Never:**
- behaviour changes beyond the three fixes;
- the rename-overwrite bug or the marker blink (backlog);
- work on the 1.100 floor;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| READY_OPEN | `ready` with the YAML open | snapshot as today | none |
| READY_CLOSED | `ready` after the YAML's document closed | snapshot from the last model, or none; the document stays closed | none |
| CLOSE_UNSAVED_GRAPH | suite 90 test without the settle workaround | passes | none |
| RENAME_OK | rename announced and reported | as today | none |
| RENAME_NEVER | announced, never reported | after the time limit, the last tab closes the panel (graph and test panel); auto-open works for the new name | none |
| PLACE_FOCUS | test panel created below the graph | YAML active in its group, confirmed or retried once | logged on a second miss |
| CLOSURE | deferred-work.md | each handled entry has a resolution | none |

</frozen-after-approval>

## Code Map

- `src/adapters/graphPanel/graphPanel.ts`:
  - `ready` at 116-117 calls `postSnapshot(await this.document())`.
  - `document()` at 396-400 (`openDocument(key) ?? openTextDocument(uri)`).
  - `postSnapshot` at 140-168 and its model fallback `lastModel` at 152.
  - `state()` 407-415 and `computeStatus` need a document-free path for the last-model snapshot.
- `src/adapters/graphPanel/tabs.ts`:
  - `openDocument` 71-74, `Rename` 6, `renamedThrough` 37;
  - add the pending-rename helper, with a clock seam;
  - unit tests in `src/test/adapters/graphPanel/tabs.test.ts`.
- `src/adapters/graphPanel/panels.ts`:
  - `pendingRenames` 153: added at 227-229, removed at 333; read at 216, 291 and 319;
  - `renamedDriving` 160: set at 218 and 370, deleted at 378, 401, 548 and 778;
  - `adoptRenamedDriving` 395-405;
  - the lock's bounded focus poll at 680-690 is the model for the placement fix.
- `src/adapters/bloblangPanel/panels.ts`:
  - `pendingRenames` 930: added at 1003-1005, removed at 1039; `renaming()` 1011-1013, the reset skip at 986, `tabsChanged` 1025;
  - `open()` 1305-1359: `returnTo` at 1349-1350, then `showTextDocument`. Add the confirm-and-retry there.
  - `placement()` 1366-1393.
- `src/adapters/graphPanel/groups.ts:56-76` -- `newGroupNextTo`, unchanged unless the fix needs it.
- Tests:
  - `src/test/integration/suites/86-graph-interactions.ts:158` -- F6_DISPOSE;
  - `90-bloblang-panel.ts` -- `maybeGraph` 1341-1369 and `settled()` 1355-1367 (remove it), CLOSE_UNSAVED 1729/1753, PLACE_WITH_GRAPH 1992-2017;
  - suites 84 (RENAME 369, TAB_CLOSE 341) and 86 (F7_RENAME 243).
- `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md`:
  - renamedDriving leak at 3-5;
  - collisions at 6-8, which move to backlog 17;
  - CURSOR floor at 9-12 and 14-16, won't-fix;
  - pendingRenames at 33-35;
  - reopen on `ready` at 37-39.
- Docs:
  - `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` AD-1;
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] Graph `ready` without reopening + F6_DISPOSE rework + the `settled()` workaround removed.
- [x] Pending-rename helper in `tabs.ts`, used by both registries, plus unit and integration tests.
- [x] Placement focus confirm and retry.
- [x] `deferred-work.md` resolutions; AD-1; CHANGELOG.

**Acceptance Criteria:**
- Given the change, when `npm run compile`, the stable suite under `xvfb-run -a` (run alone, three times in a row), `npm run test:webview` and `npm run test:corpus` run, then all pass, with at least as many tests as before.
- Given the push, when CI runs, then the stable step and the corpus harness pass.

## Implementation Notes

- `ready` uses `openDocument(key)`; with the document closed, `postSnapshot(undefined)` sends the last model (with the current catalogue, else `null`), whatever node status the panel holds (normally none once the file closed) and the last selection, leaving `modelCatalogue` unchanged, no parse error; nothing when there is no last model. `activate` / `selectParseError` still use `document()` (unchanged).
- `PendingRenames` (`tabs.ts`) prunes lazily: on `announce`, `report`, `all` / `renaming` / `creating` and an explicit `prune()` (the graph calls it at the start of its visible-editors handler, before `adoptRenamedDriving`). Expired renames go to `onExpired`; the graph drops the unreported `renamedDriving` entries under their new names. Expiry does not re-run `tabsChanged`: a tab closed while the rename was still pending stays skipped (no behaviour beyond the fix).
- RENAME_NEVER integration tests announce through a swapped `workspace.onWillRenameFiles` while the test's own registry is built (the F7_RENAME pattern); seam `pendingRenameMs` on both registries' options.
- Placement: `BloblangPanels.returnFocus` shows the YAML in `returnTo`, waits up to 0.5 s (`until`) for `activeTextEditor` to be that document in that column, then 100 ms more and re-checks (a late focus steal), retries once, then logs "Test mapping: focus did not stay in the YAML.".
- F6_DISPOSE's first test now hides while `ready`'s snapshot post is awaited and asserts only that snapshot was posted.
- Backlog story 14 got `status: done` and a resolution note.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 2 medium, 4 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `returnFocus` stops at the first successful poll, so a late focus steal (the PLACE_WITH_GRAPH failure) is never seen, retried or logged | medium | patch | `until` returns on the first true. Now it settles and checks again (`lockLate` pattern), retries once, and logs on a second miss. |
| 2 | A 30 s expiry from `announce` can fire before a slow but completing rename (participants may take up to 60 s), so panels are disposed instead of moved | low | reject | Rename participants that take over 30 s are rare, and 30 s is the frozen value. Raising it to fit `files.participants.timeout` would need the user to renegotiate. |
| 3 | The RENAME_NEVER tests have no control showing the announcement took effect | low | patch | They now assert that the rename blocks before the limit and lets go after it. |
| 4 | READY_CLOSED is untested, and F6_DISPOSE no longer covers a dispose race | medium | patch | Graph test added: `ready` after the document closed sends the last model and keeps the document closed; with no last model, nothing is posted. |
| 5 | `postSnapshot(undefined)` records the current catalogue for an older model, which can skip a later rebuild | low | patch | `modelCatalogue` is left alone for document-less snapshots. |
| 6 | CHANGELOG and AD-1 say "markers"/"frozen node status", but node status is normally empty after the document closes | low | patch | Reworded. |

## Verification

**Results (2026-10-19, after the review patches):** `npm run compile` exit 0; full stable suite under `xvfb-run -a`, three runs in a row alone: 849, 849, 849 passing (841 before), and 849 again after the investigation cleanup; `npm run test:webview` 288; `npm run test:corpus` 156. Manual check step 1 (the user): placement below the graph with the YAML focused, no issues. The graph canvas looked empty there; investigation found it pre-existing (the graph is not refitted when the split halves its height; same on b602126), now bug entry 19. Steps 2 and 3 (the user): panels close with the last tab, and a rename keeps the graph and test panels open: no issues.

**Commands:**
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (three times in a row, alone); `npm run test:webview`; `npm run test:corpus` -- expected: all pass.
