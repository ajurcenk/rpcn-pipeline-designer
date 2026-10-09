---
title: 'PipelineModel from the schema''s component catalogue'
type: 'feature'
ticket: '3'
created: '2026-10-08'
status: 'built'
baseline_revision: 'd2ef642e06cc7850c54c9941d659a1c93083cf8f'
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

**Problem:** The graph draws a flat chain. Nested structure (`switch` cases, brokers, `branch`, `try`/`catch`, `workflow` and the rest) and resources are missing, and the component key is guessed (`componentName` skips `label` / `processors`) instead of read from the user's binary (AD-20).

**Approach:**
- A pure `src/core` ComponentCatalog derived from the cached transformed schema: per category and component name, its **child slots**.
- A PipelineModel builder that walks the YAML with the catalogue and produces every component, route and nested group plus `*_resources`, with AD-7 ids and AD-16 ranges. It reproduces 3.2's fixtures exactly.
- The graph panel builds with the current schema instead of the tracer's flat model.

**Decisions (from investigation; the 4.100.0 and 4.112.0 slot lists are identical):**
- **Slot rule:** walk a component's schema node through `properties`, `items`, `patternProperties` and `additionalProperties` only, without expanding `$ref`. A field is a child slot when the walk reaches `{"$ref": "#/definitions/<c>"}` with `c` in {input, processor, output}.
  - The kind is set by the last step: a direct `$ref` is `single`, `items` is `list`, `patternProperties` is `map`.
  - Buffer, scanner and other categories are not slots.
  - The catalogue is keyed by category and name (`switch` is a processor and an output; `broker` an input and an output).
  - A component key is a catalogue name of the expected category, and nothing else.
- **Groups:** a component is a group when at least one of its slots is present in the YAML.
- **Routes (generic):**
  - a wildcard segment before the slot (a list item or a map entry: switch cases, workflow branches, `group_by`) gives one route per element;
  - a slot that is the component's own value (`try: […]`, `catch: […]`, `fallback`, `for_each`) gives one uncaptioned route over the component key;
  - a plain field slot (`branch.processors`, `while`, `parallel`, `retry`, `cached`) gives direct children, with no route.
- **Chaining:** a processor list chains in order at each level; outputs and inputs in a list are not chained; nodes are in document pre-order.
- **Resources:** a `*_resources` item is a `res:<category>:<label>` node (role `resource`), and can itself be a group.
- **Fixtures:** add `fallback`, `retry`, `while`, `parallel` pairs (fixture list and folder test updated), so the ticket's verify names a fixture for each.
- **No schema:** with no schema snapshot the panel sends the empty model. The no-binary empty state is 3.9.
- **Shared and other processor slots (user, 2026-10-08, "use recommended options", Q1 a):** an input's and an output's own shared `processors` join the main chain where they run: input → its processors → `pipeline.processors` → the output's processors → output. Every other slot (`batching.processors`, `tools[].processors`, …) makes its component a group by the generic rule. A `shared-processors` fixture covers the chain, and a `batching` fixture covers a batching group.
- **Display hints (user, 2026-10-08, Q2 a):** three per-component display hints live in one small named table in core:
  - a `switch` case's caption is its `check` (cut to 31 characters plus `…`), else `case <i>`;
  - a `broker`'s outputs sit in one route over the `outputs` key, captioned with its `pattern`;
  - `workflow` branches get edges from `order` (every branch in stage k to every branch in stage k + 1).

  They say how the structure is shown, never which fields hold children. AD-20 is amended with one line saying so (architecture memlog), and the 3.2 fixtures stay as they are.

## Boundaries & Constraints

**Always:**
- **Purity:** the catalogue and builder are pure `src/core`, and only core imports `yaml` (AD-2, AD-15). The builder takes the parse and the catalogue as inputs (AD-20).
- **Identity and position:** ids follow AD-7, including the README's `["<key>"]` escaping and the duplicate-label rule. Ranges are UTF-16 `[start, end)` per AD-16. There are no coordinates in the model.
- **Fixtures as the contract:** the builder reproduces every fixture model (`deepStrictEqual`) on the 4.100.0 and 4.112.0 schemas.
- **Never throws:** an unknown component name (a plugin, a typo, a component from another version) is still a node, with no children. Odd shapes skip what they cannot read.
- **Green:** the integration and corpus suites and CI stay green. The panel still answers `ready` with a snapshot, and a click still selects the node's range.

