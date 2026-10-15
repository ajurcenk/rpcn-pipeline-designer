---
title: 'Saved samples'
type: 'feature'
ticket: '9'
created: '2026-10-15'
status: 'built'
baseline_revision: '32d9bffb1be3db236c97310c382995fe5357c5aa'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/initiative-rpcn-vscode-designer/brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A test panel's input lives only in the webview's view state. It can't be named, kept as more than one input, committed with the pipeline, or found again from a new panel (E4 R9, CAP-17, Done when 3).

**Approach:** The host keeps each config's samples in one JSON file beside it, linked to each mapping by `label`, with the processor's path as a fallback. The panel gets a sample picker with New sample, Rename and Delete; switching re-runs, and edits are saved. The protocol messages already exist (4.4).

**Decisions (user, 2026-10-15):**
- the file sits beside the config, with the format below (AD-22);
- Rename and Delete are toolbar buttons;
- the "add a label" offer and the CodeLens count are split off into 4.16.

## Boundaries & Constraints

**Always:**
- **File (AD-22):**
  - **Location:** `<config without .yaml/.yml>.samples.json` in the config's folder (`orders.yaml` → `orders.samples.json`). Untitled configs have no samples; the panel works as today and the sample controls are hidden.
  - **Format:** `{"version": 1, "mappings": [{"label"?: string, "path"?: string, "selected": string|null, "samples": [{"name", "content", "meta": {key: string}}]}]}`, written with 2-space indentation and a trailing newline.
  - **Linking:** a labelled processor links to the entry with its `label`. An unlabelled one links to the entry with its `path`. New entries are written with `label` when there is one.
  - **Who writes it:** the host only, after every sample change. The file is created with the first sample. An entry left with no samples is removed, and a file left with no entries is deleted.
- **Unreadable file:** invalid JSON or the wrong shape is never overwritten. The panel shows "The samples file can't be read: <reason>", and the sample controls are disabled until the file reads again.
- **Outside edits:** a change to the file on disk, or a save in VS Code, reloads it. Panels on that config get `samples`. When the selected sample's content or metadata changed, the input becomes the new version and runs (Run on change rules). The host's own writes don't count as outside edits.
- **Panel (prototype toolbar):**
  - **Toolbar:** "Sample" label and picker, then **New sample**, **Rename**, **Delete**, then Run on change and Run. Under it, "Saved in <file name>" while the mapping has samples.
  - **New sample:** with no samples, it saves the current input as "sample 1". Otherwise it adds an empty "sample N" (the first free N), selects it and runs nothing.
  - **Switch:** the input becomes the sample's, it runs, and the choice is saved as `selected`.
  - **Rename:** the picker becomes a text field. Enter saves; Esc and blur cancel. A name must be 1–100 characters after trimming and unique; otherwise an inline error shows ("Name must be 1–100 characters" / "A sample with this name exists") and the field stays.
  - **Delete:** the host asks with a VS Code modal, `Delete sample "<name>"?` with **Delete**. The neighbour sample is selected. With none left, the input is kept as unsaved input.
  - **Edits:** an edit to the content or metadata is saved into the selected sample (`inputEdited`), debounced with the run.
- **Unchanged:**
  - With no sample selected, the view-state input works exactly as today, the 4.15 no-binary gating stays, and the panel's key stays (`uri#path`).
  - Following edits and label changes is 4.10.
- **AI-8:** AD-22 is added to the architecture. The spec's sample-storage open question is marked answered. EXPERIENCE gains a samples row (noting the location differs from the prototype). CHANGELOG is updated.

