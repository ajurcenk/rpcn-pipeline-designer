---
title: 'Keep lint findings on lines an edit did not touch'
type: 'feature'
ticket: '10'
created: '2026-10-24'
status: 'built'
baseline_revision: '5d6bd6ce2e9125b5383b1b1781d542e37a213927'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Lint findings are cleared on the first edit after a save (R3, AD-17), so applying one Quick Fix clears every other finding, and fixing several needs a save after each (E2 retrospective F2).

**Approach:** An edit drops only the lint findings on the lines it touched; the others stay, moved by the lines the edit added or removed, with their Quick Fixes, until the next save replaces them all. A finding is never shown on a line it did not come from: a change whose lines can't be told clears them all, as today. The graph's node markers follow the moved findings (AD-17). AD-17 and R3 are amended.

## Boundaries & Constraints

**Always:**
- Lint runs on save only (AD-12); a lint result for text an edit has changed since its save is still dropped.
- A finding is dropped when the edit changes its line's text (any character, the line joined to another, or the line deleted). A line is not touched by whole lines inserted or removed above it (an insertion at its column 0 ending in a newline, a removal ending at its column 0), or by new lines started at its end (an insertion there starting with a newline).
- All of an event's changes are in the coordinates before the event (as 4.10's tracking); the result does not depend on their order.
- A change without a range clears the findings (the old rule).
- The edit fires no diagnostics event of its own: the graph rebuilds on the same edit and reads the moved findings, so a status is never posted before its model (story 13's ordering).

**Never:**
- Changing the Red Hat dedupe (R4: suppression on Red Hat's lines, lint's syntax findings hidden while Red Hat reports one), which keeps Red Hat's own ranges.
- Changing 2.22's Fix all, the Quick Fixes, or when lint runs.
- Moving findings inside a line (they are whole-line).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| QUICK_FIX | findings on lines 6, 12, 20; the Quick Fix on line 6 replaces its key | 12 and 20 stay, with their Quick Fixes; 6 is gone | none |
| INSERT_ABOVE | findings on 12 and 20; two lines inserted at the start of line 12 (or Enter at the end of line 11) | on 14 and 22 | none |
| EDIT_LINE | a finding on 12; a character typed on it, the line deleted, or joined to 11 or 13 | removed | none |
| PASTE | findings on 9, 12, 16; lines 10–15 replaced by a paste of 3 lines | 12 removed; 9 stays; 16 on 13 | none |
| UNDO | an undo of an earlier insert above line 12 | the finding moves back up | none |
| MULTI_CHANGE | one event with two changes (above and below a finding) | only the change above moves it; same result in either order | none |
| NO_RANGE | a change event whose change has no range | all findings cleared | none |
| SAVE | moved findings, then a save | lint's fresh findings replace them all | none |
| GRAPH | a finding on a node; two lines inserted above it | the node keeps the marker, under its new id; no `nodeStatus` before the `model` | none |

</frozen-after-approval>

## Code Map

- `src/core/lint.ts` -- `LintFinding` (1-based `line`), `documentLine` (clamps a line past the end), `suppressFlaggedLines`. Add the pure line shift here: a held finding carries its line's text length (taken when lint's result is applied), so "at the line's end" can be told without the pre-change text.
- `src/adapters/vscode/diagnostics.ts` -- `LintDiagnostics`: `UriState.raw` (the findings), `runLint` (applies a result when `generation` is unchanged: take each line's length there), the `onDidChangeTextDocument` handler (today `shiftRedHat` then `invalidate`, which clears `raw` and bumps `generation`), `refresh` (publishes `raw` against Red Hat's lines, fires the event when the view's signature changes), `toDiagnostic` (whole line). `shiftRedHat` (story 13) also updates the stored signature so its shift fires nothing; the edit path should do this once for both.
- `src/adapters/vscode/quickFix.ts` -- finds the key on the diagnostic's current line (`findKeyOnLine`), so moved findings keep their fixes. No change expected.
- `src/core/processorTracking.ts` -- `TextChange` / `mapOffset`: the same pre-change-coordinates assumption (reference only; findings move by lines, not offsets).
- `src/test/adapters/vscode/diagnostics.test.ts` -- `FakeSource.edit(doc, change)` (default: a change with no range, so FIRST_EDIT still clears); FIRST_EDIT, STALE_RESULT and other edit tests.
- `src/test/integration/suites/50-lint.ts` -- the fake lint by `grep`, QUICK_FIX, FIX_ALL (one undo step); `src/test/integration/suites/82-graph-markers.ts` -- SEND / CLEAR ("the first edit clears them") and the HELD case's real view.
- Docs: `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` AD-17's last bullet; `epic-smart-yaml-editing/epic-smart-yaml-editing.md` R3; `ux-rpcn-vscode-designer/EXPERIENCE.md` (line 82, and the line-216 flicker note); `README.md` (lint paragraph: "The first edit after a save clears the findings", the Fix all rationale; graph paragraph: "lint's clear with them on the first edit"); `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/lint.ts` -- the pure shift of held findings through an event's changes (drop touched, move the rest, order-independent) -- the rule, testable without VS Code.
- [x] `src/test/core/` (the lint core tests) -- unit cases for every matrix row the shift decides (INSERT_ABOVE both ways, EDIT_LINE three ways, PASTE, UNDO, MULTI_CHANGE both orders, a line past the end).
- [x] `src/adapters/vscode/diagnostics.ts` -- hold each finding's line length when a result applies; on an edit, shift instead of clearing (no range: clear), still drop running and queued lint results, and refresh without firing the event (once, for Red Hat's shift too).
- [x] `src/test/adapters/vscode/diagnostics.test.ts` -- QUICK_FIX-style and NO_RANGE through the controller; the edit fires no event.
- [x] `src/test/integration/suites/50-lint.ts` -- AC 1 end to end: two findings, the Quick Fix on the first, the second stays with its fix; SAVE replaces them.
- [x] `src/test/integration/suites/82-graph-markers.ts` -- update SEND / CLEAR for the new rule; GRAPH row (marker kept on its node after an insert above, model before status).
- [x] Docs listed in the Code Map -- amend AD-17 and R3, EXPERIENCE, README, CHANGELOG.

