---
title: 'The graph follows a file through Save As'
type: 'feature'
ticket: '12'
created: '2026-10-26'
status: done
baseline_revision: '172c14f060c8d9c6b6f8baeba6c056896aa165ba'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** VS Code has no Save As event, so after a Save As the old file's graph closes with its tab, the new file auto-opens a fresh graph (losing pan, zoom and collapsed groups), and the old file's Hide stays behind (AD-1 says per-file registries follow Save As; 3.10 did only renames).

**Approach:** The graph registry recognises a Save As from what VS Code reports (probed on 1.141.0, 2026-10-26, saved and untitled files alike): the new file is created and saved (`onDidCreateFiles`, `onDidSaveTextDocument`), then a text tab for it opens in a group at the old tab's place, so the tab just after it is the old one, which closes in a later event. When such a tab opens, the next tab in its group is a candidate source; when that tab then closes within a second, with the new tab still open, the old file was saved as the new one (a file merely opened beside another leaves its neighbour open): its open graph panel moves to the new file (key, title, driving column; pan, zoom and collapsed groups stay with the panel), the new file gets the old one's Hide and session memory (no second graph auto-opens), and the old tab's close then closes nothing.

**Decisions (user, 2026-10-26):**
- The old file keeps its Hide and session memory: they are copied to the new file, not moved (a saved old file still exists).
- Only the graph follows; Bloblang test panels close with the old tab, as today.
- ~~Manual checks on VS Code 1.141.0 and 1.140.0 only.~~ Superseded (user, 2026-10-26): manual checks on VS Code 1.143.1, the target version.
- (After review, 2026-10-26.) No text check: VS Code reverts the old document after a Save As, so a source with unsaved edits would not match. The old tab closing right after the new one opens is the signal instead.

## Boundaries & Constraints

**Always:**
- A Save As needs all of: the new URI was created and saved within the last 2 s before its tab opened; its tab's next tab in the same group is a text tab of another URI (the source); the source's tab closes within 1 s after the new tab opened, while the new tab is still open. It is applied in the event that closes the source's tab, before TAB_CLOSE. Anything else is not a Save As, and today's behaviour holds (graphs close with their last tab, auto-open as before).
- The new file's auto-open waits until its candidate is settled (Save As or not), and a settled Save As target never auto-opens, however late the queued auto-open runs (no timer decides it).
- Renames (3.10, ticket 17) work as today.

**Never:**
- Moving Hide or session memory away from the old file; touching test panels or samples files; re-keying on a tab swap that is not a Save As (a file opened beside another, a preview replaced, a reopen).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SAVED | a.yaml with its graph; Save As b.yaml | the same panel follows b.yaml, title "Graph: b.yaml", no second graph; a.yaml's tab close closes nothing | none |
| UNTITLED | an untitled detected document with its graph; saved as c.yaml | the panel follows c.yaml | none |
| HIDE | a.yaml hidden (no graph); Save As b.yaml | b.yaml is hidden and does not auto-open; a.yaml stays hidden | none |
| SEEN | a.yaml shown this session, its graph closed by the user; Save As b.yaml | b.yaml's graph does not auto-open | none |
| DIRTY | a.yaml with unsaved edits and its graph; Save As b.yaml (VS Code reverts a.yaml before the tab swap) | as SAVED | none |
| NOT_SAVE_AS | a new file created (no save) and opened beside a.yaml; or created and saved and opened before a.yaml, which stays open; or its tab is not just before a.yaml's | a.yaml's graph is not moved, closes with its own tab as today | none |
| STALE | a created-and-saved file whose tab opens more than 2 s later | not a Save As | none |
| RENAME | an Explorer rename with a graph open | as today (3.10) | none |

</frozen-after-approval>

## Code Map