**Never:**
- rendering groups (3.4);
- `nodeAt` and corpus graph records (3.5);
- live updates (3.6);
- a hand-written table of which fields hold children;
- new dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FIXTURES | each of the 16 fixture YAMLs, on 4.100.0 and on 4.112.0 | exactly its `*.model.json` | — |
| CATALOGUE | the transformed 4.112.0 schema | `processor:switch` → `[].processors[]` (list), `output:switch` → `.cases[].output` (single), `output:broker` → `.outputs[]`, `processor:workflow` → `.branches.<name>.processors[]` (map); `processor:mapping` has no slots | — |
| SAME_SLOTS | the 4.100.0 and 4.112.0 catalogues | identical slot lists | — |
| UNKNOWN | a processor named `not_a_component` | a node with that component, no children | never throws |
| COMPONENT_KEY | a processor with `label` before its key, and a processor named `processors` | the component is the catalogue name, not `label`; `processors` is a component | — |
| RESOURCE_GROUP | `processor_resources` item holding a `switch` | a `res:processor:<label>` group with its routes and children | — |
| ESCAPED_KEY | a workflow branch named `a.b` | its route id uses `["a.b"]` | — |
| NO_SCHEMA | the panel with no schema snapshot | snapshot with the empty model | — |
| PANEL | Show graph on `test/corpus/stateful_polling.yaml` with the fake 4.112.0 schema | nested model: `catch` is a group holding its `mapping` | — |

</frozen-after-approval>

## Code Map

- **Schema access:**
  - `src/core/schema.ts`: `transformSchema` (exported); `componentNodes()` at L238 walks `definitions.<cat>.allOf[0].anyOf[i].properties.<name>` (not exported; export or reuse); `DOC_CATEGORIES` at L44.
  - `src/core/schemaFields.ts` L116 `expand` (not exported); the slot walk must **not** expand `$ref`.
  - The transform keeps `$ref`, `items` and `patternProperties`, so the raw and transformed schemas give the same slots.
- **Category shared fields** sit in `definitions.<cat>.allOf[1].properties`: input and output have `label`, `meta`, `plugin`, `processors[]` → processor, `type`. The root `properties` hold `input`, `output`, `buffer`, `metrics`, `tracer`, `pipeline.processors[]` and `<cat>_resources[]`.
- **Slot paths to expect (both versions):**
  - processors:
    - `switch` `[].processors[]`
    - `branch` `.processors[]`
    - `try` and `catch` `[]`
    - `workflow` `.branches.<.>.processors[]` (`request_map` / `result_map` are strings)
    - `while`, `parallel`, `cached`, `retry` `.processors[]`
    - `for_each` `[]`
    - `group_by` `[].processors[]`
    - `processors` `[]`
    - `try_catch` `.processors[]` and `.catch[]`
  - outputs:
    - `switch` `.cases[].output`
    - `broker` `.outputs[]` and `.batching.processors[]`
    - `fallback` `[]`
    - `retry` and `drop_on` `.output`
    - `reject_errored` `<self>`
    - `dynamic` `.outputs.<.>`
  - inputs:
    - `broker` `.inputs[]`
    - `sequence` `.inputs[]`
    - `read_until` `.input`
    - `batched` `.child`
    - `dynamic` `.inputs.<.>`
  - 98 components have at least one slot (a scratch listing from the investigation is in the session scratchpad: `slots.py`, `112.txt`, `100.txt`).
