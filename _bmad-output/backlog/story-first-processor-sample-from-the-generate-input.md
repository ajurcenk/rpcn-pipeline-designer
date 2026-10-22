---
id: 23
type: story
title: "First processor's sample from the generate input"
parent: none
covers: ["CAP-17"]
after: [16]
assignee: ""
refined: true
hitl: false
risk: low
estimate: ""
---

# First processor's sample from the generate input

## Description

**From previous step** (epic 4, ticket 4.18) fills a processor's sample by running the step before it in the same processor list. The first processor of `pipeline.processors` has no previous step, so the user types its input by hand. But when the config's input is a `generate` input, the message that processor receives is exactly what the generate mapping produces. Story 16 can now run a generate mapping: one empty message through the mapping as a `mapping` processor.

When this story is done, the first processor of `pipeline.processors` offers **From previous step** when the config has a single top-level `input.generate`:
- it runs the generate mapping (story 16's run) and saves the output content and metadata as a new sample named `from input.generate`;
- chaining works through it: a later processor with no sample of its own can go back through `pipeline.processors[0]` to the generate input;
- deleted, failed and error results save nothing and are reported as in 4.18.

Out of scope: broker inputs (several generators make "the previous step" ambiguous) and other input kinds.

This is the one case where "From previous step" crosses a list boundary (4.18 never does). AD-21's From previous step line and EXPERIENCE need the exception. Suggested by the user on 2026-10-22 after the story 16 check.

## Acceptance Criteria

1. **Offered on the first processor**
   **Given** a config whose only input is a top-level `input.generate` with a `mapping`, in the same YAML document
   **When** the panel of that document's `pipeline.processors[0]` (a `mapping` / `mutation`) opens
   **Then** **From previous step** is shown, named "New sample from input.generate" (or from the input's `label`).
2. **Seeds from the generate output**
   **Given** that panel
   **When** the user presses From previous step
   **Then** the generate mapping runs once (story 16's empty-message run). Its output content and metadata are saved as a new sample, `from input.generate` (made unique, selected, run), with non-string metadata as JSON text (4.18).
3. **Chains through it**
   **Given** `pipeline.processors[1]` (a `mapping` / `mutation`) whose previous steps have no selected sample
   **When** the user presses From previous step
   **Then** the generate mapping runs, then `processors[0]` on its output, and `processors[0]`'s output is saved as `processors[1]`'s new sample. A previous processor that has its own selected sample still starts the chain there (4.18).
4. **Failures**
   **Given** the generate mapping fails, is invalid input (reads `this`), or deletes the message
   **When** the chain runs
   **Then** nothing is saved, and the error names the step, as in 4.18 ("input.generate" failed: …).
5. **Not offered otherwise**
   **Given** a broker input (even with generate children), any other input kind, no input, a generate input with no mapping, or a processor that isn't the first of `pipeline.processors` with only Bloblang steps before it
   **When** the panel opens
   **Then** behaviour is exactly 4.18's: no generate step is added.
6. **Unsaved and edit-during-run rules**
   **Given** unsaved changes, or an edit during the run
   **When** From previous step is pressed
   **Then** 4.18's save-first and file-changed rules apply unchanged.
7. **Docs**
   **Given** the change
   **When** AD-21's From previous step line and EXPERIENCE's samples row are read
   **Then** they state this one exception to "never crosses a list boundary".

## Notes

- Places to look: `previousSteps` in `src/core/bloblangProcessors.ts`; `seed()` in `src/adapters/bloblangPanel/panels.ts`; the generate run in `src/core/bloblangRun.ts` (`testConfig('generate', …)`); the snapshot's `previousStep`.
