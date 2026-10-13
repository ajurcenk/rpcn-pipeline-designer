---
title: 'Bloblang text and position map for mapping and mutation processors'
type: 'feature'
ticket: '3'
created: '2026-10-13'
status: done
baseline_revision: '023c426ad2897136ff08bedfcf89c1f44dc0aa68'
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

**Problem:** The binary reports Bloblang errors as mapping-relative `line L char C`, and `failed assignment (line N)` (AD-21). The editor needs document positions. 4.2's finder returns only the decoded text, keyed by path, so 4.5 (diagnostics), 4.6 (graph markers) and 4.8 (Go to line) can't place an error.

**Approach:** Extend the core finder (pure, in `src/core`):
- each processor also carries its AD-7 node id;
- each processor gets a position map, from Bloblang `(line, char)` to a UTF-16 document offset, for every scalar style the YAML parser decodes.

`char` counts Unicode code points, 1-based (checked on 4.112.0: "éé", "日本" and "ab" put the same `)` at char 17, a single emoji at 16).

## Boundaries & Constraints

**Always:**
- **Scalar styles:** block literal (`|`, with chomping and indentation indicators), block folded (`>`), plain (one line and multi-line), single-quoted (`''` escapes, folded line breaks) and double-quoted (`\` escapes, `\` line continuations, folded line breaks).
- **The map's text** is the same string as `Scalar.value`, the decoded text that the test run and `blobl -f` receive. A decoded character maps to the document offset of the source character it came from. A character the YAML decoding produced (a folded line break's space, an escape's result) maps to the start of its source sequence.
- **API:** `offsetAt(line, char)` (1-based, code points) returns a UTF-16 document offset.
  - A column past the end of its line clamps to that line's end, and a line past the last clamps to the end of the mapping. The binary reports both at line ends.
  - `lineStart(line)` serves `failed assignment (line N)`.
- **`id`** follows AD-7 exactly as the PipelineModel builds it (`label:<label>`, `res:<…>:<label>`, else `path:<path>`, duplicate labels falling back to the path). It reuses the builder's rule through a shared helper, never a copy.
- **Pure core:** no `vscode`, deterministic, and it never throws. A value that isn't a scalar gives empty text and a map that clamps to the key.
- **Unchanged:** 4.2's `path`, `source`, `keyRange` and `range`, and its callers.
- **AI-8:** AD-21's "Positions" line notes code-point columns and the clamping.

**Never:**
- consumers of the map (diagnostics, markers, Go to line: 4.5, 4.6, 4.8), or panel re-keying (4.10);
- Bloblang fields other than the `mapping` / `mutation` processors' own field;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| BLOCK | `mapping: \|` with 8-space-indented lines, `\|-`, `\|+`, `\|2` | text = `Scalar.value`; `(2,5)` → the 5th character of the 2nd content line | none |
| FOLDED | `mapping: >` over lines | text = `Scalar.value`; a folded break's space maps to the line break | none |
| PLAIN | one line, and a multi-line plain scalar | each character maps back; a fold maps to the break | none |
| SINGLE | `'a ''b'' c'` | `''` decodes to `'` and maps to the first `'` | none |
| DOUBLE | `"a\n\"b\" é"`, `\` continuation | each escape result maps to its `\` | none |
| CODE_POINTS | a line with `é`, `日本`, `😀` before the error | `char` counted in code points, offset in UTF-16 (the emoji is 2 units) | none |
| CLAMP | `char` past the line end; `line` past the last | clamped to the line end / the mapping end | never throws |
| ID | labelled, unlabelled, duplicate-labelled, `processor_resources` | `id` equals the PipelineModel node id | none |
| NOT_SCALAR | `mapping: [1, 2]` or empty | text `''`, every position clamps to the key | none |

</frozen-after-approval>

## Code Map

- `src/core/bloblangProcessors.ts`:
  - `processorOf` (around l.94) builds `BloblangProcessor`, with `source` from `Scalar.value`.
  - Add `id` and `positions`, a map object with `text`, `offsetAt(line, char)` and `lineStart(line)`.
  - The scalar node gives `value.type` (`BLOCK_LITERAL`, `BLOCK_FOLDED`, `PLAIN`, `QUOTE_SINGLE`, `QUOTE_DOUBLE`) and `value.range`, which with the document text yields the raw source to walk.
  - Build the decoded text and an offsets array side by side, then check that the text equals `Scalar.value`. If they differ, fall back to mapping every position to the value's start and keep `source`. Never a wrong map.
- `src/core/graph.ts:215-230` -- the AD-7 id choice (`label:`, `res:<…>:`, duplicate labels to path ids). Extract the rule into a helper both modules call.
- `src/core/nodeAt.ts`, AD-16 -- UTF-16 `[start, end)` conventions to follow.
- `src/test/core/bloblangProcessors.test.ts` -- extend it: a round-trip per matrix row (every decoded character's mapped offset holds that character, or the start of its escape or fold).
- `test/corpus/corpus.test.ts:415` -- next to "graph accuracy", a describe that checks every corpus `mapping` / `mutation`: round-trip as above, and `id` equals the PipelineModel's node id for that processor. It needs no binary and no new records.
- `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` -- AD-21 "Positions".
- Boundaries met (AI-7):
  - 3.3's PipelineModel ids (the shared helper, with the corpus `id` check);
  - 4.2's finder callers (CodeLens, panel), whose tests stay green unchanged.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/graph.ts`, `src/core/bloblangProcessors.ts` -- the shared AD-7 id helper, then `id` and the position map per the matrix.
- [x] `src/test/core/bloblangProcessors.test.ts` -- every matrix row, the round-trip property and the fallback.
- [x] `test/corpus/corpus.test.ts` -- the corpus round-trip and the `id` check.
- [x] Architecture -- the AD-21 "Positions" line.

**Acceptance Criteria:**
- Given every corpus config, when `npm run test:corpus` runs, then every `mapping` / `mutation` round-trips and its `id` matches the graph's node.
- Given the change, when `npm run compile`, `npm test` (stable) and `npm run test:webview` run, then all pass with 4.2's tests unchanged.

## Implementation Notes

- The builder's AD-7 rule is `componentId` in `src/core/componentId.ts` (with `labelOf`, `scalarText`, `pairOf`, `segment` moved out of `graph.ts`). The finder takes `id` from a given PipelineModel through `nodeAt` (see the change log).
- Fold units (a folded space, a kept line feed) map to the first line break after the previous character's source.
- The position map lives in a new `src/core/bloblangPositions.ts`: it re-decodes the raw scalar mirroring yaml 2.9.1's `resolve-block-scalar.js` / `resolve-flow-scalar.js`, recording per-UTF-16-unit source offsets, and falls back to the value's start on any mismatch with `Scalar.value`. An explicit indentation indicator's base is the key's column.
- The finder needs the raw text: `ParsedYaml` gained a `text` field (set by `parseYaml`), so no caller changes.
- The round-trip check is a shared test helper, `src/test/helpers/bloblangPositions.ts`, used by the core suite and the corpus harness. A scratch fuzz of ~20k `yaml`-stringified scalars in all five styles (narrow line widths, CRLF) round-tripped with no fallback.

## Plan Change Log

- Ids now come from the PipelineModel through `nodeAt` (`bloblangProcessors(parsed, model?)`; no model, no id), not a copied component rule, because the inferred rule diverged from the catalogue-based builder.

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 3 medium, 1 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | A labelled resource item with no component key claims its label, so the next item's id differs from the graph's (`path:` vs `res:processor:q`) | medium | patch | Reproduced by the reviewer. Ids now come from the PipelineModel via `nodeAt` at the key; the case is a unit test. |
| 2 | The finder re-implements which maps are components instead of the catalogue-based builder (a copy the plan rules out) | medium | patch | Same root as 1; `componentIds`/`walk` removed. With no model, `id` is absent. |
| 3 | Dead `resource` expression in `processorOf` | low | patch | Removed with 2. |
| 4 | The corpus round-trip accepts any `\` or line break | medium | patch | The check is now exact per style; it exposed two fold mappings in the decoder (a break after an empty line, multi-break folds in double quotes), fixed. |

## Verification

**Results (2026-10-13):** `npm run compile` exit 0; `npm test` 695 passing on stable and on floor; `npm run test:webview` 154; `npm run test:corpus` 129 (the new describe checks the 5 corpus configs with mappings), no record changes.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm run test:corpus` -- expected: all pass, including the new describe.
- `npm test` (stable is the target; floor runs too), `npm run test:webview` -- expected: all pass.