**Never:**
- the add-label offer or the CodeLens count (4.16);
- protocol changes other than one optional `samplesError?: string` on `snapshot` and `samples` (the unreadable file's reason; the architecture's protocol line notes it);
- storing samples in `workspaceState` or under `.rpcn/`;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FIRST_SAMPLE | typed input, New sample | `orders.samples.json` created with "sample 1" = that input, selected | none |
| RELOAD | close the panel, open it again | snapshot carries the samples and `selected`; the input is the selected sample's | none |
| SWITCH | pick another sample | the input changes, one run, `selected` saved | none |
| RENAME / DUP | rename to a new name / to an existing one | saved / inline error, nothing written | none |
| DELETE | Delete, confirm / cancel | removed and the neighbour selected / unchanged | none |
| EDIT_SAVED | edit content and metadata | the selected sample in the file matches after the debounce | none |
| REORDER | labelled processor moved above another | a new panel finds its samples by label | none |
| PATH_FALLBACK | unlabelled processor | the entry is written with `path` | none |
| OUTSIDE_EDIT | file edited on disk | panels get `samples`; a changed selected sample replaces the input | none |
| UNREADABLE | invalid JSON in the file | message shown, controls disabled, file bytes unchanged after edits | none |
| UNTITLED | untitled config | no sample controls, nothing written | none |

</frozen-after-approval>

## Code Map

- New `src/core/samples.ts` (no `vscode`): parse and validate the file (`version: 1`, names per `isSampleName`, distinct names, `selected` a name or null); find the entry for a processor (label, else path); pure updates (add, rename, delete, select, edit), returning the next file value or `undefined` when it is empty; serialize. Reuse `BloblangSample` / `MAX_SAMPLE_NAME_LENGTH` from `src/shared/bloblangProtocol.ts:66-73`.
- New `src/adapters/bloblangPanel/sampleStore.ts`:
  - reads and writes through `vscode.workspace.fs`;
  - one `createFileSystemWatcher(new RelativePattern(dir, name))` per config with an open panel, disposed with the last one;
  - ignores events whose bytes equal its last write;
  - fires a per-config change event.
- `src/adapters/bloblangPanel/panels.ts`:
  - `postSnapshot` (:177-185) fills `samples` and `selected` from the store;
  - `receive` (:131) handles `sampleAdded`, `sampleRenamed`, `sampleDeleted`, `sampleSwitched` and `inputEdited`;
  - Delete's modal is a test seam beside `showMessage`;
  - on a store change, post `samples` to the config's panels;
  - an unreadable file posts `samples: [], selected: null, samplesError: <reason>`; add the optional field to `src/shared/bloblangProtocol.ts` (types, `isSamples`/snapshot validation, `src/test/shared/bloblangProtocol.test.ts`, a fixture `samples-unreadable.json`).
  - Update the header comment (:10-11).
- `webview/src/bloblang/TestPanel.tsx`:
  - the toolbar (:~242) gains the picker, New sample, Rename and Delete, the rename field and the "Saved in" line;
  - handle `samples` (header comment :15-16);
  - post `inputEdited` with the run debounce when a sample is selected;
  - switching replaces content and rows (keep `withId` row ids) and runs.
  - New `webview/src/bloblang/SamplePicker.tsx` is fine. CSS goes in `bloblang.css`, theme tokens only.
- `webview/src/bloblang/host.ts:21-29` -- ViewState is unchanged. A selected sample's input is mirrored into it, as today.
- Tests:
  - `src/test/core/samples.test.ts` (parse, link, updates);
  - `src/test/integration/suites/90-bloblang-panel.ts` (the matrix with a temp folder; the fixtures `samples.json` / `snapshot.json` exist);
  - `webview/src/bloblang/TestPanel.test.tsx` (picker, rename validation, switch runs, inputEdited, the disabled state).
  - AI-7: one combined test with 4.15 (no binary: switching runs nothing, and recovery runs the selected sample).
