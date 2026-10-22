---
id: 23
type: story
title: "First processor's sample from the generate input"
parent: none
covers: ["CAP-17"]
after: [16]
assignee: ""
refined: false
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

## Notes

- Places to look: `previousSteps` in `src/core/bloblangProcessors.ts`; `seed()` in `src/adapters/bloblangPanel/panels.ts`; the generate run in `src/core/bloblangRun.ts` (`testConfig('generate', …)`); the snapshot's `previousStep`.
