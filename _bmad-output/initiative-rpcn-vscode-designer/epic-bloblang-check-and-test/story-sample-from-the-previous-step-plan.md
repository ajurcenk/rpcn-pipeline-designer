---
title: 'Sample from the previous step'
type: 'feature'
ticket: '18'
created: '2026-10-17'
status: done
baseline_revision: 'c978f31d2977f678e3e8758d0686b1712113b282'
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

**Problem:** A mapping's sample has to be typed by hand, even when the step before it already turns a known sample into exactly the message this mapping receives (E4 R14).

**Approach:**
- **The action:** a **From previous step** button in the test panel finds the previous `mapping`/`mutation` steps in the same processor list.
- **The run:** it runs them in order with the binary, through the existing AD-21 runner, starting from the nearest one that has a selected sample.
- **The result:** it saves the last output as a new sample of the current mapping.

**Decisions (user, 2026-10-17):** the previous step is run by the binary. The whole pipeline isn't run, and nothing is inferred statically. This ticket sits before 4.13.

## Boundaries & Constraints

**Always:**
- **Previous steps:**
  - **Which items:** for a processor at `<list>[n]`, the previous steps are `<list>[n-1]`, `<list>[n-2]`, … in the same list, while each is a `mapping` or `mutation` (as `bloblangProcessors` finds them).
  - **The chain:** it starts at the nearest of those with a selected sample, and runs every step from there up to `n-1` in order. Each output (content and metadata) is the next step's input.
  - **Where it's offered:** not for the first item of a list, for an item whose previous item is another kind, or for `processor_resources` (not a sequence of steps).
  - **The list boundary:** the chain never crosses it.
- **Availability:**
  - The snapshot gets an optional `previousStep: string`, the previous step's title (`label ?? path`), only when there is a previous step.
  - Without it, the button is not shown. It is also hidden in the no-binary, removed and untitled states, as the sample controls are.
  - It updates with the document like the rest of the snapshot.
- **Action:**
  - The button **From previous step** sits after New sample, Rename and Delete. Its accessible name is `New sample from <previousStep>`.
  - It posts `sampleFromPreviousRequested`, after flushing a pending edit like the other sample actions.
  - The host runs one such request per panel at a time; another click while one runs is ignored.
