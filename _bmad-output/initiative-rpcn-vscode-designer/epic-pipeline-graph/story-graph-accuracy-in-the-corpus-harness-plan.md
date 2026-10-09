---
title: 'Graph accuracy in the corpus harness'
type: 'feature'
ticket: '5'
created: '2026-10-09'
status: 'built'
baseline_revision: 'd79038132eb8684128d85122f784b09f152080ab'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/src/test/fixtures/models/README.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:**
- Nothing measures graph accuracy over real configs: the spec's success signal says "for 100% of the corpus the graph shows every component, route and nested group" (R12, Done when 2).
- `nodeAt`, the one function that maps a text offset to a node, does not exist yet. Navigation (3.7) and markers (3.8) both need it.

**Approach:**
- Add a pure `nodeAt(model, offset)` to `src/core`: the innermost node whose range contains the offset (AD-16).
- Add a graph-accuracy block to the vitest corpus harness. For every `test/corpus/*.yaml` and each pinned version, it builds the model from that version's schema and compares it with a recorded `test/corpus/<name>.graph/<ver>.json`.
  - It also checks that every node's range resolves back to that node through `nodeAt`.
  - Record mode writes the graph records, and the layout and orphan checks cover them.

**Decisions (agent defaults, reported at the checkpoint):**
- **Schema source:** the pinned recordings `test/fixtures/schema/jsonschema-<ver>.json` and `json-full-<ver>.json.gz` (the versions the harness pins), passed through `transformSchema`. The check needs no binary, so it runs locally and in CI like diagnostics parity. Only lint itself needs the binaries.
- **Record format:** the `PipelineModel` as stable, pretty JSON (2-space indent, trailing newline, keys in the builder's order), one file per config per version. Reviewing a change to the graph is a diff of this file.
- **Round trip:** `nodeAt(model, node.range[0])` must return `node.id` for every node. If a corpus config breaks this (a node sharing its start with a descendant), that is a builder range bug: fix it in `src/core/graph.ts` so every node owns its start offset (AD-16). Never weaken the check.
- **`nodeAt` contract:**
  - **Containment:** "contains" is `start <= offset < end`.
  - **Innermost:** among the nodes containing the offset, the deepest in the `parent` chain wins; a node is deeper than its ancestors.
  - **No node:** `undefined` when no node contains the offset.
  - **Speed:** linear in the node count (no index needed at corpus sizes).

## Boundaries & Constraints

**Always:**
- **Purity:** `nodeAt` is pure core and never throws (AD-15, AD-16). Selection (3.7) and node status (3.8) will call it.
- **Harness modes:** the graph check compares by default and writes only in record mode (`npm run test:corpus:record`), exactly like the lint records.
  - A missing graph record fails, with a hint to record.
  - An orphaned graph record is reported by the layout checks and deleted in record mode.
- **One builder:** the harness uses the extension's own `componentCatalogue` and `buildPipelineModel`, never a copy.
- **Green:**
  - the existing lint records and parity do not change;
  - `npm run test:corpus` stays green locally without binaries (graph and parity run, lint skips) and in CI with them;
  - `npm test` (stable and 1.100.0) and `npm run test:webview` stay green.

**Never:**
- graph records for files outside `test/corpus/` (the 3.2 fixtures already pin those);
- running a binary for the graph check;
- layout or rendering checks (the webview has its own tests);
- changing the model shape;
- the host or webview using `nodeAt` (3.7 and 3.8).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ACCURACY | every corpus config × {4.100.0, 4.112.0} | the built model equals its record | a mismatch names the config and version, with a diff |
| ROUND_TRIP | every node of every corpus model | `nodeAt(model, node.range[0]) === node.id` | the failure names the node and the node `nodeAt` returned instead |
| RECORD | `npm run test:corpus:record` | writes every `<name>.graph/<ver>.json`; a second run changes nothing | — |
| MISSING | a corpus config with no graph record | the compare run fails with a "record it" hint | — |
| ORPHAN | a `<name>.graph/` with no config, or an unpinned version file | reported by the layout check; deleted in record mode | — |
| NO_BINARY | the binaries absent locally | the graph check still runs and passes | — |
| NODEAT_INNERMOST | an offset inside a processor inside a switch case | that processor's id, not the case's or the switch's | — |
| NODEAT_BOUNDS | an offset equal to a node's `end`, or before the first node | the next containing node, or `undefined` | never throws |
| NODEAT_FIXTURES | every 3.2 fixture model | the round trip holds for every node | — |

</frozen-after-approval>

## Code Map

- **`test/corpus/corpus.test.ts` (429 lines):**
  - The header (L1–21) documents the modes and record format; extend it for graph records.
  - Constants: `VERSIONS` (L36), `CORPUS` and `ROOT` (L45–46), `RECORD` (L50), `IN_CI` (L51), `configs` (L53).
  - Path helpers: `recordDirOf` / `recordOf` (L56–57), `rel` (L58).
  - **diagnostics parity** (`describe` at L242) needs no binary: copy its shape.
  - **corpus layout** (`describe` at L343): pinned versions (L344), resource dependencies (L349), orphaned records (L358, record mode), "every record has its config and a pinned version" (L365), "every config has a record for each pinned version" (L371). Extend the last three to `<name>.graph/<ver>.json`.
  - The per-binary lint blocks start at L391; leave them unchanged.
- **Builder and schemas:**
  - `src/core/catalogue.ts` `componentCatalogue(schema)`; `src/core/graph.ts` `buildPipelineModel(parsed, text, catalogue)`; `src/core/yamlPath.ts` `parseYaml`; `src/core/schema.ts` `transformSchema(raw, docs)`.
  - `src/test/helpers/schemas.ts` loads the pinned schemas for mocha; the harness runs under vitest outside `src/test`, so read `test/fixtures/schema/` directly the same way (`zlib.gunzipSync` for `json-full-*.json.gz`).
- **Types:** `src/shared/protocol.ts` `PipelineModel`, `PipelineNode`.
- **Corpus:** 16 configs in `test/corpus/*.yaml` (provenance in `SOURCES.md`); records live in `test/corpus/<name>.lint/<ver>.txt`. The `test/corpus/fixtures/` subfolder is not part of `configs` (`readdirSync` on the top level only).
- **`nodeAt`:** add it to `src/core/graph.ts`, or a small `src/core/nodeAt.ts` re-exported from it; unit tests in `src/test/core/` (mocha).
- **TypeScript:** `test/corpus/tsconfig.json` type-checks the harness (`check-types`); the harness already imports `src/core` modules (`args`, `lint`, `snippets`, `version`).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/nodeAt.ts` (or in `graph.ts`): `nodeAt(model, offset)`. AD-16.
- [x] `src/test/core/nodeAt.test.ts`: NODEAT_INNERMOST, NODEAT_BOUNDS, NODEAT_FIXTURES. Unit tests.
- [x] `test/corpus/corpus.test.ts`: the graph accuracy block (ACCURACY, ROUND_TRIP, MISSING, NO_BINARY), the extended layout and orphan checks (ORPHAN), record mode (RECORD), and the header. R12.
- [x] `test/corpus/<name>.graph/{4.100.0,4.112.0}.json` (16 × 2): recorded with `npm run test:corpus:record`. Read each new record, and check a handful by hand against its YAML (switch, broker and resources configs). The records.
- [x] `src/core/graph.ts`: only if ROUND_TRIP exposes a range bug. The fix. (Not needed: the round trip holds for every corpus and fixture node; graph.ts only re-exports `nodeAt`.)
- [x] `README.md` (Development, `test:corpus` line) and `CHANGELOG.md`. Docs.

**Acceptance Criteria:**
- Given a builder change that alters any corpus graph, when `npm run test:corpus` runs, then it fails, naming the config and version, until the records are re-recorded.
- Given the binaries are not installed, when `npm run test:corpus` runs, then graph accuracy and parity still run and pass.

## Implementation Notes

- The corpus has 15 configs, not 16 (the Code Map's count was off), so the records are 15 x 2 = 30 files.
- Three corpus files are templates, not configs (`input_sqs_example`, `processor_hydration`, `processor_log_and_drop`; SOURCES.md: "not a config"). Their recorded graph is the empty model, which is what the builder gives them; the harness does not require a non-empty graph.
- `nodeAt` lives in `src/core/nodeAt.ts`, re-exported from `src/core/graph.ts`. On equal depth (never the case in a built model), the node that starts last wins. A malformed model (parent cycle, missing parent) never throws.
- The graph compare is a string compare of the formatted record (CRLF in the record normalised), so vitest shows a line diff and the key order is part of the record.

## Plan Change Log

## Review Triage Log

**Pass 1 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment; 2026-10-09):** 27 findings (deduplicated into 14 rows). 1 medium and 6 low patched; 4 low rejected; 3 false or rejected as plan edits. No intent_gap or bad_plan.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|---|
| 1 | edge, blind | A builder regression that empties a real pipeline's graph would be recorded and pass; three templates already record empty models | medium | patch | Detected configs (`detect`, which excludes templates) must have a non-empty graph, and undetected ones an empty graph. |
| 2 | blind | No structural checks on corpus models (unique ids, parents exist, child range inside parent, edge endpoints exist) | low | patch | Checked for every model. |
| 3 | blind | The round trip tests only `range[0]`, so innermost-at-end is not checked on real configs | low | patch | `nodeAt(end - 1)` must return the node or one of its descendants. |
| 4 | verification-gap | Orphan detection for `.graph` records is never exercised against an orphan | low | patch | `orphanedRecords` takes its inputs; a self-test on a temp dir. |
| 5 | blind | A CRLF checkout shifts every range (the YAML is parsed as is) | low | patch | `.gitattributes` pins LF for the corpus and fixture YAML and JSON. |
| 6 | blind, edge | `catalogueOf` duplicates the pinned-schema test helper; a version without a schema recording fails with a raw ENOENT | low | patch | The helper is reused; a layout check names the missing recording. |
| 7 | blind | SOURCES.md and the harness header describe only lint records; identical per-version graphs and re-recording needing both binaries are undocumented | low | patch | Docs updated. |
| 8 | blind, intent | The records only prove nothing changed, not that the graph matches the YAML | low | reject | The approved decision: reviewing a graph change is its record diff, and the implementer hand-checked six configs. Rows 1–3 add checks independent of the records. |
| 9 | edge, blind | The equal-depth tie-break and the cycle result in `nodeAt` are untested | low | reject | Built models cannot reach either case; row 2 now asserts the invariants that rule them out. |
| 10 | edge | `nodeAt` breaks on a node with no range array, or with duplicate ids | false | reject | The builder always emits ranges and unique ids (row 2 checks both); the catch returns `undefined` rather than throwing. |
| 11 | blind | All 15 configs record identical graphs on both versions, so a version difference is untested | low | reject | Expected: the catalogue slots are identical (3.3). Documented in row 7; a version-specific config belongs with a future binary. |
| 12 | blind | No graph-only record path | low | reject | Covered in the docs (row 7); a new script is scope. |
| 13 | edge, verification-gap | The plan says 16 configs × 2; the corpus has 15 | reject | reject | The fix would edit this build's plan; noted in Implementation Notes (15 configs, 30 records). |
| 14 | intent | The webview rendering of corpus graphs is not tested | low | reject | Frozen Never: "layout or rendering checks". |

## Verification

**Re-verification after the review patches (parent, 2026-10-09):** `npm run compile` clean; `npm run test:corpus` 123 passed (15 configs × 2 versions of graph accuracy, plus the structure, detection, round-trip and orphan checks); `npm run test:webview` 47 passed; `npm test` 578 passing on stable and 1.100.0. Records unchanged by the patches.

**Commands:**
- `npm run compile`: exit 0.
- `npm run test:corpus`: all pass, including graph accuracy for 16 configs × 2 versions.
- `npm run test:corpus:record` twice: the second run leaves `git status` clean.
- `npm test`: all pass on stable and 1.100.0. `npm run test:webview`: all pass.
