---
id: 22
type: story
title: "Live Bloblang errors in generate mappings"
parent: none
covers: ["CAP-15", "CAP-10"]
after: []
assignee: ""
refined: true
hitl: false
risk: medium
estimate: ""
---

# Live Bloblang errors in generate mappings

## Description

Split from story 16 (user decision, 2026-10-22) and built first. A `generate` input's `mapping` (in `input` or in a broker's `inputs`) is Bloblang the user writes a lot of. Today it gets no live syntax errors, because the Bloblang finder (`src/core/bloblangProcessors.ts`) only knows `mapping` / `mutation` processors. This story teaches the finder a third kind, `generate`, so 4.5's live parse and 4.6's graph marker cover it. Story 16 then adds the lens and the test panel on top.

## Acceptance Criteria

1. **Found**
   **Given** a detected config with `input.generate.mapping`, or `input.broker.inputs[i].generate.mapping`, as a block or a quoted scalar, nested in other documents too
   **When** the finder runs
   **Then** it returns an entry of kind `generate`:
   - its path is `input.generate` or `input.broker.inputs[i].generate`;
   - its key range is the `mapping` key;
   - its source and position map are those of the mapping value;
   - its graph id is the input's node.
2. **Live syntax errors**
   **Given** a generate mapping with a Bloblang syntax error
   **When** the user types
   **Then** it is underlined with the binary's message at the right YAML line and column, as for processors (4.5), and it clears once the mapping parses.
3. **Graph marker**
   **Given** that error
   **When** node status is computed
   **Then** the generate input's graph node (or the broker child's node) gets the error marker with the binary's message, and an error at the mapping's end also marks it (bug 20).
4. **Nothing else picks it up**
   **Given** the new kind
   **When** the processor-only features run
   **Then** they ignore `generate` until story 16 adds it:
   - the Test mapping lens, the Test mapping command and the panel;
   - samples, From previous step, and Add label;
   - the corpus parity samples and records.
   Processor tracking never matches a `generate` entry to a processor panel, or the reverse (kind guard, including the label step). The corpus position and id round-trip test does cover the generate mappings.
5. **Spec and architecture**
   **Given** the change
   **When** they are read
   **Then** they match the new behaviour (through `bmad-spec`, with the architecture updated in the same commit):
   - CAP-15 includes `generate` mappings, and the Non-goal line and the "CAP-15–17 cover processors only" line say so;
   - AD-14 states the new scope of live diagnostics.

## Notes

- Evidence and code map: the planning investigation (2026-10-22). The finder's `visit` / `processorOf`; consumers in `bloblangDiagnostics.ts:229`, `bloblangLens.ts:69-78`, `panels.ts` (851, 1144, 1264, 1326), `processorTracking.ts:119-123` (the label step has no kind check), `test/corpus/corpus.test.ts` (232, 555-575, 634); the graph's input node range already contains the mapping (`graph.ts:166-176`).
