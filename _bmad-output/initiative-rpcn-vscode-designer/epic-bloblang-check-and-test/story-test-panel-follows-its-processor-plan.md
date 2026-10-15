---
title: 'Test panel follows its processor'
type: 'feature'
ticket: '10'
created: '2026-10-15'
status: 'built'
baseline_revision: 'bba254797ff2d2af5c7e760dc079338be5358e4d'
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

**Problem:** A test panel finds its processor only by the YAML path it opened with. An insert above, a reorder or a changed label points it at the wrong processor or at none. A deleted processor leaves the panel showing stale Bloblang, and a label typed by hand never moves the samples (E4 R8, AD-22).

**Approach:** Each panel tracks its processor across document changes: by its label while that label still exists, else by its position mapped through the edits. Its key, path and title follow. Samples are relinked to the new label or path when the YAML is saved. A processor that can't be found puts the panel in a removed state that recovers when the processor comes back.

**Decisions (user, 2026-10-15):**
- the split with 4.17 (tabs, rename, placement);
- a label change is relinked in the samples file on save, not while typing;
- a deleted processor shows a removed state, and the panel is not closed.

## Boundaries & Constraints

**Always:**
- **Tracking (host; decision, user, 2026-10-15, after review iteration 0):**
  - **Range mapping:** on each change to the panel's document, the panel's processor range is mapped through the event's `contentChanges`, all in pre-change coordinates. The start stays left (a change containing it moves it to the change's start). The end stays right (a change containing it moves it to the change's new end).
  - **Broken YAML:** while the document doesn't parse (YAML errors), nothing is matched again. Panels keep their processor, title and state, as the graph does (AD-17), and ranges keep mapping. Matching runs again on the first change that parses.
  - **Matching, all panels of the document together, one panel per processor:**
    1. **Overlap:** each panel takes the processor of the same kind whose range overlaps its mapped range most, taking the best overlaps first.
    2. **Label:** a panel with no overlap takes the unclaimed processor with its label, if any.
    3. **Removed panels:** each takes the unclaimed processor with its last label. Failing that, it takes an unclaimed processor with the same kind and Bloblang, nearest its last path.
    4. **Otherwise:** the panel is removed.
  - **When found:** the panel's path, label, range and key (`uri#path`) update, and so does its title (`Bloblang: <label ?? path>`). A snapshot is posted when the title, kind, source or removed state changes. Diagnostics, the hint and the Test mapping command find the panel under its new key.
  - **Closed without saving:** when the panel's document closes, each panel resets to its samples link (the saved label or path) and is matched by that link when the document opens again.
- **Removed state:**
  - **Trigger:** matching finds no processor. The panel keeps its last path, label, kind and source.
  - **What shows:** the header stays. "This processor was removed from <file>. Undo the change to bring it back." replaces the toolbar and columns.
  - **Kept:** the input and samples stay.
  - **Cleared:** nothing runs, the hint clears, and the last result is cleared (as entering the no-binary state does).
  - **Recovery:** per matching step 3. The panel returns to normal and runs once, under Run on change rules.
- **Samples relink (on save of the panel's document, all of that config's panels in one step):**
  - **Move:** each panel whose processor's link (its label, else its path) differs from its samples link has its entry moved to the new link, with its samples and `selected` (label/path → label/path).
  - **Order:** the moves are applied so that one move freeing a link lets another take it.
  - **No entry:** the link just follows; nothing is written.
  - **Taken link:** a link still taken by another entry or another live panel doesn't move. The error "Couldn't move the samples to <link>: samples already use it." is shown, and the panel keeps its old link.
  - **Never shared:** two live panels never share a samples link.
  - **After a relink:** every panel of the config gets the file's `samples`.
  - **Before the save:** a panel keeps showing its samples under its old link, and the "no label" note names that link's path.
  - **Add label:** 4.16's Add label keeps its own immediate relink.
- **Graph:** behaviour with the graph open is unchanged. Both follow the same document; no graph code changes.
- **AI-8:**
  - AD-1 (the key follows the processor), AD-22 (relink on save) and AD-5 (the snapshot field) are amended;
  - EXPERIENCE gains rows for following and the removed state;
  - CHANGELOG is updated.

**Never:**
- closing with the tab, following a file rename, or panel placement (4.17);
- rewriting the samples file while typing;
- protocol changes other than one optional `removed?: true` on `snapshot`;
- graph changes;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| EDIT_ABOVE | lines typed above the processor | same processor; key unchanged; no snapshot unless something shown changed | none |
| INSERT_BEFORE | a processor inserted before it | path `[1]`→`[2]`; key and title follow; runs use it | none |
| REORDER_LABELLED | labelled processor cut and pasted elsewhere | found by label; path follows | none |
| LABEL_TYPED | label `a` edited to `b` | title `Bloblang: b`; samples still shown; on save the entry moves to `b` | none |
| LABEL_REMOVED | label deleted, saved | title shows the path; the entry moves to the path link | none |
| UNLABELLED_SHIFT_SAVE | unlabelled, insert above, save | the entry moves from the old path to the new one | none |
| RELINK_TAKEN | the target link already has samples | nothing moves; the error shown | none |
| DELETED | processor deleted | removed state; nothing runs; hint cleared | none |
| UNDO | undo the delete | panel back; one run (Run on change) | none |
| TWO_PANELS | two panels; one processor deleted | the other panel is unaffected; nothing converges | none |
| BROKEN_YAML | a stray line typed in the processors list, then fixed with an indent change | no panel goes removed while broken; after the fix each panel is on its processor (shifted paths included) | none |
| WHOLE_LINE | the line `- label: a` replaced in one edit by `- label: b` | same processor; title `Bloblang: b` | none |
| LABEL_PREFIX | panel A on an unlabelled processor, panel B on label `x`; `label: xy` typed on A's processor | A stays on its processor; B stays on `x` | none |
| UNDO_RELINK | A (no samples) and B (samples) unlabelled; delete A's processor, save, undo | A and B on their processors; never sharing a link; both refreshed | none |
| CLOSE_UNSAVED | insert above, close without saving, reopen | the panel on its processor at the saved path | none |
| REMOVED_BACK_OFF | removed, then back with Run on change off | no stale result shows | none |
| WITH_GRAPH | each of the above with the graph open | same results; the graph keeps working | none |

</frozen-after-approval>

## Code Map

- Rework (review iteration 0): the first attempt's diff is at `/tmp/claude-1000/-home-aleksejjurcenko-projects-clients-personal-rpcn-vscode-byoc-plugin/268853b3-1dfc-4afe-b271-cc6ebd368b10/scratchpad/diff-4-10-iter0.patch`. Reuse its protocol field, removed view, generalized relink, unit and integration tests, `setText` change, and docs. Rewrite the tracking (`processorTracking.ts`) and the save relink to the rules above. Its Set registry and per-panel hint id may be kept.

- `src/adapters/bloblangPanel/panels.ts`:
  - `uri`/`path` are `readonly` (190-191, handle 89-97): make `path` mutable for the registry.
  - The `panels` Map (526) is re-keyed via `keyOf` (807) when a path changes. Registration and dispose are at 692-699.
  - `processor()`/`current()` (449-461) use the tracked processor instead of `bloblangProcessorByPath`.
  - `documentChanged()` (237-248, fan-out 543-553) gets the event's `contentChanges`.
  - `sourceKey` (263-265) gains the title and removed state.
  - The hint (`updateHint` 472-488) clears while removed.
  - The run guard (716-721) is unchanged.
  - `ref` (187/196) changes only through the save relink and Add label (348-370; keep `labelling`'s suppression).
  - Subscribe to `onDidSaveTextDocument`.
  - Header comment.
- New pure helper in `src/core/` (for example `processorTracking.ts`, no `vscode`): map an offset through change descriptors, then pick the processor by the rule. Uses `bloblangProcessors()` (`src/core/bloblangProcessors.ts:51-63`; fields 23-45).
- `src/core/samples.ts`: generalize 4.16's relink to any link pair (label/path → label/path), keeping its taken refusal.
- `src/adapters/bloblangPanel/sampleStore.ts`: `relink` takes the generalized pair.
- `src/shared/bloblangProtocol.ts:84-94` (+ test, fixture `snapshot-removed.json`): `removed?: true`.
- `webview/src/bloblang/TestPanel.tsx` (+ `bloblang.css`): the removed view, in place of the toolbar and columns like the no-binary view; nothing runs while it shows; returning to normal runs once (Run on change).
- Tests:
  - unit tests for the tracking helper and the relink;
  - `src/test/integration/suites/90-bloblang-panel.ts` -- the matrix, with `withGraph` and `replace`/`insert` from `graphHelpers.ts` and the suite's own `open`/`show`/`lastSnapshot`;
  - existing REORDER (842) and NO_LONGER_THERE (504) are kept or adjusted;
  - webview tests for the removed state.
  - AI-7: LABEL_TYPED combined with 4.16 (Add label, then a typed rename, saved).
- Docs:
  - `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` (AD-1 line 48, AD-22 linking 213/218, AD-5 line 80);
  - `ux-rpcn-vscode-designer/EXPERIENCE.md` (after line 120);
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] Tracking helper + relink generalization + unit tests.
- [x] Protocol + test + fixture.
- [x] `panels.ts`, `sampleStore.ts` -- tracking, re-keying, removed state, relink on save.
- [x] `TestPanel.tsx`, `bloblang.css` + tests -- the removed view.
- [x] Suite 90 -- the matrix.
- [x] Docs.

**Acceptance Criteria:**
- Given the dev host with a panel open and the graph open, when the user inserts a processor above, renames the label and saves, deletes the processor and undoes, then the panel stays on its processor, its title follows the label, its samples follow on save, and the removed notice shows and clears.
- Given the change, when `npm run compile`, `npm test` (stable), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- Iteration 1: `processorTracking.ts` rewritten (`mapRange` with left/right gravity, `parses`, `matchProcessors`: link match for reset panels, then overlap, label, removed recovery by last label or same kind and Bloblang nearest the last path). Newly unmatched panels also try step 3 in the same change (the next change would anyway).
- Save relink: `relinkAll` in `src/core/samples.ts` plans all of a config's moves together (chains and swaps apply; a link held by an unfreed entry, a non-moving live panel, a blocked move or an earlier move is taken); `SampleStore.relinkAll` writes once.
- Never shared: a removed panel whose link a save gave to another panel, or a panel coming back to a link a live panel holds, gets no link (`ref` undefined: shows no samples, sample changes are not saved and the state is posted back) until its next save gives it its processor's link.
- While the YAML doesn't parse, runs use the last processor found and its text; the hint is left as it is.
- Findings 6 and 7: entering the removed state clears the result; `unlabelledPath` is the samples link's path.
- CLOSE_UNSAVED is tested with a document opened by `vscode.open` (one opened by an extension stays open for minutes after its editor closes). With the graph open, the graph closes with its file's editor (unchanged graph behaviour), so that variant checks only the test panel.

## Plan Change Log

- Iteration 0 → 1 (intent_gap, review findings 1-5, user decision 2026-10-15). The frozen tracking rule (label first, then the anchor point; no state for broken YAML; per-panel save relink) was replaced by: range mapping, freeze while the YAML is broken, overlap-first matching with label and source recovery, reset on close, and a config-wide save relink. Rows were added to the matrix. Known-bad states avoided: panels removed while typing, whole-line edits removing a panel, a label prefix stealing a processor, two panels sharing samples, a stale path after closing without saving. KEEP: the protocol `removed?: true`, the webview removed view, the generalized `relinkSamples`, the Set registry and per-panel hint id, suite 90's minimal-edit `setText`, the docs. Low findings 6 and 7 are folded into the frozen rules.

## Review Triage Log

Iteration 0 (quick). Verdicts: 1 high, 4 medium, 2 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The label pass claims, for every panel, before any anchor. Typing `label: xy` on an unlabelled processor while another panel follows label `x` steals it after `x`; the unlabelled panel goes removed and never comes back. | medium | intent_gap | Reproduced by the reviewer. The frozen rule's order (label first, then anchor) causes it. |
| 2 | A transient structural YAML error while typing (stray line, wrong indent) gives no processors: every panel goes removed. Unlabelled ones often don't recover, or follow the wrong processor. | high | intent_gap | Reproduced. The frozen rule has no frozen state for broken YAML (AD-17 has one for the graph), and recovery is limited to the same path. Typing passes through broken YAML all the time. |
| 3 | A change that starts before the anchor and covers it (whole-line paste, a formatter, a quick fix) moves the anchor to the change start, outside the new map: the panel goes removed, and a label changed in the same edit never recovers. | medium | intent_gap | Reproduced. It follows the frozen "a change containing it moves it to that change's start" literally. |
| 4 | After delete, save and undo, two live panels share one samples entry. After a relink, the other panels of the config aren't refreshed. | medium | intent_gap | Read in the code. Per-panel refs collide because the save relink runs per panel. It is part of the same tracking and relink rule. |
| 5 | Close without saving and reopen: the followed path and anchor stay at the unsaved edit, so the panel runs the wrong processor or none | medium | intent_gap | No close or reopen handling; the frozen rule only covers change events. |
| 6 | Removed, then back with Run on change off: the result from before the removal shows again, while the editor hint is gone | low | patch (after loop) | Entering the no-binary state clears the result; entering the removed state does not. |
| 7 | Between an unlabelled processor's shift and the save, the offer names the new path, but the samples are still under `ref.path` | low | patch (after loop) | `unlabelled()` uses `this.path`; it should use `ref.path` while they differ. |

## Verification

**Results (2026-10-15, after the iteration 1 patches):** `npm run compile` exit 0. Full stable suite: the first run had 813 passing and 2 failing (graph 3.7 HEADER, and 4.16 OFFER + ACCEPT). Both passed alone twice, the full suite then had 815 passing, and suite 90 alone had 51 passing four times in a row, so I count them as flakes. `npm run test:webview` 236; `npm run test:corpus` 129. The implementer's iteration-1 floor run had 810 passing. Manual check (the user, dev host, real rpk, graph open): insert above and after, a label renamed and saved, broken YAML while typing, delete and undo, the unlabelled mutation shifted and saved, two panels, and close without saving then reopen: no errors.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- Dev host: insert above, reorder, rename the label and save, delete and undo, with the graph open.

Iteration 1 (quick). Verdicts: 1 high, 2 medium, 2 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | A processor inserted at the start of the next item's line stretches the panel's range (map ranges end there), so overlap hands the panel the new, bigger processor; a whole-range replace picks the largest one | high | patch | Reproduced with the real helpers. Now an insertion exactly at the range end doesn't extend it (an insertion at a boundary is not "a change containing it"), and step 1 ranks by intersection / union, with ties broken by distance between starts. Unit tests and an integration case added. |
| 2 | `reset()` on close uses `ref`, which is stale after a refused relink; it runs on every close (and on a language-mode close and reopen) and keeps the tracked path when `ref` is undefined | medium | patch | Each panel now keeps a saved position (as of the last open or save), and the reset uses it only when the document had unsaved changes. Test: refused relink, save, close, reopen. |
| 3 | A panel with no samples gets "Couldn't move the samples…" when its target is taken, and with no link its sample changes are dropped silently | medium | patch | No error now for movers with nothing to move. With no link, a sample change shows "This processor's samples can't be saved until the file is saved." and the panel gets the file's samples back. Tests added. |
| 4 | Add label doesn't wait for a running save relink, so it can relink from a stale `ref` and orphan the samples | low | patch | A narrow race; the fix is one await (as `hold()` does). |
| 5 | Stacked doc comments in `sampleStore.ts`; `RelinkOutcome` lost its own | low | patch | Moved back. |
