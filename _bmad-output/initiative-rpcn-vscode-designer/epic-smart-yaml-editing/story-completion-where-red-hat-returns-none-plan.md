---
title: 'Completion where Red Hat returns none'
type: 'feature'
ticket: '16'
created: '2026-10-07'
status: 'built'
baseline_revision: 'c1002a6ac93a07c2b5bf4cfbb647fd5e8f1cfe36'
route: 'full'
route_source: 'auto'
review: 'full'
review_source: 'risk'
lenses_ran: ['adversarial', 'edge-case', 'verification-gap']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Red Hat 1.24.0 offers nothing in the most common authoring positions: an empty component block (`socket:` with nothing under it), a partly typed first key in one, and an empty value inside a component (`network: `). The user's check of `input.socket` (2026-10-07) showed only VS Code's word suggestions.

**Approach (AD-11 amended, user 2026-10-07):** a `CompletionItemProvider` for detected YAML files that answers only in the positions where Red Hat returns nothing, measured by a probe on 2026-10-07. Its items come from the served schema (the same `markdownDescription`, defaults and options). It returns nothing anywhere else, so the merged list never holds duplicates.

**Trigger rules (from the probe; "✗" means Red Hat gave 0 items):**

| Position | Example | Red Hat | Ours |
|---|---|---|---|
| empty block inside a component | `input.socket:`, `socket.tls:`, `- branch:`, `memory:`, broker `- stdout:` | ✗ | fields of that block |
| empty nested block outside components (corrected in review) | `logger.file:`, `http.cors:`, `redpanda.tls:` | ✓ | nothing |
| a partly typed key in such a block | `socket:` then `ad` | ✗ | fields of that block |
| empty value inside a component | `socket.network: `, `tls.client_auth: ` | ✗ | options of that field (booleans: `true`/`false`) |
| empty top-level block | `logger:`, `input:` | ✓ | nothing |
| block that already has a field | `socket:` + `network: tcp` | ✓ | nothing |
| empty list item | `processors:` then `- ` | ✓ | nothing |
| empty value outside components | `logger.level: ` | ✓ | nothing |

## Boundaries & Constraints

**Always:**
- **Where:** only for documents the DetectionRegistry reports as detected, and only when a schema snapshot exists.
- **Purity:** the context detection and item building are pure (`src/core`). Parsing uses `yaml` with a LineCounter (AD-2).
- **Field items:**
  - kind Property; label = field name; documentation = its `markdownDescription`;
  - insert text `name: ` with the scalar default as a snippet placeholder when there is one; `name:` plus a new indented line for objects; `name:` plus `- ` for arrays;
  - sorted by name.
- **Value items:**
  - kind Value; each option written with `yamlString` (2.14), with its description;
  - boolean fields get `true` and `false`.
