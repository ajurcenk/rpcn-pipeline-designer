---
title: 'Unknown-field Quick Fix inside name-keyed maps'
type: 'feature'
ticket: '7'
created: '2026-10-23'
status: 'built'
baseline_revision: 'c063d6cfee3ecb5ac08f013630f3cf6195dfaa08'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Quick Fixes for an unknown field ("Change to `<name>`", 2.5) and for an invalid option value (2.14) walk the schema through `properties` and `items` only (`src/core/schemaFields.ts`). They stop at maps whose keys are free names (`workflow.branches.<name>`, whose value schema is `patternProperties['.']`, or maps with an `additionalProperties` schema), so a typo inside such an entry is flagged on save but gets no fix (recorded limit, 2.5 review A4).

**Approach:** For the Quick Fixes only, a step by a name that is not one of a node's `properties` goes into the node's map value schema: `patternProperties['.']`, else an `additionalProperties` schema, the same rule the schema transform uses for `map` fields. Then fields inside a named entry get the same fixes, ranking and preferred rule as anywhere else, and the fix still replaces only the key or value token. The map key itself is never fixed (lint does not flag it, and the walk at the map gives no names). Gap completion (2.16) keeps walking without this step, since its gaps are calibrated not to overlap YAML by Red Hat's completion. The 2.5 test pinning the limit is inverted, not deleted.

</frozen-after-approval>

## Implementation Notes

Oneshot: one step helper in `schemaFields.ts`, an opt-in flag on `fieldsAt`, the Quick Fix walkers using it, and tests.

- `src/core/schemaFields.ts`: `stepInto(node, step, throughMaps)` replaces the three inline steps. `candidateFields`, `optionsAt` and `validFieldsAt` (test-only) step through maps; `fieldsAt`'s default and `nodesAt` (gap completion, `fieldInfo`, `requiredFieldsAt`) do not. The value schema is `patternProperties['.']` (what `workflow.branches` uses in 4.112.0), else an `additionalProperties` schema, as `elementNode` in `schema.ts`.
- `src/test/core/quickFixCore.test.ts`: the 2.5 pin (`known limit`) inverted into its own test (branch fields, deeper processors, the map itself undefined, `fieldsAt` default unchanged); end to end `request_mapp` → `request_map` and no fix for the branch name (AC 2).
- `src/test/integration/suites/50-lint.ts`: the fake lint flags `request_mapp:`; a QUICK_FIX case in a workflow branch (first, preferred, only the key changes). The 2.5 and 2.14 tests pass unchanged (AC 3).
- `CHANGELOG.md`: an entry.
- Flake found on the way (not caused here): in suite 50 the Quick Fix tests sometimes get no action from the provider (`executeCodeActionProvider` lists only "Fix" / "Explain"), on the baseline too (1 of 6 runs; 2 of 6 with this change, where every Quick Fix test of that run fails). A probe that only built a longer failure message before the assertion made 8 of 8 runs pass, so it looks like the request racing the diagnostics. Deferred.

## Review Triage Log

Quick review. Verdicts: 0 high, 0 medium, 4 low, 0 false. The reviewer compared the old and new walk on 200,000 schema paths: no difference wherever the old walk gave a result.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | No test for the option-value fix (2.14) inside a map | low | patch | `optionsAt` for `compress.algorithm` in a branch equals the top-level list; added. |
| 2 | The `additionalProperties` fallback is never reached (4.112.0 has only `patternProperties['.']` maps) | low | patch | A synthetic schema test added. |
| 3 | Nothing checks `nodesAt` still stops at a map (gap completion's `fieldInfo` / `requiredFieldsAt`) | low | patch | `nodesAt(branch)` is `[]`; added. |
| 4 | The new integration test leaves out the 2.5 test's "lint findings clear" check | low | patch | Added. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "core/suggest|core/yamlPath findKeyOnLine|core/schemaFields|core quick-fix|core/gapCompletion"` and `--grep "Extension tracer path|Lint on save"` -- expected: all pass.
