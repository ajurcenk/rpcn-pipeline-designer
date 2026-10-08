---
title: 'Fix all lint findings with a clear winner in one edit'
type: 'feature'
ticket: '22'
created: '2026-10-08'
status: done
baseline_revision: '5c94ce6c26a581b6e8c11d79dce98792eade829b'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Quick Fix is a text edit, and the first edit after a save clears every lint finding in the file (E2 R3, AD-17). Fixing several findings therefore needs a save after each fix (E2 retrospective F2).

**Approach (user, 2026-10-08: "go with D now, add a backlog story for B"):** next to the per-finding fixes (2.5, 2.14), `LintQuickFix` offers one more action. It applies, as a single `WorkspaceEdit`, the preferred fix of every lint finding in the file that has a clear winner. The clear-on-edit rule is unchanged; keeping findings on untouched lines is backlog story 10.

**Decisions (agent defaults, from investigation; reported at the checkpoint):**
- **Title:** "Fix all lint findings with a clear fix (N)", where N is the number of findings it fixes.
- **When offered:** on any lint diagnostic that `LintQuickFix` handles, and only when N ≥ 2. With one, the per-finding preferred fix is the same edit.
- **Kind:** `QuickFix`, never preferred, so Auto Fix keeps choosing the per-finding fix.
- **No `source.fixAll`:** `editor.codeActionsOnSave` runs just before a save. By then any edit since the last save has already cleared the findings, so the action would only ever run when the file is saved twice without a change.

## Boundaries & Constraints

**Always:**
- **Findings:** all lint diagnostics currently shown for the document (source `Redpanda Connect`, the two handled messages), not only those passed in the request's context.
- **Same choices:** each finding's edit is exactly what its per-finding preferred fix would do (same ranking, same `yamlString` quoting, same token range, AD-19).
- **One edit:** one `WorkspaceEdit` with one replace per fixed finding. Two findings resolving to the same or overlapping ranges are applied once; the first in document order wins.
- **Diagnostics:** the action's `diagnostics` lists every finding it fixes.
- **Unchanged:** the 2.5 and 2.14 per-finding actions and their order; the action is appended after them. No action for a finding without a clear winner (including the 2.14 "all options" fallback).
- **Failure:** no schema, or fewer than 2 fixable findings, gives no Fix-all action. The provider never throws.

