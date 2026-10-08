---
title: 'Required fields item in a new component block'
type: 'feature'
ticket: '17'
created: '2026-10-07'
status: done
baseline_revision: '29a239c1ff77fd1bcd0a2d9e7d7e3a3a5400f9b2'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-completion-where-red-hat-returns-none-plan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A newly added component (`socket:`) starts empty. The user has to know which of its fields are needed, then add them one at a time. Lint reports the missing ones only on save.

**Approach (user, 2026-10-07: "yes build 1"):**
- **The item:** in the empty component block (the 2.16 gap), the list starts with one preselected item, `<component>: required fields`. It inserts the required fields as one snippet.
  - Fields with options become a choice tab stop (`network: ${1|unix,tcp|}`).
  - A scalar default becomes a placeholder.
  - Objects and lists open on an indented line.
- **The data:** the transform keeps each node's `required` list under the private key `x-rpcn-required`, which Red Hat ignores. Validation does not change. `TRANSFORM_VERSION` becomes 4.

**Decisions (the agent's, from a check against the real 4.112.0 binary over 245 components):**
- **Which list:** the schema's `required` list, minus deprecated fields, is used. Lint never demands more than it. In 71 components it lists more than lint demands, mostly list fields such as `file.paths` or `kafka.addresses`, which lint accepts empty but the component cannot work without. That makes it the better scaffold.
- **When:** the item is not offered while a first key is partly typed (the 2.16 partial-key case). It is not offered for components without required fields.

## Boundaries & Constraints

**Always:**
- **Where:** the same gap rules as 2.16; the provider stays silent wherever Red Hat answers.
- **Snippet:** tab stops follow schema order. Choice values are escaped, and options are written with `yamlString`.
- **Existing items:** the per-field items stay below the new one.

**Never:**
- changing Red Hat's own component-name insertion;
- re-adding `required` to what Red Hat validates;
- inserting optional fields.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SOCKET | `input.socket:` + empty line | first item `socket: required fields`, inserting `network: ${1\|unix,tcp\|}` and `address: $2` | — |
| GENERATE | `input.generate:` empty | `mapping: $1` | — |
| ARRAY_OBJECT | `kafka_franz` | `seed_brokers:` + `- $1`, then `topic: $2`; deprecated `rack_id` left out | — |
| PROCESSOR | `- branch:` empty | `processors:` + `- $1` | — |
| NONE | `stdin:` (no required fields) | no required item; the field items as before | — |
| PARTIAL | `socket:` then `ad` | no required item | — |
| INSERT | apply the socket item in VS Code | `network: unix` (first choice) / `address: ` at the block's indentation | — |
| TRANSFORM | the transformed 4.112.0 schema | no `required` anywhere; `x-rpcn-required` on `socket` = `[network, address]`; version 4 | — |

</frozen-after-approval>

## Code Map

- `src/core/schema.ts`: `dropRequired` (2.13), `forEachSubSchema`, `TRANSFORM_VERSION`.
- `src/core/schemaFields.ts`: `nodesAt`, `fieldInfo` (`deprecated`, `options`, `shape`, `default`).
- `src/core/gapCompletion.ts`: `gapContext` (block, value), `gapItems`, `fieldSnippet`, `escapeSnippet`.
- `src/adapters/vscode/completion.ts`: maps item kinds.
- Tests: `src/test/core/gapCompletion.test.ts`, `src/test/core/schema.test.ts`, and the SNIPPETS integration test (`insertSnippet`).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/schema.ts`: `x-rpcn-required`, version 4.
- [x] `src/core/schemaFields.ts`: `requiredFieldsAt`.
- [x] `src/core/gapCompletion.ts`: a `partial` flag on block contexts; the required item and its snippet.
- [x] `src/adapters/vscode/completion.ts`: Snippet kind, preselected.
- [x] Tests for every row; README and CHANGELOG.

**Acceptance Criteria:**
- Given `input:` / `socket:` and an empty line, when Ctrl+Space is pressed, then `socket: required fields` is first, and inserting it gives `network:` (choice `unix` / `tcp`) and `address:`.

## Implementation Notes

- **Real-binary check (4.112.0):** I linted an empty block of each of the 245 input, output and processor components.
  - Lint never demands a field that is missing from the schema's `required` list.
  - In 71 components the schema lists more than lint demands, mostly list fields (`file.paths`, `kafka.addresses`, `amqp_0_9.urls`) plus a few objects (`jira.auth`, `jira.cursor`).
  - 2 required fields are deprecated (for example `kafka_franz.rack_id`) and are left out.
- **Item:** `gapItems` puts the item first. Its kind is `Snippet` and it is preselected. It is skipped when `partial` is set (a partly typed key) or when nothing is required.
- **Existing tests:** the 2.13/2.15 version tests now pin 4, and two 2.16 tests now include the new first item.
- **INSERT test:** in VS Code, the socket item gives `network: unix` / `address: ` at the block's indentation.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, inline by the parent, 2026-10-07):** I checked the diff against the frozen block, the snippet escaping (choices escape `,|$}\`), the real-binary comparison above, and that the 2.16 NO_DUPLICATES guard still passes (the new label is unique). No findings.

**Re-verification:** `npm test` 459 passing; `npm run test:corpus` 65 passed.

## Verification

**Commands:**
- `npm test`: all pass.
- `npm run test:corpus`: 65 passed.
