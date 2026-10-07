---
title: "Hover lists a field's options"
type: 'feature'
ticket: '15'
created: '2026-10-07'
status: 'built'
baseline_revision: 'd371572df0679e5f46860bb55a4c01868bfb49bf'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-schema-completion-fixes-incomplete-components-and-value-options-plan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The allowed values of a field show up only while typing a value (completion) or after a failed save (Quick Fix). Hover on the field shows its description and examples, but not its options, so there is no way to see the list without typing.

**Approach:** `fieldMarkdown` adds a line `Options: \`a\`, \`b\`, …` (the field's json-full `annotated_options` values, else its `options`, in the docs' order) between the description and the examples. `TRANSFORM_VERSION` becomes 3.

**Decision (user, 2026-10-07):** "Yes, add options line to hover text."

## Boundaries & Constraints

**Always:**
- **Values:** the same values as the 2.13 suggestions (shared `optionsOf`), and only the values. The descriptions stay on the completion items, to keep the hover short.
- **Inline code:** each value is wrapped as inline code, with a longer backtick fence when the value itself contains a backtick.
- **Fields without options:** their hover text does not change.

**Never:**
- changing the `enum` suggestions;
- changing `type` or `default`;
- validation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HOVER_NETWORK | hover `network` under `input.socket_server` | contains `Options: \`unix\`, \`tcp\`, \`udp\`, \`tls\`, \`unixgram\`` | — |
| ANNOTATED | `file.codec` | `Options: \`all-bytes\`, \`append\`, \`delim:x\`, \`lines\`` before `Examples:` | — |
| NO_OPTIONS | a field without options | markdown unchanged | — |
| ONLY_OPTIONS | a field with options but no description | the markdown is the options line alone | — |
| BACKTICK | an option containing a backtick | rendered with a double-backtick fence | — |
| VERSION | `TRANSFORM_VERSION` | 3 | — |

</frozen-after-approval>

## Code Map

- `src/core/schema.ts`: `fieldMarkdown(field)` (description, then the examples as a YAML list); `optionsOf(field)` (2.13); `applyField`; `TRANSFORM_VERSION = 2`; the header comment for step 5.
- `src/test/core/schema.test.ts`: `fieldMarkdown` tests and the 2.13 suite.
- `src/test/extension.test.ts`: the contributor suite has `hoverText(doc, position)` (real Red Hat).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/schema.ts`: the options line in `fieldMarkdown`, version 3, the header comment.
- [x] Tests: unit tests for every matrix row, and an integration hover on `network`.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given `network` under `socket_server`, when hovered, then the hover lists its five options.

## Implementation Notes

- **Code:** `fieldMarkdown` uses the shared `optionsOf` (2.13) and `inlineCode` (a longer fence for values with backticks). `TRANSFORM_VERSION` is 3.
- **4.112.0:** 216 fields get the line. The longest is 204 characters (a scanner `codec` list).
- **Test change:** the 2.13 SKIP test now expects the hover line on a node that has its own `enum`; that `enum` is untouched.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, inline by the parent, 2026-10-07):** the change is about 20 lines. I checked the diff, the fixture scan (216 fields, nothing malformed), the backtick fence and the hover through real Red Hat. No findings.

**Re-verification:** `npm test` 439 passing; `npm run test:corpus` 65 passed.

## Verification

**Commands:**
- `npm test`: all pass.
- `npm run test:corpus`: 65 passed.