**Never:**
- re-running lint, or saving the file;
- changing the clear-on-edit rule (R3, AD-17);
- a `source.fixAll` kind or a `codeActionsOnSave` contribution;
- fixing Red Hat diagnostics.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| THREE | lint: `topci` (kafka_franz), `adress` (socket_server), `network: tpc` | per-finding fixes as today, plus "Fix all lint findings with a clear fix (3)"; applying it gives `topic`, `address`, `tcp` in one edit | — |
| FROM_ANY_LINE | the request range covers only the `tpc` line | the Fix-all action still covers all 3 | — |
| SKIP_UNCLEAR | adds a finding whose ranking is a tie, or the 2.14 short-list fallback | N excludes it; its line is unchanged | — |
| ONE | a single fixable finding | no Fix-all action | — |
| SAME_RANGE | two diagnostics for the same token | one replace | — |
| FLOW | `{topci: t, netwrk: tcp}` in one flow mapping, both flagged | both keys replaced in one edit | — |
| NO_SCHEMA | no snapshot | no actions at all, as today | Never throws |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/quickFix.ts`:
  - `LintQuickFix(schema)`, `provideCodeActions` (filters `context.diagnostics` by `LINT_SOURCE` and the two regexes);
  - `fieldFixes` and `optionFixes` (ranking plus `hasClearWinner`);
  - `actions()` builds one `CodeAction` per suggestion, `isPreferred = preferred && i === 0`.
  - Reuse: the preferred action of each finding is the per-finding result whose `isPreferred` is true. Fix-all is the merge of those edits; don't duplicate the ranking.
- **All findings:** the provider currently sees only the range's diagnostics. Add an optional constructor dependency `allDiagnostics: (uri) => readonly vscode.Diagnostic[]`, defaulting to `vscode.languages.getDiagnostics(uri)`. The other providers take options objects; keep `schema` as the first argument so `extension.ts` and the tests stay valid.
- `src/core/suggest.ts` `hasClearWinner`; `src/core/yamlPath.ts` `findKeyOnLine`, `findValueOnLine`, `yamlString`; `src/adapters/vscode/parseCache.ts` `parsedDocument(doc)` (one parse per version).
- `src/extension.ts` `registerEditorProviders`: the registration and `providedCodeActionKinds` stay as they are (QuickFix only).
- Tests:
  - `src/test/adapters/vscode/quickFix.test.ts` has the `lintDiagnostic` and `actions()` helpers; `applied()` asserts exactly one edit, so add a multi-edit helper.
  - `quickFixOptions.test.ts` covers the option fixes.
  - `src/test/integration/suites/50-lint.ts` QUICK_FIX and OPTION_FIX use a fake lint that prints chosen findings (pattern to copy).
- README "Lint on save" paragraph; CHANGELOG `[Unreleased]`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/vscode/quickFix.ts`: add the `allDiagnostics` dependency and the Fix-all action. Collect each handled lint diagnostic's preferred edit, drop same or overlapping ranges, and offer the action when N ≥ 2. One user action instead of one save per fix.
- [x] `src/test/adapters/vscode/quickFix.test.ts` (or a new `quickFixAll.test.ts`): unit tests for every matrix row, with `allDiagnostics` stubbed. Edge cases.
- [x] `src/test/integration/suites/50-lint.ts`: FIX_ALL. A fake lint reports 3 findings; save; request actions on one line; apply Fix-all through `vscode.workspace.applyEdit`; the document text has all 3 fixes. End to end with real Red Hat and the registered provider.
- [x] `README.md`, `CHANGELOG.md`: document the action and why it exists. Docs.

**Acceptance Criteria:**
- Given a saved file with three clear-winner lint findings, when the light bulb on any of them is opened, then "Fix all lint findings with a clear fix (3)" is offered after the per-finding fixes, and applying it fixes all three in one undo step.
- Given the fixed file is saved, then lint reports none of the three.

## Implementation Notes

- `LintQuickFix(schema, allDiagnostics = getDiagnostics)`. Fix-all reuses the per-finding results: for each handled diagnostic in `allDiagnostics(doc.uri)` it takes the action with `isPreferred` and that action's single replace. Candidates are sorted by offset; an identical replace (same range, same text) adds its diagnostic to the action without a second replace; an overlapping, different one is dropped (first in document order wins). N is the number of replaces.
- Fix-all is computed only when the request carries at least one handled diagnostic. A throw while building it (e.g. from `allDiagnostics`) drops only the Fix-all action; the per-finding fixes are still returned.
- Unit tests in `src/test/adapters/vscode/quickFixAll.test.ts` (matrix rows plus Red Hat filtering and a throwing `allDiagnostics`). The FLOW row uses `socket_server: {netwrk: tcp, adress: x}`, because `topci` and `netwrk` don't belong to the same component. The integration FIX_ALL test also checks that one `undo` reverts all three replaces and that the next save reports none.
- Verification: `npm run compile` exit 0; `npm test` 520 passing on stable and on 1.100.0; `npm run test:corpus` 89 passed. The manual dev-host check has not been done.

## Plan Change Log

## Review Triage Log

