---
title: 'A rename that overwrites a file keeps the wrong panel'
type: 'bugfix'
ticket: '17'
created: '2026-10-22'
status: 'built'
baseline_revision: '1d4d26978e24dd7680229d33216987741f858be9'
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

**Problem:** When a rename moves a config onto a file that already has a graph or test panel (an overwrite rename, or two renames in one batch landing on one name), both registries keep the overwritten file's panel and close the moved one. The moved file's content is what now sits at that name, so the wrong panel survives. With two movers onto one name, the winner depends on `Map` iteration order.

**Approach:** In both `renamed()` handlers the panel that moved wins a collision. The overwritten file's panel closes. Among several movers onto one name, the one whose last rename comes latest in the batch wins (renames apply in order, so its content is what ends up there). The state kept per key follows the winner.

## Boundaries & Constraints

**Always:**
- Graph (`src/adapters/graphPanel/panels.ts`): on a collision the panel already at `to` (not moved) is disposed and the mover takes the key. Its driving editor follows the mover: the overwritten file's `driving` entry goes, and the mover's `renamedDriving` entry is kept (today `collided` deletes it). `hidden` and `seen` for `to` take the mover's state.
- Test panel (`src/adapters/bloblangPanel/panels.ts`): a mover landing on a staying panel's key (same config, same processor path) takes the key, and the staying panel is disposed. The `dirty` set for the new key takes the mover's state.
- **Decision (user, 2026-10-22): every test panel of an overwritten config closes**, not only the one that collides. A config is overwritten when a rename in the batch lands on it and it is not itself moved away. Its panels describe content that is gone. (The graph is one per file, so an overwritten file's graph closes only when a moved graph takes its key; otherwise it stays and shows the new content, as today.)
- Two or more movers onto one key: the winner is the one whose last matching rename has the highest index in the batch. The others are disposed. The result is the same whatever the registry's insertion order.
- Swaps and chains (`b→c, a→b`; `a→t, b→a, t→b`) keep working as today: there, no mover lands on a staying panel.
- The `tabsChanged` skip for a pending rename's `to` (4.17) stays. Its comment now says the overwritten panel is closed by the rename, not kept.
- The existing suite 90 COLLISION test is rewritten for the new rule. Tests are added for the graph collision, two movers in either order, and the driving editor following the mover.

**Never:**
- Changing `renamedThrough`, `PendingRenames` or swap/chain handling.
- Changing how samples files move (`moveSamples`: when the target's samples file exists, both are left and the user is told).
- Protocol or webview changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| GRAPH_OVERWRITE | graphs open on a.yaml and b.yaml; rename a→b with overwrite | a's graph now titled b.yaml, keyed b; b's old graph disposed; driving editor is b.yaml's new editor | none |
| TEST_OVERWRITE | test panels on a.yaml and b.yaml, same processor path; rename a→b with overwrite | a's panel moves to b, b's old panel disposed; `panelFor(b, path)` is the moved one | none |
| OVERWRITTEN_OTHERS | b.yaml has test panels on processors[0] and [2]; a.yaml has one on processors[0]; rename a→b with overwrite | a's panel moves to b; both of b's old panels close | none |
| TWO_MOVERS | panels on a and c; one batch a→x, c→x (second with overwrite) | c's panel keyed x; a's disposed; same result when the panels were opened in the other order | none |
| SWAP_CHAIN | existing F7_RENAME swap and chain | unchanged | none |
| NO_COLLISION | rename onto a name with no panel | unchanged | none |

</frozen-after-approval>

## Code Map

- `src/adapters/graphPanel/panels.ts:342-401` `renamed()` -- today: staying panels go in first, a mover onto a taken key is disposed and its key goes into `collided` (which deletes its `renamedDriving`). Flip: work out the winner per `to` first (index of each mover's last matching rename), then dispose staying panels at a winner's key, delete their `driving` entries, and set `hidden`/`seen` for the key from the winner's old key.
- `src/adapters/bloblangPanel/panels.ts:1101-1135` `renamed()` -- `staying` set and `keyOf(uri, entry.path)`. Flip the same way: dispose the staying entry at the key (and its `dirty` entry), and pick one winner among movers to the same key.
- `src/adapters/bloblangPanel/panels.ts:1079-1094` `tabsChanged()` comment ("its panel stays: COLLISION closes the incoming one") -- update the wording.
- `src/adapters/graphPanel/tabs.ts:37` `renamedThrough` -- reuse as is. For the last-rename index, a small helper beside it (in tabs.ts) or a local loop is fine.
- `src/test/integration/suites/90-bloblang-panel.ts:2169` COLLISION test -- rewrite (the incoming panel stays, the one already there closes). `renameFile` helper at :1991.
- `src/test/integration/suites/86-graph-interactions.ts:~330-345` -- F7_RENAME batch helper using `WorkspaceEdit.renameFile(..., { overwrite })`; add the graph collision and two-mover tests here.
- Docs: `CHANGELOG.md` ("Fixed"); `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` rename-collisions entry (line ~8) left as history.

## Tasks & Acceptance

**Execution:**
- [ ] `src/adapters/graphPanel/panels.ts` -- the mover wins, last rename wins among movers, driving/hidden/seen follow -- the bug.
- [ ] `src/adapters/bloblangPanel/panels.ts` -- the same for test panels and `dirty`; the `tabsChanged` comment -- the bug.
- [ ] `src/test/integration/suites/90-bloblang-panel.ts` -- rewrite COLLISION; add OVERWRITTEN_OTHERS and TWO_MOVERS in both opening orders -- the matrix.
- [ ] `src/test/integration/suites/86-graph-interactions.ts` -- GRAPH_OVERWRITE (title, key, driving editor) and TWO_MOVERS -- the matrix.
- [ ] `CHANGELOG.md` -- a "Fixed" line.

**Acceptance Criteria:**
- Given the dev host with graphs and a test panel open on two configs, when one is renamed onto the other with "Replace" in the Explorer, then the panels of the moved file remain, titled with the new name, showing the moved file's content.
- Given the change, when compile, webview, corpus, the full stable suite (alone, `xvfb-run -a`) and suites 86 and 90 pinned (`taskset -c 0,1`) ×5 run, then all pass.

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 3 medium, 4 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `renameWinners` picks only among tracked keys: in `a→x, c→x` with panels only on `a`, `a`'s panels move onto `x`, which holds `c`'s content; in the test registry the result depends on stale `dirty` entries | medium | patch | Confirmed at `tabs.ts` (candidates = the passed keys) and `bloblangPanel/panels.ts:1109`. The intent ("its content is what ends up there") has one reading; the helper's "last rename index" rule only approximates it. Fix: simulate the batch per key (a key's content is destroyed when a later rename lands on its current place, or a folder holding it, without moving it); a key wins only if it survives. |
| 2 | Ties: `a→b, b→c` gives `a` and `b` the same last index, so the winner is the first key iterated | medium | patch | Confirmed (strict `>`). Same root as 1, fixed by the same simulation (`b` is destroyed at step 0). |
| 3 | The overwritten file's driving editor survives when `renamedDriving[b]` holds the mover's column (`adopted` is true for the wrong reason) | low | patch | Confirmed at `graphPanel/panels.ts:388-395`; transient until adoption. Fix: count as adopted only when `driving[key]` sits in the kept column. |
| 4 | A graph disposal outside `renamed()` (TAB_CLOSE of the overwritten file before the rename is reported; a losing mover's dispose) deletes the winner's kept column | medium | patch | Confirmed: graph `tabsChanged` (`:325-333`) has no `creating` skip, unlike the test registry's, and `onDidDispose` (`:600-603`) deletes `renamedDriving[current]`. Fix: add the `creating` skip to graph `tabsChanged`; keep the save/restore around every disposal in `renamed()` (losers too). |
| 5 | No unit tests for the new pure helpers | low | patch | `src/test/adapters/graphPanel/tabs.test.ts` tests `renamedThrough`; add cases for the winners/overwritten helper (tie, order independence, folders, untracked later rename). |
| 6 | Moved test panels read the overwritten config's samples file (`moveSamples` returns `exists`) | low | defer | Real, exposed by the change, but the approved plan's Never excludes changing how samples files move. Deferred. |
| 7 | `dirty`, `hidden`, `seen` following the winner are untested | low | patch | No test exercises `follows()` or the `dirty` filter. Add one graph `hidden` case and one test-panel `dirty` case. |
| 8 | ACs that need runs not verified | false | reject | The implementer ran every command (881 full; 100 ×5 pinned); the manual check is the user's. |
| AI-4 | `clickSelects` (86:375-377) reads `activeTextEditor` right after `receive`, without waiting for it | low | patch | Confirmed. Wait until `activeTextEditor` is the target before asserting. |

Resumed review (quick, 2026-10-23, on the patched tree). Verdicts: 0 high, 0 medium, 3 low, 0 false. No row repeats an iteration-0 row.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| R1 | The visible-editors handler keeps a column for every key a pending rename moves, a destroyed one too, so with two movers the last write (Map order) decides | low | patch | Real in the code: it used `renamedThrough` with no survival check. Not reachable through VS Code's own events in `a→x, c→x`: VS Code closes the renamed editors one event at a time in rename order, so the winner's write comes last (checked by running the test with the guard removed: still passes). Fix (direct correction): skip keys `renameFate` marks destroyed. |
| R2 | Graph TWO_MOVERS does not vary the driving order nor check the driving column | low | patch | Confirmed. The test now drives the editors in the opening order, keeps each group with a second tab (VS Code otherwise collapses emptied groups and renumbers columns), and checks the click selects x in the winner's column. |
| R3 | Suite 90 TWO_MOVERS reaches the test registry as two single-rename events, not one batch | low | reject | Confirmed (VS Code 1.100–1.141 reports each rename of a WorkspaceEdit separately). The batch path is covered by the `renameWinners` / `overwrittenBy` unit tests; a batched seam for the test registry adds surface for a coverage gap only. |
| R4 | A hidden file renamed onto a file with an open graph marks that name hidden while its graph stays open | low | defer | Confirmed and pre-existing (`follows` with empty `winners` = the old re-keying). The plan keeps the overwritten file's graph when no graph moved. Deferred. |


## Verification

**Commands:**
- `npm run compile`; `npm run test:webview`; `npm run test:corpus` -- expected: all pass.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `taskset -c 0,1 xvfb-run -a npx vscode-test --label stable --grep "<suite 86 and 90 titles>"` ×5, one run at a time -- expected: all pass.

## Implementation Notes

- The winner rule is a per-key simulation of the batch (`renameFate` in `tabs.ts`): each rename that moves the key's current place moves it; one that lands on its current place (the file, or a folder holding it) without moving it destroys its content. `renameWinners` keeps, per new name, the moved key that survives (at most one), so the result depends neither on the keys' order nor on which keys are tracked (`a→x, c→x` with a panel only on `a`: `a` loses; `a→b, b→c`: `a` wins at `c`, `b` is destroyed). `overwrittenBy` is "destroyed and not moved". This replaced a first "last rename index" rule after review.
- Losing movers close all their test panels (their content is gone), not only the one on the colliding key.
- Graph: TAB_CLOSE now also skips a file a pending rename creates (as the test registry does), so the overwritten file's graph is closed by the rename, not by its tab closing first. Every disposal in `renamed()` (overwritten and losing graphs) keeps the column kept for the disposed graph's name (`disposeKeepingColumn`). A `driving` entry counts as adopted for the batch only when its editor is in the kept column; otherwise, at a name a moved graph took, it is the overwritten file's and goes.
- `hidden` / `seen` at a name a moved graph took take the winner's state (`follows`); the test registry's `dirty` drops overwritten configs and losing movers.
- Test seam `BloblangPanels.hasUnsavedChanges(uri)` for the dirty case. Found on the way, not fixed (out of scope): the test registry's dirty set misses an edit's dirty state, since VS Code marks the document dirty after the content-change event and the later no-content event is ignored; only a panel opened on an already dirty document records it.
- Tests: `tabs.test.ts` (collision helpers); suite 86 GRAPH_OVERWRITE (with a tab, and with no text tab), GRAPH_OVERWRITE_HIDDEN, TWO_MOVERS ×2, `clickSelects` waits for the selection; suite 90 COLLISION rewritten, OVERWRITTEN_OTHERS, OVERWRITTEN_DIRTY, TWO_MOVERS ×2.