- **Result:**
  - **ok:** the output becomes a new sample.
    - **Name:** `from <previousStep>`, made unique as `from <previousStep> 2`, `3`, … and cut to 100 characters.
    - **Content:** the output content.
    - **Metadata:** the output metadata, with non-string values written as JSON text.
    - **Effect:** it is selected, saved through the samples store (AD-22) and posted to the panel, which runs it (switching rules).
  - **deleted, failed, parseError, invalidInput, error:** nothing is saved. An error message names the step: `"<step>" deleted the message; no sample was saved.`, or `"<step>" failed: <message>` (the result's message).
  - **No sample anywhere in the chain:** `"<previousStep>" has no sample to run.` and nothing is saved.
- **Unchanged:** the panel's own runs still apply only the processor under test, and nothing else in the samples file changes.
- **AI-8:**
  - AD-22 and AD-5 are amended;
  - EXPERIENCE's samples row and its keyboard Tab order gain the button;
  - CHANGELOG is updated.

**Never:**
- running processors of other kinds, or the pipeline's input;
- crossing list boundaries;
- inferring samples from expressions;
- protocol changes beyond the snapshot field and the one message;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SEED | `[0]` has a selected sample, panel on `[1]` | new sample "from <[0] title>" = `[0]`'s output, selected, saved, run | none |
| CHAIN | `[0]` has a sample, `[1]` none, panel on `[2]` | `[0]` then `[1]` run; the output of `[1]` is saved | none |
| META | the previous output sets metadata (incl. a non-string) | the sample's metadata = the output's, non-strings as JSON text | none |
| NAME_TAKEN | "from x" exists | "from x 2" | none |
| DELETED | the previous step deletes | error message; nothing saved | none |
| FAILED | the previous step fails | error with the step and message; nothing saved | none |
| NO_SAMPLE | no step in the chain has a sample | message; nothing saved | none |
| NO_PREVIOUS | first item, a previous non-Bloblang item, or a resource | no `previousStep`; no button | none |
| NESTED | inside `try:` / `switch` case processors | previous steps from that list only | none |
| BUSY | a second click during the run | ignored | none |

</frozen-after-approval>

## Code Map

- `src/core/bloblangProcessors.ts` (fields 27-49, path text 85-88, `bloblangProcessorByPath` 81) -- add a pure `previousSteps(processors, path)`: split the trailing `[n]`, walk `n-1…0` while each is a mapping/mutation, and exclude `processor_resources`. Unit-test it in `src/test/core/bloblangProcessors.test.ts`.
- `src/core/samples.ts` (`samplesFor` 192, `applySampleChange` 251 `add`).
  - Move `nextSampleName`-style uniqueness into a shared helper for "from <title>" names; `SamplePicker.tsx:20` keeps its own or reuses it.
- `src/adapters/bloblangPanel/panels.ts`:
  - `receive` handles `sampleFromPreviousRequested`.
  - A per-panel `seeding` guard.
  - Read the previous steps' samples via `owner.samples.read(uri)` + `samplesFor`.
  - Run each step via `BloblangPanels.runTest` (1246-1258, honours the `run` seam), using `current()` (678) for one parse. It doesn't touch the panel's run loop (634-667), which posts `result`.
  - Save with `this.change({type:'add', sample}, true)` (611-631).
  - Messages via `owner.tell(…, 'error'|'info')` (1118-1127).
  - The snapshot (and `sourceKey`) gains `previousStep`.
- `src/shared/bloblangProtocol.ts` -- snapshot `previousStep?` (88-101, validation 229-234), message `sampleFromPreviousRequested` (110-128, parser ~281). Plus its test and a fixture `snapshot-previous.json` in `src/test/fixtures/bloblang/`.
- `webview/src/bloblang/SamplePicker.tsx` (buttons 141-152, props 38-48, labels 11-13) and `TestPanel.tsx` (`newSample` 573-587 for the flush pattern, header comment) -- the button.
- Tests:
  - suite 90 -- the matrix with `samplePanels()` (834) and the fake binary (`src/test/helpers/fakeBinary.ts:141-182`; outputs depend on the mapping text, for example `root.c = 4`, `meta x = "y"`, `deleted()`, `FAIL_ME`);
  - webview "saved samples" describe (718) -- the button's presence, name and post.
- Docs:
  - `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` (AD-22 208+, AD-5 80);
  - `ux-rpcn-vscode-designer/EXPERIENCE.md` (118, 130);
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `previousSteps` + the name helper + unit tests.
- [x] Protocol + test + fixture.
- [x] `panels.ts` -- availability, the seeding run, the save, the messages.
- [x] `SamplePicker.tsx` / `TestPanel.tsx` + webview tests.
- [x] Suite 90 -- the matrix.
- [x] Docs.

**Acceptance Criteria:**
- Given the dev host with the real binary and two consecutive mappings, the first with a sample, when the user presses From previous step in the second's panel, then a new sample holding the first mapping's output is saved, selected and run.
- Given the change, when `npm run compile`, the stable suite under `xvfb-run -a`, `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- `previousSteps` returns the steps nearest first; `stepTitle` gives `label ?? path`. The list key is the last `.`-segment before the trailing `[n]`, so `documents[i].processor_resources` is excluded too.
- `Current` (panels.ts) now carries the text's `processors`, kept in `last` while the YAML doesn't parse, so `previousStep` doesn't flicker mid-edit; `open()` and `match()` pass the list they already parsed.
- The step's samples are looked up by the step processor's link now (label, else path), not by any panel's link.
- The new sample's name is computed from the samples read after the runs; `freeSampleName` cuts the base so `… N` still fits 100 characters.
- "No sample" is an info message; deleted / failed are errors. An unreadable samples file shows `Couldn't save the samples: <reason>` (the button is disabled in that state anyway).
- Suite 90's step-run assertions record the Bloblang of each run through a wrapper over the real runner (the real webview runs the posted sample, so spawn counts race).

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 2 medium, 2 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | A step's samples are looked up under its link in the unsaved text, but entries are stored under saved links: after an unsaved insert above, the previous step reads the panel's own entry and seeds from the wrong sample; an unsaved typed label gives a false "has no sample" | medium | patch | AD-22 and 4.10 move links only on save. With unsaved changes the action now shows "Save <file> first: samples are linked to the saved file." and saves nothing. Test added. |
| 2 | The chain uses one parse taken before the runs, so an edit during the runs is ignored and the result is still saved | medium | patch | The document version is checked after the chain; if it changed, nothing is saved and the user is told. Test added. |
| 3 | The unique name is computed before the write; a sample with that name landing in between makes `add` reject it silently | low | patch | Retries once with a fresh name, then reports the error. Test added. |
| 4 | An unreadable samples file reports "Couldn't save the samples" though no save was tried | low | patch | Uses AD-22's wording "The samples file can't be read: <reason>". |
| 5 | Acceptance criterion 1 has no evidence; the fake binary can't show output-to-input chaining | false | reject | AC 1 is the user's dev-host check, which runs after the review. Chaining is shown by the META test through the run seam and by the implementer's real-binary script on 4.112.0. |

## Verification

**Results (2026-10-17, after the review patches):** `npm run compile` exit 0. Full stable suite under `xvfb-run -a`: 841 passing, run alone. A first run overlapping the implementer's own test run failed the 5 undo-based tests (shared `.vscode-test` profile). `npm run test:webview` 288; `npm run test:corpus` 156. Floor not targeted (user decision). Manual check (the user, dev host, real rpk): a sample seeded from the previous step (content and metadata), a chain over two steps, a deleting step reported with nothing saved, the save-first message with unsaved changes, and no button on the first step: no issues.

**Commands:**
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable`; `npm run test:webview`; `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- Dev host: seed from the previous step, a chain over two steps, and a deleting previous step.
