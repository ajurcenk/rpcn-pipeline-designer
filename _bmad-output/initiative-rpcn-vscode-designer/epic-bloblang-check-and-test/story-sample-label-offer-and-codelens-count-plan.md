---
title: 'Sample label offer and CodeLens count'
type: 'feature'
ticket: '16'
created: '2026-10-15'
status: 'built'
baseline_revision: '0d30ad892dc29eda9948e5b7459214ee1a0fa8b8'
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

**Problem:** An unlabelled mapping's samples are linked by its YAML path (AD-22), so they detach when the processor moves, and nothing tells the user that. The "▷ Test mapping" CodeLens doesn't show how many samples a mapping has (E4 R9, prototype note 1).

**Approach:** The panel of an unlabelled processor shows a note with **Add label**. It asks for a name, writes `label:` into the YAML, and relinks the samples entry from path to label. The CodeLens reads the samples file and shows the count, refreshing when the file changes.

## Boundaries & Constraints

**Always:**
- **The offer:**
  - **When:** the panel's processor has no `label` and the config is saved (not untitled).
  - **The note:** under the toolbar, "No label: samples are linked to this processor's position (`<path>`) and are lost if it moves." with an **Add label** button. It is gone once the processor has a label.
- **Add label:**
  - The host shows an input box, prefilled with `<kind>_<N>` (the first N from 1 free among the document's labels).
  - **Validation:**
    - the binary's rule: `^[a-z0-9_-]+$`, not starting with `_`. Error: "Use lowercase letters, digits, `_` and `-`, not starting with `_`";
    - unique among the document's labels: "Another processor has this label";
    - not already a label entry in the samples file: "Samples already use this label".
  - Esc cancels, with no change.
  - **On accept:**
    - one edit inserts `label: <name>` as the processor's first key, at its key column, so the existing first key moves to the next line at the same column. The document is not saved.
    - Then the samples entry for the path, if any, is rewritten with `label` instead of `path`; samples and `selected` are kept.
    - The panel's title becomes `Bloblang: <name>`, its link uses the label, and a snapshot is posted.
  - If the YAML edit fails or the processor changed meanwhile, nothing is relinked and the error is shown.
- **CodeLens:**
  - **Text:** `▷ Test mapping · N samples` (`· 1 sample` for one). With no samples, or an unreadable or missing file, it is `▷ Test mapping`. Arguments are unchanged.
  - **Counts:** the same linking rule as the panel (label, else unlabelled path entry). Untitled files show no count.
  - **Refresh:** after the host writes the samples file (any panel), and on any create, change, or delete of a `*.samples.json` on disk (one workspace watcher, no open panel needed) or a VS Code save of one.
- **Docs (AI-8):**
  - AD-22 is amended (the offer and relink; the lens watcher);
  - AD-5's protocol list is amended;
  - the EXPERIENCE samples row gains the offer and the count;
  - CHANGELOG is updated.

**Never:**
- following label edits the user types (4.10), or renaming an existing label;
- saving the YAML;
- merging two sample entries;
- protocol changes other than one webview → host `addLabelRequested` and one optional snapshot field saying the processor is unlabelled (its path);
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OFFER | panel on an unlabelled mutation | note with the path and Add label; none on a labelled one | none |
| ACCEPT | Add label, accept `mutation_1` | YAML has `label: mutation_1` as the first key, same column; entry relinked; title and snapshot updated; note gone | none |
| ACCEPT_NO_SAMPLES | no entry for the path | label written; the samples file untouched (not created) | none |
| REORDER_AFTER | accept, then move the processor | a new panel finds the samples by label | none |
| INVALID / DUP / USED | `Bad`, an existing label, a label entry already in the file | the input box shows the matching error; nothing written | none |
| CANCEL | Esc | nothing changes | none |
| LENS_COUNT | 0, 1, 3 samples | `▷ Test mapping`, `· 1 sample`, `· 3 samples` | none |
| LENS_REFRESH_PANEL | add a sample in a panel | the lens count goes up | none |
| LENS_REFRESH_OUTSIDE | file edited on disk with no panel open | the lens count changes | none |
| LENS_UNREADABLE | invalid JSON | no count | none |

</frozen-after-approval>

## Code Map

- `src/core/samples.ts`:
  - add a pure relink, path entry → label entry, refused when a label entry exists (`SampleChange` variant or a separate function);
  - add a count helper for a `SampleRef`;
  - lookup stays the private `indexOf` (173-180).
- New `src/core/labelEdit.ts` (or extend `src/core/bloblangProcessors.ts`):
  - the insert offset and text for `label: <name>` at the processor map's `range[0]` with its column indent; quote with `yamlString` (`src/core/yamlPath.ts:139`);
  - the label rule and the suggestion (`<kind>_<N>`, existing labels from `bloblangProcessors()` / `labelOf`, `src/core/componentId.ts:52`).
- `src/adapters/bloblangPanel/sampleStore.ts`:
  - `update` (91) and a new `relink` write path;
  - a new `onDidWrite(config)` event, fired after the host's own writes, for the lens. `onDidChange` (56) stays outside-edits-only.
- `src/adapters/bloblangPanel/panels.ts`:
  - `ref` (147/157) becomes mutable for this case;
  - `receive` (162-193) handles `addLabelRequested`, with an input box seam beside `showMessage` / `confirmDelete` (122/127) and `WorkspaceEdit` + `applyEdit`;
  - set `panel.title` via `bloblangTitle` (63) and post a snapshot;
  - the snapshot (226) gains the unlabelled path.
- `src/shared/bloblangProtocol.ts` (83, 100-114, parser 254) + `src/test/shared/bloblangProtocol.test.ts` + a fixture: the two additions.
- `webview/src/bloblang/TestPanel.tsx` (+ `bloblang.css`) -- the note and the button, posting `addLabelRequested`.
- `src/adapters/vscode/bloblangLens.ts` -- async count through the store's read. `onDidChangeCodeLenses` also fires on `onDidWrite`, on a `**/*.samples.json` watcher and on a save of such a file.
- `src/extension.ts:207-213` -- give the lens the store (`bloblangPanels` exposes it) and dispose the watcher.
- Tests:
  - `src/test/core/samples.test.ts`, plus a test for the label edit and rule;
  - `src/test/integration/suites/90-bloblang-panel.ts` -- the matrix. Lens title asserts at 196-210 and 681 now expect the count.
  - `webview/src/bloblang/TestPanel.test.tsx` -- the note and the button.
  - AI-7: ACCEPT combined with the 4.9 OUTSIDE_EDIT path (the relinked entry reloads).
- Docs:
  - `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` -- AD-22 (208-219) and AD-5 (80);
  - `ux-rpcn-vscode-designer/EXPERIENCE.md:118`;
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/samples.ts`, label edit + tests -- the pure parts.
- [x] Protocol + test + fixture -- the two additions.
- [x] `sampleStore.ts`, `panels.ts` -- relink, offer, title.
- [x] `TestPanel.tsx`, `bloblang.css` + tests -- the note.
- [x] `bloblangLens.ts`, `extension.ts` -- the count and refresh.
- [x] Suite 90 -- the matrix.
- [x] Docs.

**Acceptance Criteria:**
- Given the dev host and an unlabelled mutation with samples, when the user adds a label from the panel and moves the processor, then the YAML has the label, the samples stay attached, and the CodeLens shows their count throughout.
- Given the change, when `npm run compile`, `npm test` (stable), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- The label rule, suggestion, document labels and the insertion are in the new `src/core/labelEdit.ts`. The insertion is checked by re-parsing the result: the processor at the same path must read back with the label, kind and Bloblang unchanged. A flow map (`- {mapping: …}`) gets `label: <name>, ` after its `{`.
- "The document's labels" means every `label` scalar of any map, at any depth, in every YAML document (`documentLabels`), not only the Bloblang processors' labels.
- The offer shows only while the panel's link is still the path (`ref.label === undefined`) and the processor has no label now. A label the user types into the YAML hides the note (the snapshot is re-sent), but the panel still links by path: following typed labels is 4.10.
- If the samples file can't be read, Add label refuses before showing the input box (`Couldn't add the label: the samples file can't be read: <reason>`): without reading the file, the samples entry can't be relinked or checked.
- The link and title switch only after the relink wrote the file (or found no entry). While the label is written and relinked, `documentChanged` posts no snapshot and sample changes wait, and a snapshot's samples are read with the link as it was when the read was queued. So nothing posted shows the samples gone.
- A relink that can't happen (`'taken'`: a label entry appeared after validation, so nothing is merged; the file became unreadable; the write failed) removes the inserted `label:` text again (only when it is still at the inserted place), keeps the path link and the offer, and shows `Couldn't add the label: <reason>`.
- Lens refresh outside a workspace folder: a `**/*.samples.json` workspace watcher sees nothing outside the workspace folders (the integration host has no folder), so the lens also watches the folder of each lensed config outside every workspace folder (`RelativePattern(dir, '*.samples.json')`), until no open document is left in that folder. It also refreshes on the store's `onDidChange`.
- The lens reads through `SampleStore.read`, which records the bytes it saw. A changed file seen first by a lens read fires `onDidChange` for that config's panels, the same as the watcher's reload would.
- `ExtensionApi` exposes `bloblangLens` (`onDidChangeCodeLenses` only) so that suite 90 can hear refreshes; `executeCodeLensProvider` always asks again.

## Plan Change Log

- 2026-10-15: besides the single `**/*.samples.json` workspace watcher, the lens has a per-folder watcher for configs outside every workspace folder (see Implementation Notes). Without it, LENS_REFRESH_OUTSIDE can't happen in a window with no folder, such as the integration host.

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 1 medium, 2 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | During Add label, a snapshot read before the relink under the new label posts `samples: []`, so the picker briefly shows "Unsaved input" | low | patch | `ref` switched to the label right after `applyEdit`, while `documentChanged`'s snapshot read the pre-relink file. The link and title now switch only after a successful relink. Suite 90 asserts that no post during Add label had empty samples. |
| 2 | If the relink fails (unreadable, write failure, label taken), the YAML keeps the label, the samples stay under the path, the panel links by label and shows none, the note never returns, and unreadable shows no error | medium | patch | It contradicted the intent's "nothing is relinked". Any relink failure now undoes the inserted `label:` (only if the text is still there), keeps the path link, and shows "Couldn't add the label: <reason>". Tests cover taken, unreadable and write failure. |
| 3 | The lens's reads keep each lensed config's samples text in the store's `seen` for the session, and queue with writes on every lens refresh | low | reject | Samples files are small JSON. The cache only changes how outside edits are detected, which is harmless, and the queued reads are cheap. Not worth adding eviction logic. |

## Verification

**Results (2026-10-15, after the review patches):** `npm run compile` exit 0; full stable suite 782 passing; `npm run test:webview` 227; `npm run test:corpus` 129. Floor not targeted (user decision). Manual check (the user, dev host, real rpk): lens counts (none, 1, 2), the note on the unlabelled mutation, Add label errors and accept writing the label as the first key, the entry relinked to the label, samples kept after moving the processor, and an outside edit updating the count: no issues.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- Dev host: the note on an unlabelled mutation; Add label writes the YAML and keeps the samples; the lens count updates on add, delete and an outside edit.