**Pass 1 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment; 2026-10-08):** 17 findings. 0 high, 0 medium, 5 low patched, 1 low patch found unreachable (accepted), 5 low rejected, 6 false. No intent_gap or bad_plan. Verification-gap: no gaps.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|---|
| 1 | blind, edge, intent | The title's N counts distinct replaces, not findings; SAME_RANGE shows "(2)" for 3 fixed diagnostics | low | patch | The frozen Decision says "N is the number of findings it fixes". The title now uses the fixed-diagnostics count; the offer still needs at least 2 distinct replaces. |
| 2 | blind | The overlap-drop branch (first in document order wins) is untested | low | patch → accept | Not testable through the real ranking. Each fix replaces one key or value token, and distinct tokens never overlap; two diagnostics on one token always get the same replace, which is the SAME_RANGE path. The branch stays as a guard. |
| 3 | blind | Fix all is rebuilt in full on every code-action request | low | reject | It runs only for lint findings in the file (a handful) on a light-bulb request; caching adds state for no measured cost. |
| 4 | blind | `preferred.edit.get(uri)[0]` assumes one replace per per-finding action | low | reject | `actions()` in the same file always builds exactly one replace (`quickFix.ts`, `actions`); covered by the THREE edit-count assertion. |
| 5 | blind | No `source.fixAll` kind | false | reject | Frozen Decision: no `source.fixAll`, because findings are already cleared when `codeActionsOnSave` runs. |
| 6 | blind | Errors in `fixAll` are swallowed without a log | low | reject | Same never-throw pattern as the rest of the provider; the retro's P1/A5 tracks logging for all providers. |
| 7 | blind | Fix all is offered only from a line with a handled finding | false | reject | Frozen Decision: "on any lint diagnostic that `LintQuickFix` handles". |
| 8 | blind | The ONE test's name does not match its first half | low | patch | Split or renamed. |
| 9 | blind | Weak assertions: the tie test does not check `diagnostics` | low | patch | Assertion added. The THREE ordering claim is false: it asserts Fix all is the last action. |
| 10 | blind | Missing cases: two of ours in one request, stale diagnostics, deprecation mix | false | reject | Fix all is built once per request whatever the context holds. Published lint diagnostics are cleared synchronously on the first edit (`diagnostics.ts` `invalidate`), so stale ones cannot reach the provider. Deprecation warnings are filtered out by `handled`. |
| 11 | blind | The integration test ends with a 500 ms sleep before asserting no findings | low | reject | The fake lint's output follows from the file text, which the test asserts exactly before saving. The real-binary dev-host check covers a clean re-save. |
| 12 | blind | The global `adress:` rule in the fake lint changes every suite test | low | reject | No other test in `50-lint.ts` contains `adress:`; the suite count is unchanged apart from FIX_ALL. |
| 13 | blind | CHANGELOG parenthetical reads as a caveat | low | patch | Reworded as the reason for the action. |
| 14 | blind | The README paragraph is long and omits "never preferred" and overlaps; no ticket refs | false | reject | README says what users meet; Auto Fix behaviour is unchanged and needs no note. |
| 15 | edge | Duplicate diagnostic listed as fixed but its token unchanged | false | reject | A duplicate is merged only when range and new text are identical, so the one replace changes that exact token. |
| 16 | edge | Fix all built for non-QuickFix requests (`context.only`) | false | reject | The provider is registered with `providedCodeActionKinds: [QuickFix]` (`extension.ts`), and VS Code filters returned actions by `only`. |
| 17 | intent | Auto Fix and "no `source.fixAll`" checked only through `isPreferred` and an unchanged registration | false | reject | Both are statically true: Auto Fix reads `isPreferred`, and the kind list is unchanged. The integration test asserts the action's position through `executeCodeActionProvider`. |

## Verification

**Re-verification after the review patches (parent, 2026-10-08):** `npm run compile` clean; `npm test` 521 passing on VS Code stable and on 1.100.0; `npm run test:corpus` 89 passed. **Manual check done (user, 2026-10-08, "tested"):** `scripts/dev-host.sh` with the user's `rpk connect` (Redpanda Connect 4.112.0) on `.dev-host/workspace/fix-all-demo.yaml` (`network: tpc`, `adress`, `topci`): save, Fix all from the light bulb, one undo step, save again.

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass on VS Code stable and 1.100.0; the count grows.
- `npm run test:corpus`: 89 passed.

**Manual checks:**
- With `scripts/dev-host.sh` and a real binary: save a file with two typos and an invalid option, open the light bulb on one of them, choose Fix all, save, and see no findings.
