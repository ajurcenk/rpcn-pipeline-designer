---
title: 'Quick Fix for invalid option values'
type: 'feature'
ticket: '14'
created: '2026-10-07'
status: 'built'
baseline_revision: '5619a4ea03984442ef993f4c283c8e2022ac9584'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-quick-fix-for-unknown-fields-plan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** For 198 fields with a closed option list, lint on save reports `value X is not a valid option for this field` (checked with 4.112.0: `network: banana`, `client_auth: maybe`, `logger.format: xml`). The user then has to look up the valid values.

**Approach:**
- A second Quick Fix in the 2.5 provider handles this lint message.
- It finds the value's key on the diagnostic line, takes that field's options from the served schema (the `enum` suggestion added in 2.13), and offers "Change to `<option>`" for the closest options.
- Applying a fix replaces only the value token (AD-19).

**Decisions (user, 2026-10-07: "add the Quick Fix ticket and build it"; defaults chosen by the agent and reported):**
- **Ranking:** as in 2.5. Up to 3 options within `min(3, max(1, ⌊len/3⌋))` edits, compared case-insensitively, because lint's rule is case-insensitive. Preferred only for a clear winner.
- **Fallback:** if no option is that close and the field has at most 5 options, all of them are offered (alphabetical, none preferred), since the list is closed. Longer lists offer nothing.
- **Quoting:** an option that YAML would not read back as that exact string is written as a double-quoted string. The check uses `yaml` in `src/core`.
- **Scope:** only values of mapping pairs (`key: value`); sequence items are out (no option field in 4.100.0 or 4.112.0 is an array).
- **Naming:** the provider class is renamed `LintQuickFix`, because it now handles two messages.

## Boundaries & Constraints

**Always:**
- **Diagnostics:** the fix applies only to diagnostics with source `Redpanda Connect` and the message `value <X> is not a valid option for this field`.
- **Edit:** a single `WorkspaceEdit.replace` of the value scalar's source range, quotes included. Nothing else changes.
- **Purity:** the value lookup, options lookup, ranking and quoting are pure (`src/core`).
- **Failure:** no snapshot, no options for that path, or no matching value on the line means no actions. The provider never throws.
- **2.5 unchanged:** the 2.5 fixes and their tests keep passing.

**Never:**
- strict schema enums;
- fixes for Red Hat diagnostics;
- re-serialising the document;
- changing the key;
- changing any value other than the flagged one.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CLOSE | `network: tpc` under `input.socket_server`, lint `value tpc is not a valid option…` | "Change to `tcp`" first, preferred; applying it changes only `tpc` | — |
| CASE | `format: JSN` under `logger` | `json` offered | — |
| FALLBACK | `client_auth: maybe` (5 or fewer options, none close) | every option, none preferred | — |
| LONG_LIST | far-off value for a field with more than 5 options | no actions | — |
| QUOTED | `network: "tpc"` | replaces `"tpc"` with `tcp` | — |
| NEEDS_QUOTES | an option such as `OFF` or `no` would be retyped by YAML | written as `"OFF"` | — |
| TOP_LEVEL | `logger.format: xml` | `json` / `logfmt` (fallback) | — |
| NO_MATCH | value not on that line, or another value | no actions | Never throws |
| NO_OPTIONS | the field has no option suggestions in the schema | no actions | — |
| BOTH | one request with an unknown-field and an invalid-option diagnostic | both sets of fixes | — |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/quickFix.ts` (2.5): `UnknownFieldQuickFix(schema)`, `UNKNOWN_FIELD` regex, `parseYaml` once per request, `findKeyOnLine`, `candidateFields`, `rankNames`, `hasClearWinner`.
- `src/core/yamlPath.ts`: `parseYaml`, `findKeyOnLine`; a `collect` walk over maps and sequences with paths; `PathStep`.
- `src/core/schemaFields.ts`: `fieldsAt` and `expand` (`$ref`, `allOf`, `anyOf`).
- `src/core/suggest.ts`: `rankNames`, `maxDistance`, `editDistance`.
- `src/core/schema.ts` (2.13): option suggestions as `anyOf: [{type: string, enum, markdownEnumDescriptions?}, {type: string}]`.
- `src/extension.ts`: registers the provider.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/yamlPath.ts`: `findValueOnLine(parsed, line, value)`, giving the key, the path to its mapping, and the value range.
- [x] `src/core/schemaFields.ts`: `optionsAt(schema, path, key)`, which collects the string `enum`s of that field.
- [x] `src/core/suggest.ts`: a case-insensitive ranking option. `src/core/yamlScalar.ts` (or in `yamlPath`): `yamlString(value)` for quoting.
- [x] `src/adapters/vscode/quickFix.ts`: rename to `LintQuickFix`, add the option fix, update `extension.ts`.
- [x] Tests: core units for every row, provider tests, and an integration test (a fake lint emits the message, then apply).
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given `network: tpc` flagged by lint, when Quick Fixes are requested, then "Change to `tcp`" is offered first, and applying it changes only the value.
- Given `client_auth: maybe`, then all of that field's options are offered and none is preferred.

## Implementation Notes

- **Core.**
  - `findValueOnLine(parsed, line, value)` is in `src/core/yamlPath.ts`. It matches a mapping pair's scalar value by its value or its source text, and skips anchored values.
  - `yamlString` is in the same file. It writes a value plain only when YAML reads it back unchanged, with no YAML 1.1 boolean words, no flow indicators and no leading indicator; otherwise it double-quotes it.
  - `optionsAt(schema, path, key)` is in `src/core/schemaFields.ts`.
  - `rankNames(…, ignoreCase)` is in `src/core/suggest.ts`.
- **Provider.** `LintQuickFix` is the renamed 2.5 class; `fieldFixes` is unchanged. `optionFixes` offers the close options, then falls back to all options for lists of at most 5. A shared `actions()` builds the edits.
- **Real data** (review and parent scans): 326 options in 4.100.0 and 334 in 4.112.0. Only `no` and `OFF` get quoted.
- **Lint behaviour** (real 4.112.0):
  - Lint prints the decoded value: `1`, `true`, `"tp c"` and `'it''s'` all match.
  - It is case-insensitive.
  - Empty, null and `~` values produce `value  is not…`, which the pattern does not match, so there is no fix.
- **Known gap:** a block-scalar value (`network: |` with `tpc` on the next line) gets no fix. Lint reports the content line, and the scalar starts on the `|` line.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-07):** 7 low findings. 6 were patched and 1 was recorded as a known gap. No intent_gap or bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Block-scalar values get no fix | low | accept (known gap) | Implementation Notes. |
| 2 | An alias value is reported at its anchor; editing the anchor would change every alias | low | patch | Anchored values are skipped; test. |
| 3 | `yamlString` left `,[]{}` plain (breaks flow mappings) | low | patch | Quoted; test. |
| 4 | A leading `%` made `yaml.parse` emit a warning | low | patch | Leading indicators are quoted before parsing; test. |
| 5 | LONG_LIST and NO_OPTIONS could pass vacuously | low | patch | Asserts that `logger.level` has more than 5 options, plus a positive control (`DEBG` → `DEBUG`) and a found-but-no-options check. |
| 6 | The integration test did not assert that lint clears after the edit | low | patch | Assertion added. |
| 7 | Numeric and flow-mapping values untested | low | patch | Tests: `network: 1` falls back to all 5; a flow mapping is edited in place. |

**Re-verification (parent):** `npm test` 435 passing; `npm run test:corpus` 65 passed; the quoting scan on both fixtures is unchanged (`no`, `OFF`).

## Verification

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass.
- `npm run test:corpus`: 65 passed.
