---
title: 'Schema completion fixes: incomplete components and value options'
type: 'feature'
ticket: '13'
created: '2026-10-07'
status: done
baseline_revision: '98c0d964ce600749df47478ede0eee160c99586d'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** In the user's manual check (2026-10-07), Ctrl+Space under `file:` with only `codec: lines` gave only VS Code's word suggestions. Red Hat drops a component's `anyOf` branch while a required field (`path`) is missing, so nothing is offered. Value completion is also missing: `codec` has documented options (`all-bytes`, `append`, `delim:x`, `lines`), but the binary's jsonschema has no `enum` at all, and the transform does not use the options from json-full.

**Approach:** Two changes to the pure transform (AD-10), with `TRANSFORM_VERSION` bumped to 2 so cached schemas regenerate:
1. Drop every `required` from the served schema. Lint on save is the validation for missing required fields (AD-12, amended 2026-10-06).
2. For a json-full field with `options` (a list of strings) or `annotated_options` (pairs of value and description), add non-strict value suggestions: the node keeps its type and gains `anyOf: [{type: 'string', enum: [values], markdownEnumDescriptions: [descriptions]}, {type: 'string'}]`. Any string stays valid (`delim:foobar`), and Red Hat lists the options with their descriptions.

**Decision (user, 2026-10-07):** build this as ticket 13 before 2.8; options are suggestions only, not a strict enum; the empty-component-block case is a separate open question (E2 notes).

## Boundaries & Constraints

**Always:**
- **Pure and deterministic:** the transform stays pure and deterministic, and its output for the same input changes only through the version bump.
- **Which options apply:** options are applied only where the target node is a `string` scalar (`kind` scalar), or to the string `items` of an `array` field. Any other kind or type is skipped.
- **Descriptions:** `markdownEnumDescriptions` is only written when at least one option has a description, and then for every option (`''` where one has none).
- **Existing behaviour:** the existing transform tests keep passing, except where they pin the version number or `required`. The corpus harness and parity stay green.

**Never:**
- a strict `enum` (no new validation errors while typing);
- changing `type`, `default` or `markdownDescription`;
- touching nodes that already have `anyOf` (such as the interpolated number and boolean fields);
- removing `additionalProperties`;
- new dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| INCOMPLETE_COMPONENT | `output.file` with only `codec: lines`, cursor on a new field line | Red Hat completion offers `path` | — |
| VALUE_OPTIONS | one character typed after `codec: ` (an empty value inside a component gets nothing from Red Hat 1.24.0; see the Plan Change Log) | completion offers `all-bytes`, `append`, `delim:x`, `lines` | — |
| PLAIN_OPTIONS | a field with `options` but no descriptions | `enum` without `markdownEnumDescriptions` | — |
| FREE_STRING | `codec: delim:foobar` | no Red Hat schema diagnostic | — |
| NO_REQUIRED | the 4.112.0 transformed schema | no `required` key anywhere | — |
| ARRAY_OPTIONS | an array-of-strings field with options | suggestions on `items` | — |
| SKIP | options on a non-string or an already `anyOf` node | node unchanged | Never throws |
| VERSION | `TRANSFORM_VERSION` | 2; cache file names change | — |

</frozen-after-approval>

## Code Map

- **`src/core/schema.ts`:**
  - `transformSchema(raw, docs)` runs `allowInterpolation` and then `mergeDocs`.
  - `applyField(node, field)` sets `markdownDescription` and `default`, then recurses through `applyChildrenByKind` / `elementNode(kind)`.
  - `forEachSubSchema` walks every sub-schema.
  - `TRANSFORM_VERSION = 1`, and the header comment lists the transform steps.
- **json-full 4.112.0:** 130 fields have `options` and 86 have `annotated_options` (pairs). Example: `outputs[file].config.children[codec]`.
- **Tests:**
  - `src/test/core/schema.test.ts` (fixture-based transform tests);
  - the contributor integration suite in `src/test/extension.test.ts` (real Red Hat; `completionOffers`, `openYaml`, the fake binary serving 4.112.0 fixtures).