- `src/adapters/graphPanel/panels.ts` -- `GraphPanels`: `panels` (by `uri.toString()`), `seen`, `hidden` + `storeHidden()` (memento), `driving` / `renamedDriving` / `adoptRenamedDriving` (the driving editor follows a renamed file by its column), `tabsChanged()` (TAB_CLOSE, wired as `onDidChangeTabs(() => this.tabsChanged())`, event ignored today), `renamed()` (3.10: re-key, title via `graphTitle`, moves `seen` / `hidden` with `follows`; do not reuse its move semantics for Save As), `updateContext()`, `options.detection.markDetected`.
- `src/adapters/graphPanel/tabs.ts` -- tab helpers (`hasTextTab`, `isTextTabOf`, `openDocument`). Put the pure Save As rule here (a candidate when the opened tab's URI was created and saved recently and a next tab exists; confirmed when that source tab closes within 1 s, the new tab still open).
- `src/test/adapters/graphPanel/tabs.test.ts` -- unit tests for the pure test.
- `src/test/integration/suites/86-graph-interactions.ts` -- graph integration helpers (`openIn`, `drive`, `clickSelects`, `testPanels`). A real Save As needs a dialog: simulate it with real events. VS Code opens a tab after the active one (`workbench.editor.openPositioning`: right), so: a filler tab, then a.yaml with its graph, the filler active again, then `WorkspaceEdit.createFile` b.yaml with a.yaml's text, save it, show it (it opens between filler and a.yaml), close a.yaml's tab.
- Docs: `README.md` graph paragraph ("**Save As** is not followed: …"); AD-1 in `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` (how Save As is recognised, copy semantics); `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/graphPanel/tabs.ts` -- the pure Save As test -- the rule, without VS Code.
- [x] `src/test/adapters/graphPanel/tabs.test.ts` -- SAVED, UNTITLED, NOT_SAVE_AS (no save; no next tab or the same URI; the source stays open, another tab closes, the new tab closed first, the close too late), STALE.
- [x] `src/adapters/graphPanel/panels.ts` -- remember created and saved URIs with their time; on each tab change, before TAB_CLOSE, run the test for the opened text tabs and apply a Save As (move the panel, its title and driving column; copy `hidden` (stored) and `seen`; `markDetected` the new URI when a graph moved) -- the behaviour.
- [x] `src/test/integration/suites/86-graph-interactions.ts` -- SAVED and HIDE / SEEN simulated as in the Code Map; NOT_SAVE_AS; RENAME still passing.
- [x] Docs -- README, AD-1, CHANGELOG.

**Acceptance Criteria:**
- Given a detected file with its graph in VS Code 1.143.1, when the user runs File: Save As to a new path, then the same graph panel follows the new file, with its title updated, its pan, zoom and collapsed groups kept, and no second graph opens.
- Given an untitled detected document with its graph, when it is saved for the first time, then the graph follows the saved file.
- Given the change, when compile, the unit suites, suite 86 and the full stable suite run, then all pass.

## Implementation Notes

Iteration 0 (superseded by the Plan Change Log; its code was set aside, the KEEP list carries what stays):

- `isSaveAs` (tabs.ts) is the pure rule; `GraphPanels.savedAs` runs it on `onDidChangeTabs`'s `opened` tabs before TAB_CLOSE, with `recentFiles` fed by `onDidCreateFiles` / `onDidSaveTextDocument` (pruned past 2 s).
- VS Code may report the new file's visible editor before its tab: a queued auto-open of a file created and saved in the window waits up to 0.5 s (`SAVE_AS_TAB_WAIT_MS`) for its tab to be tested, and opens nothing when it was a Save As (the graph moved, or the copied Hide / session memory say no).
- The driving column is the column of the new tab's group (kept through `renamedDriving`, adopted when the editor is visible). The moved panel recomputes its node status for the new URI.
- Manual checks on 1.141.0 / 1.140.0 with a real File: Save As (SAVED, UNTITLED, HIDE) were not run by the implementing agent.

Iteration 1:

- The rule is two pure steps in `tabs.ts`: `isSaveAsCandidate` (opened tab created and saved within `SAVE_AS_WINDOW_MS` = 2 s, next tab a text tab of another URI) and `confirmsSaveAs` (a closed tab of the candidate's source, within `SAVE_AS_CLOSE_MS` = 1 s of the open, the new tab still open; `saveAsExpired` past it). No text check.
- `GraphPanels`: `onDidChangeTabs` runs `saveAsOpened(e.opened)` (records candidates with the new tab's column), then `saveAsClosed(e.closed)` (confirms and runs the kept `applySaveAs`), then `tabsChanged()` (TAB_CLOSE). Candidates are dropped when expired or when the new tab is gone.
- Auto-open guard: a queued auto-open of a URI that is created-and-saved with no tested tab yet, or has an unsettled candidate, waits (bounded by 0.5 s + 1 s) until that settles; a confirmed target goes into `saveAsTargets`, a session set (cleared on dispose), so a late auto-open never opens it, with no timer involved.
- Suite 86 `SAVE_AS (ticket 12)`: SAVED, HIDE, SEEN, and NOT_SAVE_AS for: created not saved (source closed at once), created and saved with the source left open past 1 s, created and saved not just before the source (source closed at once). DIRTY is not simulated (closing a dirty tab prompts); it holds because no text is compared.
- Manual checks on 1.141.0 / 1.140.0 with a real File: Save As (SAVED, UNTITLED, HIDE, DIRTY) were not run by the implementing agent. The automated suite runs on the `stable` label (1.143.1 here).
- Review fixes (iteration 1): `applySaveAs` closes any graph of the new file other than the moved one, whether or not the old file had a graph (an auto-open whose wait ran out keeps no graph of a Save As target); the panel moves only when the old file has no text tab left after the close (VS Code replaces the source in one group only), while the Hide / session-memory copy and the Save As target still apply; when a graph moves, the new path's Hide becomes the old file's (set or removed, stored when changed), as `renamed()` does; without a moved graph the copy rule holds. Suite 86 adds EXTRA (the new file's graph opened before the confirmation), OTHER_GROUP (the old file open in a second group keeps its graph) and STALE_HIDE (a stored Hide of the new path goes when a graph moves onto it).

- Found in the manual check on 1.143.1 (2026-10-26): an untitled config with no graph (a new Ctrl+N file, which never auto-opens), saved as `d2.yml`, got no graph at all: its session memory was copied and the target blocked auto-open. Now an untitled file's session memory is not copied, and the new file is a Save As target (no auto-open, an extra graph closed) only when a graph moved or the old file's Hide or session memory was copied (`applySaveAs` returns it). Suite 86 UNTITLED_NO_GRAPH (fails without the fix). Full stable suite: 934 passing.

- Follow-up (bug 21, 2026-10-26): pinned to two CPUs, the HIDE test failed once in 5 runs: the simulated Save As (create, fill, save, show) took longer than the 2 s window, so it was not recognised (VS Code's own takes about 50 ms). `GraphPanels` takes test-only `saveAsWindowMs` / `saveAsCloseMs` (defaults `SAVE_AS_WINDOW_MS` / `SAVE_AS_CLOSE_MS`); the pure rule functions take the windows as optional parameters. Suite 86's Save As registry uses 10 s and 3 s; "a stays open" waits past 3 s. Suite 86 pinned to 2 CPUs, 8 runs: all passing; full stable suite 936 passing.

## Plan Change Log

- 2026-10-26, review iteration 0 → 1 (intent gap, user decision). Trigger: review finding 1, VS Code reverts the source after a Save As, so the text-equality check fails for a source with unsaved edits (the common flow). Amended: Approach, Decisions, Always (the source's tab must close within 1 s; no text check; the auto-open guard without a timer), the matrix (DIRTY; NOT_SAVE_AS cases). Known-bad state avoided: an edited file's Save As closing its graph and auto-opening a new one; a late queued auto-open of a Save As target (review finding 2). KEEP: `recentFiles` fed by `onDidCreateFiles` / `onDidSaveTextDocument` with the 2 s window; checking `onDidChangeTabs` `opened` tabs before TAB_CLOSE and taking `tabs[index + 1]` as the source; `applySaveAs` (panel key, title, `hadTab`, the driving column through `renamedDriving` + `adoptRenamedDriving`, `markDetected`, `diagnosticsChanged`, copy `seen` and `hidden` + `storeHidden`, the fallback dispose of an extra graph of the new file); the auto-open wait for a just created-and-saved file; the suite 86 `SAVE_AS (ticket 12)` harness (filler tab, create + save + show between, close the source) and its SAVED / HIDE / SEEN tests; README / AD-1 / CHANGELOG text (to be narrowed: a Save As to a new file, as VS Code reports it). The iteration-0 diff, for the KEEP parts: `/tmp/claude-1000/-home-aleksejjurcenko-projects-clients-personal-rpcn-vscode-byoc-plugin/cf2dba31-2df8-4766-8461-f71d207a6c82/scratchpad/story12-iteration0.diff`. Also from review: test a created-and-saved tab not just before the source, and a source that stays open (finding 3); docs state the conditions (finding 4).

## Review Triage Log

Iteration 0 (quick). Verdicts: 1 maybe-false (high if true), 1 medium, 2 low.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | VS Code reverts the source after a Save As, so the text-equality check fails for a source with unsaved edits (edit, then Save As) | maybe-false (high) | intent gap | Recalled from VS Code's source, not observed; the user chose to drop the text check: the source's tab closing within 1 s is the signal (Plan Change Log). Loopback to iteration 1. |
| 2 | A queued auto-open could run after the 2 s memory expired and open a second graph (SEEN) | medium | intent gap (with 1) | Folded into iteration 1's Always: Save As targets are kept for the session. |
| 3 | "Not the next tab" untested | low | carried to iteration 1 | Tested there (NOT_SAVE_AS, a tab in between). |
| 4 | README / CHANGELOG promised more than the rule | low | carried to iteration 1 | Docs state the conditions. |

Iteration 1 (quick). Verdicts: 0 high, 2 medium, 2 low, 1 noted.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The auto-open wait can run out before confirmation; the extra graph was disposed only when the old file had a graph, so in HIDE / SEEN it stayed open | medium | patch | Any other graph of the new file is disposed on confirmation; EXTRA test (fails without the fix). |
| 2 | The graph moved when one tab of the old file closed though it stays open in another group | medium | patch | Moves only when the old file has no text tab left; Hide / memory still copied; OTHER_GROUP test; README says so. |
| 3 | A Hide stored earlier for the new path survived a moved graph | low | patch | A moved graph takes the old file's Hide state (as `renamed`); STALE_HIDE test. |
| 4 | Real Save As (AC 1, AC 2), UNTITLED integration and DIRTY not verified | low | noted + patch | DIRTY simulated (a edited, reverted before the swap, b keeps the edit): passes. Real Save As, UNTITLED and pan / zoom are the manual checks on 1.141.0 and 1.140.0. |
| 5 | The plan's task list still named the removed text check | low | patch | Fixed. |

Matrix audit (full stable suite 932 passing, then suite 86's Save As tests 10 passing with DIRTY): SAVED, DIRTY, HIDE, SEEN, NOT_SAVE_AS (three ways) in suite 86; UNTITLED and STALE in `tabs.test.ts` (unit); RENAME by the existing rename tests: all ran and passed.

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "adapters/graphPanel|Pipeline graph: interactions"` -- expected: all pass.
- `xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.

**Manual checks:**
- Dev host on 1.143.1 (the target version, `.vscode-test/vscode-linux-x64-1.143.1`): SAVED, UNTITLED, DIRTY and HIDE with real File: Save As.
