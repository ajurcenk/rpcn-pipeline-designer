---
title: 'Quick Fix for unknown fields'
type: 'feature'
ticket: '5'
created: '2026-10-07'
status: 'built'
baseline_revision: '554095e91b87f71ac46e1e763783503f155a0946'
route: 'full'
route_source: 'auto'
review: 'full'
review_source: 'risk'
lenses_ran: ['adversarial', 'edge-case', 'verification-gap']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Lint on save (2.4) reports `field X not recognised`, but the user still has to look up which field names are valid at that spot. A typo such as `topci` should be fixable in one click (CAP-3, E2 R5).

**Approach:**
- A Quick Fix on our lint diagnostics with that message offers the closest valid field names at that position, titled "Change to `<name>`" (EXPERIENCE).
- The valid names come from the current schema snapshot.
- Applying a fix replaces only the key's text (AD-19).

**Decisions (defaults to confirm at this checkpoint):**
- **Locating the schema node** (the ticket's open question). The mapping that holds the bad key is resolved by walking its YAML path from the root through the schema. At each step:
  - expand `$ref` (to `#/definitions/<cat>`), every `allOf` member and every `anyOf` branch, and take `properties[<key>]` from each;
  - for a sequence index, take `items`.

  The valid names at the bad key are the union of `properties` keys of everything that path expands to. At a component mapping (for example under `input:` or a processor item), that union is the component names plus the shared fields (`label`, `processors`, …). Inside a component (under `generate:`), it is that component's fields. A path the schema cannot follow, or one that reaches an object with no `properties` (such as `meta` or `patternProperties` maps), offers no fix.
  - *Renegotiated 2026-10-07 (review):* when a sibling key already names a component, only the shared fields are offered. Name-keyed maps (`workflow.branches.<name>`) are not stepped through; this is a known limit.
- **Ranking.** Candidates are ranked by Damerau–Levenshtein distance, with ties broken by name. Up to 3 are offered. Names already used as sibling keys are excluded.
  - *Renegotiated 2026-10-07 (review):* the limit is `min(3, max(1, ⌊len/3⌋))` edits (was `max(2, ⌈len/2⌉)`), and `isPreferred` is set only when the closest name is strictly closer than the next.
- **YAML parsing.** Only `src/core` parses YAML, with `yaml` (eemeli) 2.9.1 and a `LineCounter`, as the architecture's stack pins (AD-2). This adds the first runtime dependency, which esbuild bundles. NOTICE gains its ISC notice.
- **Finding the key.** The bad key is the mapping key named X whose key token starts on the diagnostic's line, in whichever YAML document (`---`) contains that line. *Renegotiated 2026-10-07:* flow-mapping keys count too. A key matched twice on the line, or one with a parse error at or before it, offers no fix.
- **The edit.** It replaces exactly the key token's source range (quotes included) with the plain name. When no snapshot exists, no fix is offered.
- **Review** runs the full lens set (ticket risk is medium).

## Boundaries & Constraints

**Always:**
- **Trigger:** a `CodeActionProvider` for `yaml` documents, kind `QuickFix`. It acts only on diagnostics in the request context whose `source` is `Redpanda Connect` and whose message is exactly `field <X> not recognised`.
- **Each action:** it carries that diagnostic. Its edit is a `WorkspaceEdit` replacing only the key range: no other characters, comments, `${ENV}` references or formatting change.
- **Pure core:** the YAML path lookup, the schema walk, the ranking and the edit range live in `src/core`, with no `vscode` import. The adapter only maps between `TextDocument` / `Range` and offsets.
- **Schema source:** the schema is read from `SchemaStore.current.json` in memory, never from the cache file.
- **Failure:** the provider never throws; any failure means no actions.

**Never:**
- other Quick Fix types, including `field X is invalid when the component type is …`, deprecations and missing required fields;
- fixes for Red Hat diagnostics;
- re-serialising the document (`Document.toString()`);
- changing values or moving keys;
- running lint from the provider;
- a YAML parser outside `src/core`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| COMPONENT_FIELD | `nope:` under `generate:` → `field nope not recognised` | fixes from `generate`'s fields within the limit (none if none are close); `mappin:` → "Change to `mapping`" preferred | — |
| COMPONENT_LEVEL | `- mappng: …` processor item with lint `field mappng not recognised` | offers `mapping` (a processor component name) | — |
| OUTPUT_FIELD | `topci:` under `output.kafka_franz` | "Change to `topic`" first | — |
| TOP_LEVEL | top-level `inptu:` | "Change to `input`" | — |
| NESTED_ARRAY | typo inside `pipeline.processors[1].branch.processors[0].<comp>` | names from that nested component | — |
| SIBLINGS | `lable:` next to an existing `label:` | `label` not offered | — |
| QUOTED_KEY | `"topci":` | replaces `"topci"` with `topic`; nothing else changes | — |
| MINIMAL_EDIT | file with comments, `${ENV}`, odd spacing | after applying, the text differs only in the key | — |
| MULTI_DOC | typo in the second YAML document | resolved within that document | — |
| NO_MATCH | key not found on the line, or the line has another key | no actions | Never throws |
| UNKNOWN_PATH | under `meta:` or a path the schema cannot follow | no actions | — |
| NO_SCHEMA | no snapshot | no actions | — |
| OTHER_DIAGNOSTIC | Red Hat diagnostic, or another lint message | no actions | — |
| BROKEN_YAML | document has a syntax error elsewhere | best effort: fix if the key's path still parses, else none | Never throws |

</frozen-after-approval>

## Code Map

- **Schema (`test/fixtures/schema/jsonschema-4.112.0.json`, transformed by `src/core/schema.ts`):**
  - The root has `properties` (input, pipeline, output, buffer, `*_resources`, …), and each points at `{$ref: '#/definitions/<cat>'}`.
  - `definitions.<cat>` = `{allOf: [{anyOf: [{properties: {<component>: {properties: {…}, required, additionalProperties: false}}, type: object}, …]}, {properties: {label, processors, …}}]}`.
  - Arrays use `items` (often `$ref`). `JsonObject` / `isJsonObject` live in `src/core/schema.ts`.
- **`src/adapters/redpandaConnect/schema.ts`:** `SchemaStore.current?.json` (the transformed `JsonObject`).
- **`src/adapters/vscode/diagnostics.ts` (2.4):** `LINT_SOURCE = 'Redpanda Connect'`.
- **`src/extension.ts`:** the composition root. Register the provider for `{ language: 'yaml' }` here.
- **`yaml` 2.9.1** (ISC, no dependencies): `parseAllDocuments(text, { keepSourceTokens? })` and `LineCounter`. Nodes carry `range: [start, valueEnd, nodeEnd]`; `YAMLMap.items: Pair[]`; `isMap`, `isSeq`, `isScalar`, `isPair`.
- **New:**
  - `src/core/yamlPath.ts`: find the key on a line, its path and its range.
  - `src/core/schemaFields.ts`: walk the path and return the valid keys.
  - `src/core/suggest.ts`: distance and ranking.
  - `src/adapters/vscode/quickFix.ts`: the provider.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` / lockfile: add `yaml` 2.9.1 as a dependency; update NOTICE. Parser per the architecture pin.
- [x] `src/core/yamlPath.ts`, `src/core/schemaFields.ts`, `src/core/suggest.ts`: the pure pieces, unit-tested against the 4.112.0 fixture schema and inline YAML.
- [x] `src/adapters/vscode/quickFix.ts` and its wiring in `src/extension.ts`: the provider, with a schema source seam.
- [x] `src/test/`: unit tests for every matrix row; an integration test (save via the fake lint from 2.4, then `vscode.executeCodeActionProvider`, apply, check the text).
- [x] `README.md`, `CHANGELOG.md`: the Quick Fix.

**Acceptance Criteria:**
- Given `topci:` under `output.kafka_franz` flagged by lint, when Quick Fixes are requested, then "Change to `topic`" is offered first. Applying it changes only that key, and comments and formatting elsewhere are byte-identical.
- Given `nope:` under a `mapping` processor item, when Quick Fixes are requested, then the offered names are valid at that position per the schema, or there are none if nothing is close enough.

## Implementation Notes

- **Core.**
  - `parseYaml(text)` parses once per request and `findKeyOnLine(parsed, line, key)` looks up the key (`yaml` 2.9.1, `LineCounter`, `parseAllDocuments`). The key matches by its value or by its source (`0x1`), and every match on the line is collected, so ambiguity is detectable.
  - `fieldsAt` / `candidateFields` / `validFieldsAt` walk the schema. Expansion marks direct `anyOf` branches, so their property keys count as component names.
  - `rankNames` / `closestNames` / `hasClearWinner` rank the suggestions.
- **Provider.** `UnknownFieldQuickFix(schema)` filters diagnostics to source `Redpanda Connect` with the `not recognised` message, parses once, and offers up to 3 actions, each a single `WorkspaceEdit.replace` of the key token. It is registered for `{ language: 'yaml' }` with `providedCodeActionKinds: [QuickFix]`. The schema comes from `schemaStore.current?.json`.
- **Performance.** On the 808 KB 4.112.0 schema the walk takes 0.1–0.8 ms per path (adversarial review).
- **AD-2 lint rule (new).** It forbids `yaml` in `src/adapters/**`, `src/extension.ts` and `src/shared/**`, covering static imports, `require` and `import()`. `src/test` is left open so tests can check results.
- **Packaging.** `yaml` 2.9.1 is pinned exactly in package.json and the lockfile, and bundled by esbuild. The `.vsix` has no `node_modules`. NOTICE carries the ISC text byte for byte.
- **Tests.** Core tests run on the transformed 4.112.0 schema (with docs merged). A test asserts that the raw and transformed schemas give the same names.

## Plan Change Log

- 2026-10-07 (review, human renegotiation of three Decisions):
  - When a component is already present, only the shared fields are offered.
  - The edit limit is `min(3, max(1, ⌊len/3⌋))`.
  - `isPreferred` is set only for a clear winner.
  - Flow-mapping keys are in scope.
  - Name-keyed maps are a recorded limit; the user did not choose to step through them.

## Review Triage Log

**Pass 1 (full: adversarial + edge-case, verification-gap; 2026-10-07):** 20 findings across two reviewers (deduplicated).
- **Patched:** 10.
- **Renegotiated by the human:** 3 bad_plan.
- **Intent gaps decided:** 2 (name-keyed maps: known limit; flow keys: kept).
- **Rejected:** none.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| A1 | A component spot that already has a component offered other components (`mapping` + `bogus` → `log`) | medium | bad_plan → human | Shared fields only (`candidateFields`); tests. |
| A2 | The limit replaced short keys wholesale (`id`→`jq`, `metrics_mapping`→`metrics`) | medium | bad_plan → human | `min(3, max(1, ⌊len/3⌋))`; edge and short-key tests. |
| A3 | Preferred on an alphabetical tie | low | bad_plan → human | `hasClearWinner`; tie test through the provider. |
| A4 | No fix inside name-keyed maps | low | intent_gap → human | Recorded limit; test pins it. |
| A7 / V8 | Flow-mapping keys matched although the plan said block keys | low | intent_gap → human | Kept; test added. |
| V1 | AC2 (`nope` under a mapping processor item) untested | medium | patch | Test: no suggestions now (shared fields only, nothing within 1 edit). |
| V2 | BROKEN_YAML asserted only `doesNotThrow` | medium | patch | Asserts a fix when the error comes after the key, and none when it comes before (tab indent). |
| A5 | Parser recovery could give a wrong path | low | patch | No fix when `doc.errors` has an error at or before the key. |
| A6 | The same key twice on one line resolved to the outer key | low | patch | All matches are collected; more than one means no fix. |
| A8 | Numeric keys written as `0x1` never matched | low | patch | Also match `source`. |
| A9 / V6 | AD-2 lint gaps (`require`, `import()`, `src/shared`) | low | patch | Syntax selectors and shared blocks; probed. |
| A10 | Re-parse per diagnostic | low | patch | `parseYaml` once per request. |
| A11 / V7 | Tests used the raw schema, production the transformed one | low | patch | Core tests use `transformSchema(raw, docs)`; an equality test covers both. |
| V3 | NESTED_ARRAY not tested end to end | low | patch | YAML → path → suggestion test. |
| V4 | MULTI_DOC not exercised with the same key in both documents | low | patch | Core and provider tests. |
| V5 | Limit edge not pinned | low | patch | Kept at the limit, dropped beyond it. |
| V9 | Single-quoted key untested | low | patch | Core and provider tests. |

**Re-verification (parent):** `npm test` 371 passing (compile, type-check and lint run in `pretest`); `npm run test:corpus` 34/34; the `.vsix` builds.

## Verification

**Commands:**
- `npm run compile`: exit 0 (AD-15: `yaml` imported only under `src/core`).
- `npm test`: all pass.
- `npm run test:corpus`: 34/34.
- `npx vsce package`: the `.vsix` builds; NOTICE lists `yaml`.