- **Probe (2026-10-07, real Red Hat 1.24.0):** with `required` dropped, completion under `file:` + `codec` offered `path`. Empty blocks still offered nothing.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/schema.ts`: drop `required`, add option suggestions, bump the version to 2, update the header comment. The transform.
- [x] `src/test/core/schema.test.ts`: NO_REQUIRED, VALUE_OPTIONS shape (codec), PLAIN_OPTIONS, ARRAY_OPTIONS, SKIP, VERSION. Unit tests.
- [x] `src/test/extension.test.ts`: INCOMPLETE_COMPONENT and VALUE_OPTIONS through real Red Hat completion, and FREE_STRING with no `yaml-schema` diagnostic. Integration tests.
- [x] `README.md`, `CHANGELOG.md`. Docs.

**Acceptance Criteria:**
- Given `output.file` with only `codec: lines`, when completion is requested on the next field line, then `path` is offered.
- Given the cursor after `codec: `, then `all-bytes`, `append`, `delim:x` and `lines` are offered, and `codec: delim:foobar` gets no schema error.

## Implementation Notes

- **Transform:**
  - `dropRequired` runs over every sub-schema through `forEachSubSchema`. It removes only the `required` keyword; a field that is *named* `required` (LLM `tools[].parameters` schemas) is kept.
  - `optionsOf` reads `annotated_options` pairs and falls back to `options` when the pairs give none.
  - `applyOptions` targets string scalars, or the string `items` of an array field.
- **Coverage** (review experiment): 216 fields have options in 4.112.0 (211 in 4.100.0). All are string scalars, and all 216 get suggestion nodes. 288 `required` arrays are removed. Output is deterministic, and the raw schema and docs are not modified.
- **Red Hat 1.24.0 probes (2026-10-07):**
  - Options are offered for an empty top-level value (`logger.level: `), and inside a component once one character is typed (`codec: l`).
  - An empty value or an empty block inside a component gets nothing.
  - Allowing `null` on typed nodes made things worse: it offered `lines`/`null` and no options. Branch-level `required: [<name>]` did not help either. Neither is shipped.
- **Mutation check:** with `dropRequired` disabled, INCOMPLETE_COMPONENT fails.

## Plan Change Log

- 2026-10-07: the VALUE_OPTIONS row is restated as "one character typed". An empty value inside a component gets nothing from Red Hat 1.24.0. This is the same open question as empty component blocks (E2 notes), and the user was told before this was recorded.

## Review Triage Log

**Pass 1 (quick, 2026-10-07):** 7 findings. 1 intent_gap was recorded, 4 were patched, and 2 were rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | VALUE_OPTIONS as written ("after `codec: `") is not met for an empty value | medium | intent_gap → recorded | Plan Change Log; README known limit; E2 open question. |
| 2 | Descriptions were not checked through Red Hat | low | patch | Integration test asserts the `all-bytes` documentation. |
| 3 | Two option descriptions render imperfectly as Markdown (indented JSON, `<document_id>`) | low | reject | Cosmetic; VS Code sanitizes the HTML. |
| 4 | `OFF` / `no` look like YAML 1.1 booleans | low | reject | Red Hat parses YAML 1.2 strings, and the free-string branch accepts anything. |
| 5 | A non-empty but unusable `annotated_options` suppressed `options` | low | patch | Falls back to `options`; test. |
| 6 | The header comment left out the array `items` target | low | patch | Comment. |
| 7 | INCOMPLETE_COMPONENT was not shown to be able to fail | low | patch | Mutation check (above). |

**Re-verification (parent):** `npm test` 418 passing; `npm run test:corpus` 65 passed.

## Verification

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass.
- `npm run test:corpus`: 65 passed.

**Manual checks (if no CLI):**
- In the Extension Development Host: under `file:` with only `codec`, Ctrl+Space offers `path`; after `codec: `, Ctrl+Space lists the four codecs with their descriptions.