- **Failure:** the provider never throws; any failure gives no items.
- **Guard test:** an integration test checks that, at every position in the trigger table, the merged list (ours plus Red Hat's) has no duplicate labels. Such duplicates would mean Red Hat has started covering the position.

**Never:**
- items in the positions marked "Red Hat ✓";
- a YAML language server of our own;
- schema validation;
- edits outside the completion's insert range;
- component-name completion (Red Hat does it).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| EMPTY_COMPONENT | `input:` / `socket:` / an empty line under it | 8 socket fields, each with its docs | — |
| NESTED_EMPTY | `socket:` + `network: tcp` + `tls:` / empty | the tls fields | — |
| PROCESSOR_ITEM | `- branch:` / empty | `processors`, `request_map`, `result_map` | — |
| PLAIN_NESTED | top-level `logger:` / `file:` / empty (outside components) | nothing; Red Hat completes it (corrected in review: `http.tls` is not a field) | — |
| PARTIAL_KEY | `socket:` / `ad` | the socket fields (VS Code filters to `address`) | — |
| EMPTY_VALUE | `socket.network: ` | `unix`, `tcp`, `udp`, `tls`, `unixgram` | — |
| BOOLEAN_VALUE | `socket.auto_replay_nacks: ` | `true`, `false` | — |
| SNIPPETS | inserting `address` / `tls` / an array field | `address: ` / `tls:` plus a new indented line / `name:` plus `- ` | — |
| DEFAULT | a field with a scalar default (`max_buffer`) | the placeholder holds the default | — |
| SILENT | every "Red Hat ✓" row | no items from us | — |
| NOT_DETECTED / NO_SCHEMA | a Kubernetes manifest; no snapshot | no items | — |
| NO_DUPLICATES | the merged list at every trigger position | no label twice | — |
| BROKEN | an unparseable document | no items | Never throws |

</frozen-after-approval>

## Code Map

- `src/core/yamlPath.ts`: `parseYaml`, `findKeyOnLine`, `findValueOnLine`, `yamlString`, `PathStep`.
- `src/core/schemaFields.ts`: `fieldsAt` (`all`, `components`), `optionsAt`, `expand` (`$ref`, `allOf`, `anyOf`).
- `src/adapters/vscode/quickFix.ts`: the shape of a provider; `src/extension.ts` registers providers. The detection registry and the schema store are on `ExtensionApi`.
- The probe matrix comes from a throwaway integration test against the fake binary serving the 4.112.0 fixtures (2026-10-07).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/schemaFields.ts`: `nodesAt(schema, path)` (expanded nodes), `insideComponent(schema, path)`, `fieldInfo(schema, path, key)` (docs, default, kind, options).
- [x] `src/core/gapCompletion.ts`: `gapContext(text, offset)` (block, value or none) and `gapItems(schema, context)`.
- [x] `src/adapters/vscode/completion.ts`: `GapCompletionProvider`, wired in `extension.ts`.
- [x] Tests: core units for every matrix row; integration tests for EMPTY_COMPONENT, EMPTY_VALUE, SILENT and NO_DUPLICATES through `executeCompletionItemProvider`.
- [x] `README.md`, `CHANGELOG.md`; the README known-limit text is updated.

**Acceptance Criteria:**
- Given `input:` / `socket:` and an empty line under it, when Ctrl+Space is pressed, then socket's 8 fields are offered with their docs.
- Given `network: ` inside socket, then its 5 options are offered.
- Given any position where Red Hat completes, then no label appears twice.

## Implementation Notes

- **Core** (`src/core/gapCompletion.ts`):
  - `gapContext(parsed, text, offset)` collects every pair (`allPairs`).
  - A **value** context is a line `key: ` with an empty value.
  - A **block** context is a blank line or a partly typed key below a pair whose value is empty (or a plain scalar starting on the cursor's line), with only blank or comment lines between them and a smaller key column. The pair must not be at the root.
  - A tab in the indentation gives no context.
  - `gapItems` answers only inside a component (`insideComponent`). It skips component-level mappings (left to Red Hat's component list).
  - `schemaFields.ts` gains `nodesAt`, `insideComponent` and `fieldInfo` (docs, scalar default, shape, boolean, deprecated, options).
- **Provider** (`src/adapters/vscode/completion.ts`):
  - registered for `yaml`; checks schema and detection;
  - items are Property or Value kind, with Markdown docs, snippets and sort order;
  - deprecated fields carry `CompletionItemTag.Deprecated`.
- **Red Hat sweep** (adversarial reviewer, Red Hat 1.24.0's server over LSP, transformed 4.112.0 schema, 1039 positions): after the fix, 0 positions where both answer, 950 gaps only we answer, 32 only Red Hat answers, 57 neither. Neither covers maps with free keys (`headers:`) and string-valued components (`inproc:`, `resource:`). I re-ran the sweep after the patch.
- **Mutation check:** without the block guard, NO_DUPLICATES fails at `logger.file` (case 14).
- **Known limits** (recorded):
  - an empty list item inside a component (`batching.processors: - `, `tls.client_certs: - `) gets nothing from either side;
  - object and array snippets use a 2-space child indent.

## Plan Change Log

- 2026-10-07 (review, correction of probe data; the agent's call, reported to the user): the probe's `http.tls` row was invalid (`http` has no `tls` field). Red Hat's own server shows it completes empty nested blocks outside components (`logger.file`, `http.cors`, …). Blocks therefore trigger only inside a component, as AD-11 states ("an empty component block"). The trigger table and the PLAIN_NESTED row are corrected.

## Review Triage Log

**Pass 1 (full: adversarial + edge-case, verification-gap; 2026-10-07):** 17 findings (deduplicated).
- **Patched:** 13.
- **Plan corrected (bad_plan):** 1.
- **Recorded as limits:** 2.
- **Rejected:** 1.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| A1 | Duplicates with Red Hat at plain nested blocks (`logger.file`, `http.cors`, `http.basic_auth`, `redpanda.tcp`, `redpanda.tls`) | high | patch | Blocks only inside a component; the sweep shows 0 overlaps; integration and mutation tests. |
| V2 | NO_DUPLICATES could pass without Red Hat answering | high | patch | Each case first waits for a Red Hat hover; at gaps the merged list must equal ours exactly; at Red Hat positions ours must be empty and Red Hat's non-empty. |
| A2 / V1 | The PLAIN_NESTED row was invalid (`http.tls` is not a field) | medium | bad_plan → corrected | Plan Change Log. |
| A3 / V3 | The guard did not cover every trigger position | medium | patch | 16 cases: partial key, boolean, `client_auth`, `memory`, broker `- stdout`, top-level `input:`, `- `, `logger.file`, `http.cors`. |
| V4 | No SILENT integration test | medium | patch | Asserts our provider is empty at every Red Hat position. |
| V5 | NOT_DETECTED and NO_SCHEMA untested | medium | patch | Provider test with stubs and a Kubernetes manifest. |
| V6 | AC "8 fields with docs" not asserted through VS Code | low | patch | Exact 8 Property labels; `network` docs contain the Options line. |
| V7 | Snippets never applied in VS Code | low | patch | `insertSnippet` test: `tls`, `max_buffer`, partial `ad` → `address: `, `client_certs` (array). |
| V8 | EMPTY_VALUE did not show the items are ours | low | patch | Provider asserted directly. |
| A6 | A tab in the indentation still triggered | low | patch | Rejected; tests. |
| A7 | Deprecated fields unmarked | low | patch | Deprecated tag; test. |
| V9 | README did not mention partial keys or booleans | low | patch | README and CHANGELOG. |
| A5 | Empty list items inside components get nothing | low | intent_gap → recorded | Known limit (Implementation Notes; E2 notes). |
| A8 | Snippets use a 2-space child indent | low | reject | Valid YAML; VS Code adds the line's own indentation. |

**Re-verification (parent):** `npm test` 456 passing; `npm run test:corpus` 65 passed; the Red Hat sweep was re-run (0 overlaps).

## Verification

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass.
- `npm run test:corpus`: 65 passed.

**Manual checks:**
- In the Extension Development Host: `socket:` with an empty line under it, then Ctrl+Space, offers the 8 fields; `network: ` then Ctrl+Space offers the options.