**Acceptance Criteria:**
- Given findings on lines 6, 12 and 20 after a save, when the Quick Fix on line 6 is applied, then the findings on 12 and 20 stay with their Quick Fixes and 6's is gone.
- Given any moved findings, when the file is saved, then lint's fresh findings replace them all.
- Given the change, when compile, the unit suites, suites 50 and 82, and the full stable suite run, then all pass.

## Implementation Notes

- `src/core/lint.ts`: `HeldFinding` (finding + its line's text length), `holdFindings` (clamps a line past the end to the last line, where it is shown, and takes that line's length), `LineChange` and `shiftFindings`. A change ending at column 0 of a line leaves it whole when its text ends in a newline or it is a pure removal from column 0; a change starting at or past a line's end leaves it whole when its text starts with a newline.
- `diagnostics.ts`: `onEdit` replaces `invalidate` on the edit path (bumps generation, drops the queued rerun, shifts or clears `raw`, `refresh(uri, false)` which updates the signature without firing). `shiftRedHat` no longer updates the signature itself. Lengths are taken in `runLint` from the live document when the generation is unchanged.
- Outside the Code Map: `src/test/integration/suites/91-bloblang-diagnostics.ts` (LINT_DEDUPE / LINT_KEPT asserted the first edit clears lint) updated to the new rule; its "re-filtered" step now waits for the save's lint run and the live error first, since the edit already drops the held duplicate on its line; `src/adapters/vscode/quickFix.ts` header comment amended.
- Running `--grep "Extension tracer path|Lint on save|..."` alone fails the four Quick Fix tests in suite 50 at the baseline too (code actions return only Copilot's "Fix"/"Explain": the schema-backed provider needs state an earlier suite sets up); they pass in the full suite.

- Review fixes: `onEdit` shifts only the findings shown before the edit (`shown`, the live Bloblang duplicate filter plus `suppressFlaggedLines` on Red Hat's own ranges, shared with `refresh`), so a hidden duplicate never reappears off Red Hat's or Bloblang's stale lines; an edit while a save's lint is running or queued clears the held findings instead of shifting them; `UriState.version` (the version `raw` is for, set on apply, on edit, on invalidate and on the first refresh) makes a `refresh` for a newer version (another listener of the same edit, such as Bloblang's republish when the YAML parses again) publish and fire nothing. Unit tests for the running-lint and Red Hat-hidden cases; EXPERIENCE (diagnostics timing, Flow 1 steps 8 and 9, the flicker note), AD-12's 4.5 amendment and the spec's success line amended.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 3 medium, 5 low; no unmet acceptance criterion. All routed patch; fixed by the implementer (re-engaged) and verified by the full stable suite (917 passing).

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | After an edit, the Red Hat dedupe (Red Hat's own, not yet republished ranges) runs against already shifted lint findings: a hidden duplicate shows (next to Red Hat's held copy) until Red Hat republishes | medium | patch | Confirmed. `onEdit` shifts only the findings shown at that moment (one `shown` filter for both), so a hidden one is dropped (it would not show before the next save); the dedupe keeps Red Hat's own ranges (the plan's Never). Test: a finding hidden by Red Hat's line stays hidden after an insert above. |
| 2 | Same for the Bloblang duplicate filter (`liveErrorsFor` spans from the last publish) | low | patch | Same root and fix as 1. |
| 3 | On the edit that makes the YAML parse again, Bloblang's immediate republish (story 18; its listener runs first) reaches `refresh` before `onEdit`: unshifted findings are published against the new text and a `nodeStatus` goes out before the `model` | medium | patch | Confirmed (`extension.ts` creates BloblangDiagnostics first). `UriState.version`: `refresh` skips a document version newer than the findings'; `onEdit`'s own refresh follows in the same event. |
| 4 | An edit while a save's lint is running keeps the earlier save's findings, shifted, after the newer save (AC: a save replaces them all) | medium | patch | Confirmed. An edit while a lint is running or queued clears them; test with ranged edits. |
| 5 | `onDidChangeDiagnostics`' doc comment still says it fires on every change of `diagnosticsFor` | low | patch | Amended. |
| 6 | EXPERIENCE line 91, Flow 1 steps 8 and 9 and the line-216 reference, AD-12's 4.5 amendment, the spec's line 33 still describe the old rule | low | patch | Amended, dated ticket 10. |
| 7 | Verification command 3 can't pass alone (suite 50's schema-backed Quick Fix tests need an earlier suite) | low | patch | The plan says they are verified by the full suite. |
| 8 | The queued-rerun / stale-result tests use range-less edits only | low | patch | Ranged-edit test added (with 4). |

Matrix audit (full suite): QUICK_FIX (core, controller, suite 50), INSERT_ABOVE (core, suite 50), EDIT_LINE, PASTE, UNDO, MULTI_CHANGE (core), NO_RANGE (controller), SAVE (suite 50), GRAPH (suite 82): all ran and passed.

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "core/lint|adapters/vscode LintDiagnostics"` -- expected: all pass.
- `xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|Lint on save|Pipeline graph: markers"` -- expected: all pass except suite 50's schema-backed Quick Fix tests, which need an earlier suite's setup when run alone; those are verified by the full suite (command 4).
- `xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.

**Manual checks:**
- In the dev host: a config with three lint findings, saved; apply the Quick Fix on the first: the other two stay with their light bulbs; insert lines above them: they move; type on one: it goes; save: lint's findings replace them.