- Docs:
  - architecture: AD-22 after AD-21 (:197ff) in `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md`;
  - spec Open Questions (:144) in `spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md`;
  - `ux-rpcn-vscode-designer/EXPERIENCE.md` (after the 4.15 row);
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/samples.ts` + test -- the file model.
- [x] `src/shared/bloblangProtocol.ts` + test + fixture -- `samplesError`.
- [x] `src/adapters/bloblangPanel/sampleStore.ts`, `panels.ts` -- storage, watching, messages.
- [x] `webview/src/bloblang/TestPanel.tsx` (+ `SamplePicker.tsx`, `bloblang.css`) + tests -- the controls.
- [x] Suite 90 -- the matrix.
- [x] Docs -- AD-22, spec, EXPERIENCE, CHANGELOG.

**Acceptance Criteria:**
- Given the dev host with the real binary, when the user makes two samples, switches between them, renames and deletes one, and reloads the window, then the panel reopens with the remaining samples from `<config>.samples.json` and runs the selected one.
- Given the change, when `npm run compile`, `npm test` (stable), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- New sample with no samples is `sampleAdded {name}` then `inputEdited {content, meta}` (the protocol's `sampleAdded` has no input); the host adds an empty sample, selects it, then saves the input into it, in order (one queue per file).
- The host posts nothing back for the webview's own written changes (the webview already shows them); a change that does not apply (a duplicate rename, an unknown name) or an unreadable file posts the file's state back as `samples`. An edit that changes nothing posts nothing (the webview may be ahead). A confirmed Delete posts `samples` (the webview waits for it).
- In the webview, a pending edit of the selected sample wins over a `samples` message for the same sample, and every sample intent first flushes it, so keystrokes are not lost to a reply or an outside edit.
- The webview learns the samples file's name, and whether it has one (untitled: no controls), from the page's `data-samples` attribute beside 4.8's `data-file`: no protocol change.
- An unlabelled processor links only to an entry with its path and no label, so a hand-written `{label, path}` entry is never shared by two processors.
- `nextSampleName` lives in the webview (`SamplePicker.tsx`); the host only validates names.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 1 medium, 3 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The rename draft outlives the field: when the file turns unreadable or the selection changes mid-rename, the field comes back with stale text, or Enter renames the newly selected sample | low | patch | `draft` is cleared only by `close()`, and React fires no blur for an unmounted input. The rename is now cancelled when `selected` changes or the field can't show. Webview test added. |
| 2 | A pending edit is dropped when an outside `samples` message selects another sample within the 300 ms pause | low | reject | Needs an outside edit that changes the selection during the debounce, so it's rare. Saving the edit correctly means sending it to the previous sample, which the host no longer has selected: more than a direct correction. Same-sample edits are already protected. |
| 3 | A failed write or delete is only logged, so the webview shows the edit as saved while the file has the old content | medium | patch | `update()` returns `'unchanged'` on error, and `change` posts nothing for an `edit`. Now a failure shows "Couldn't save the samples: <reason>" and posts the file's `samples` back. Integration test added. |
| 4 | `orders.yaml` and `orders.yml` in one folder share `orders.samples.json`; `seen` is reset when one config's last panel closes | low | reject | Two configs that differ only in extension in one folder is unlikely. The fix changes the file naming the user decided (AD-22), which is more than a direct correction. |
| 5 | AC 1: reopened with Run on change off, the selected sample doesn't run | false | reject | The restored run follows Run on change, as in 4.7 (EXPERIENCE: "a reloaded panel runs its restored input once" with Run on change on). AC 1 uses the default (on), where it runs. The manual check is the user's, after the review. |

## Verification

**Results (2026-10-15, after the review patches):** `npm run compile` exit 0; full stable suite (VS Code 1.142.x) 771 passing; `npm run test:webview` 222; `npm run test:corpus` 129. Floor not targeted (user decision; the implementer's floor run had one unrelated graph CURSOR flake that passed on rerun). Manual check (the user, dev host, real rpk): samples created, switched, edited, renamed (duplicate error, Enter, Esc), deleted with the modal, outside edit and invalid JSON picked up, a reordered labelled processor kept its samples, the unlabelled mutation written by path, and a window reload brought them back: no issues.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- Dev host: samples saved, switched, renamed, deleted; file beside the config; outside edit picked up; window reload keeps them.