- **`src/core/graph.ts`:**
  - reuse `pairOf` (L79), `labelOf` (L104), `pairRange` (L119), `valueEnd` (L126), `itemStart` (L135) and the duplicate-label logic (L26–43);
  - replace `componentName` (L84, `NON_COMPONENT_KEYS`) and the flat chain (L67);
  - there is no path-id builder yet (add one with the README's escaping).
- **Panel and wiring:**
  - `src/adapters/graphPanel/panels.ts`: L82–86 calls `buildPipelineModel(parsed, text)`; `GraphPanelsOptions` (L107) gains `schema: () => JsonObject | undefined`;
  - wired in `src/extension.ts` (~L167) as `() => schemaStore.current?.json`, like the providers at ~L162 (`SchemaStore.current` getter, `src/adapters/redpandaConnect/schema.ts:102`);
  - cache the catalogue per schema object.
- **Tests:**
  - `src/test/core/graph.test.ts` L46 compares only flat and labels; extend it to every fixture on both schemas;
  - load the schemas as `src/test/core/quickFixCore.test.ts` L11–14 does (`transformSchema(RAW, DOCS)` from `SCHEMA_FIXTURES`);
  - the `fixture()` loader is private in `src/test/shared/protocol.test.ts` L29 (move it to a shared test helper); `FIXTURE_NAMES` at L17, folder-exactness test at L157;
  - the integration suite `src/test/integration/suites/80-graph.ts` already uses the fake 4.112.0 binary helpers.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/catalogue.ts`: `componentCatalogue(schema)`: names per category, plus slots per category and name, by the slot rule. AD-20.
- [x] `src/core/graph.ts`: the nested builder over the catalogue, plus the display-hints table. Replaces the flat chain.
- [x] `src/test/fixtures/models/`: add `fallback`, `retry`, `while`, `parallel`, `shared-processors` and `batching` pairs and update the README. Covers every group kind the ticket names.
- [x] `src/test/core/catalogue.test.ts` and `src/test/core/graph.test.ts`: CATALOGUE, SAME_SLOTS, FIXTURES on both schemas, UNKNOWN, COMPONENT_KEY, RESOURCE_GROUP, ESCAPED_KEY. The matrix.
- [x] `src/adapters/graphPanel/panels.ts` and `src/extension.ts`: schema access, NO_SCHEMA, and PANEL in `80-graph.ts`. Wiring.
- [x] `README.md`, `CHANGELOG.md`; the AD-20 amendment and its memlog line. Docs.

**Acceptance Criteria:**
- Given any fixture YAML and either pinned schema, when the builder runs, then it returns exactly the fixture's model.
- Given a component from a newer binary that the schema lists, when the builder runs, then its child slots are found with no code change.

## Implementation Notes

- `src/core/catalogue.ts`: `componentCatalogue(schema)` gives per category its names, slots per component, shared fields and shared slots (`allOf[1]`: an input's and an output's `processors`). `formatSlot` prints `[].processors[]`, `.cases[].output`, `.branches.<name>.processors[]`, `<self>`. By the last-step rule `processor:workflow` is kind `list` (its wildcard is a map entry); the CATALOGUE test asserts the steps.
- `src/core/graph.ts`: `buildPipelineModel(parsed, text, catalogue)`; `undefined` catalogue gives the empty model. The component key is the first catalogue name of the category, else the first key that is not a shared field (unknown components). `DISPLAY_HINTS` holds the three hints.
- Choices the plan left open: an own-value `single` slot (`output.reject_errored`) gives a direct child, not a route (a route over the key would share the child's path id). A list-item route with no hint (`group_by`) has no caption. A broker with no `pattern` has an uncaptioned route. A nested input's or output's own `processors` (a broker output's) make it a group with those processors as direct children, chained. Root keys are read in document order, so nodes follow the document even when `output` precedes `input`; the top-level chain is always first in `edges`, then each nested list in the order it starts.
- Test helpers: `src/test/helpers/fixtureModels.ts` (the fixture loader moved out of `protocol.test.ts`) and `src/test/helpers/schemas.ts` (the pinned schemas, transformed). The integration graph suite now uses `useSchemaBinary()`; NO_SCHEMA builds its own `GraphPanels` with `schema: () => undefined`.

## Plan Change Log

## Review Triage Log

**Pass 1 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment; 2026-10-08):** 27 findings (deduplicated into 22 rows): 0 high, 1 medium patched, 6 low patched, 11 low rejected, 4 false. No intent_gap or bad_plan.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|---|
| 1 | blind | The webview still lays every node out flat, so with the nested model, routes, nested children and nested chains appear as loose unconnected boxes (stateful_polling: 6 → 15 boxes, same 5 edges): a visible regression from 3.1 | medium | patch | Until 3.4 draws groups, the view draws only nodes with no `parent` and the edges between them; the model sent stays nested. |
| 2 | verification-gap, blind, edge | Nothing checks that the panel builds from the current schema; a catalogue fixed at panel creation, or a cache not keyed by schema, would pass every test | low | patch | Integration test: switch to the changed 4.113.0 binary, `ready` again, the snapshot reflects the new schema. Re-sending to open panels when the schema changes is R9 (entry 9). |
| 3 | blind, edge | `caseCaption` cuts by UTF-16 units (can split a surrogate) and keeps a block-scalar `check`'s newlines; no test of the cut or the fallback | low | patch | Whitespace collapsed, cut by code points; unit tests. |
| 4 | edge | A branch repeated in consecutive `order` stages gets a self-loop edge | low | patch | Skipped; unit test. |
| 5 | blind | `reject_errored`'s child gets its parent's key range | low | patch | Its own component pair's range (AD-16); unit test. |
| 6 | blind | A misleading comment in `GraphPanel.model()` | low | patch | Reworded. |
| 7 | blind | A workflow without `order` gets no branch edges, undocumented | low | patch | Fixture README note. |
| 8 | blind | No placeholder text in the panel with no schema | low | reject | Entry 9 (empty states); a binary is required (CAP-1). |
| 9 | blind, edge | The catalogue walk ignores `anyOf`/`oneOf`/`allOf` around a `$ref` | low | reject | Neither pinned schema has such a slot (the investigation's walk over both versions); walking combinators adds branches for an unseen shape. |
| 10 | blind | SAME_SLOTS will fail on a future version that adds slots | low | reject | The frozen matrix row requires identical lists for these two recordings; a later version's record can change it with intent. |
| 11 | blind | Only `output:broker` gets the route hint; input `broker` is generic; no caption without `pattern` | false | reject | The intent's hint names "a broker's outputs … captioned with its `pattern`". |
| 12 | blind | Any `<x>_resources` key is accepted | low | reject | Lint reports an unknown root key; drawing it is harmless and plugins may add categories. |
| 13 | blind | Resource and component labels never collide as duplicates | low | reject | AD-7 defines `res:` and `label:` ids separately, so they cannot clash; the namespace rule is lint's. |
| 14 | blind | The fixtures' lint claim is not enforced by a test | low | reject | Checked against both pinned binaries during the build (Implementation Notes); a fixture lint test belongs with the corpus harness (entry 5). |
| 15 | blind | Setup builds a schema before every integration test | low | reject | Cost only; the suite stays well within the timeout. |
| 16 | blind | The dedupe idiom in `slotsIn` is unclear | low | reject | Cosmetic. |
| 17 | edge | A YAML merge key (`<<: *base`) supplying child fields drops those children | low | reject | Rare in pipeline configs; resolving merges adds a branch to every lookup. |
| 18 | edge | A top-level shared slot with a wildcard step drops its children | false | reject | Shared slots are plain `processors[]` lists (catalogue: input and output shared fields); no wildcard can occur. |
| 19 | edge, intent | `componentPair` falls back to a non-catalogue key, so unknown keys become nodes, against "a component key is a catalogue name … and nothing else" | false | reject | The frozen UNKNOWN row requires an unknown component name to be a node with no children; the fallback is what makes that row hold. |
| 20 | intent | Shared processors chain only at the top level; a nested input or output with processors becomes a group | false | reject | The decision says they "join the main chain"; nested ones follow "every other slot … makes its component a group". |
| 21 | intent | The drawn graph is not verified, only the model and the host message | low | reject | Rendering groups is entry 4 (frozen Never); finding 1 keeps today's drawing as it was. |
| 22 | intent | NO_SCHEMA uses its own `GraphPanels`, not the real store in a no-binary state | low | reject | Entry 9 covers the real no-binary path end to end. |

## Verification

**Re-verification after the review patches (parent, 2026-10-08):** `npm run compile` clean; `npm test` 572 passing on stable and 1.100.0; `npm run test:corpus` 89 passed. Manual check pending (the user): the main chain still draws as in 3.1, plus top-level resources as standalone boxes.

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass on stable and 1.100.0.
- `npm run test:corpus`: 89 passed.

**Manual checks:**
- Show graph on `.dev-host/workspace/graph-demo.yaml` still draws, and a click selects. Groups are not drawn as boxes until 3.4.
