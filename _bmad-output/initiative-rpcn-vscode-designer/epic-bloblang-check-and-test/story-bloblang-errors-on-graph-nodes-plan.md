---
title: 'Bloblang errors on graph nodes'
type: 'feature'
ticket: '6'
created: '2026-10-14'
status: done
baseline_revision: 'ae3ee8fb220d87e6ae74c9472f9ad156c62a1b04'
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

**Problem:** 4.5's live Bloblang parse errors show in the editor, but the graph doesn't mark the processor (E4 R3). Worse, 4.5 hides lint's duplicate of a live error, and the graph reads only Red Hat and lint, so a processor with a broken mapping now shows no marker at all, even after a save.

**Approach:** Add the "Bloblang" collection to the diagnostics the graph's node status reads (AD-17). A parse error then marks its processor's node like any other error: border and icon, rolled up to collapsed groups, message on hover. The mapping to nodes, the frozen status and the transport stay as they are.

## Boundaries & Constraints

**Always:**
- **One source:** `LintDiagnostics.diagnosticsFor(uri)` returns Red Hat's diagnostics, the published lint ones and the published Bloblang ones. Its `onDidChangeDiagnostics` fires when any of the three change, and only then (the signature covers all three).
- **Placement:** a Bloblang diagnostic maps at its range start (inside the mapping's value) through `statusDiagnostics` and `nodeStatusOf`/`nodeAt` unchanged, so it marks the innermost node there: the `mapping` / `mutation` processor, including one nested in a `switch` case or in `processor_resources`. It is Error severity.
- **Hover:** the binary's message verbatim, as 4.5 publishes it, beside any other messages on the node (no duplicates).
- **Frozen:** while the YAML does not parse, the status stays frozen (AD-17). 4.5 clearing the Bloblang diagnostics at that moment does not remove the marker; the status is recomputed once the YAML parses.
- **AI-8:** AD-17's Rule names the Bloblang collection among its sources. The EXPERIENCE row for live Bloblang errors notes the graph marker. CHANGELOG is updated.

**Never:**
- webview changes, protocol changes, or a new marker style;
- changing 4.5's parse, debounce, clearing or lint dedupe;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MARKED | a parse error in a labelled block `mapping` | that node's status: `error`, own message = the binary's | none |
| CLEARED | fix the error | the node's status is gone (no other diagnostics on it) | none |
| NESTED | a parse error in a `switch` case's `mutation` | the mutation node gets `own: error`; the case and the switch roll it up | none |
| COLLAPSED | the same switch collapsed in the webview | the group header shows the error (roll-up, 3.8 unchanged) | none |
| FROZEN | marker shown, then a YAML syntax error elsewhere | no `nodeStatus` sent while the banner shows, and the marker stays; after the fix, the status matches the current diagnostics | none |
| WITH_LINT | a lint finding (3.8) on the same processor plus a live error, saved | one node status with both messages; lint's duplicate of the live error stays hidden | none |
| NO_BINARY | binary missing | no Bloblang diagnostics, so no Bloblang marker; Red Hat and lint markers as before | none |
| CHURN | a Bloblang change that leaves the node status the same | no new `nodeStatus` post | none |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/diagnostics.ts:52-55` -- the `bloblangErrors` option. Add `diagnostics(uri)` to its type (`BloblangDiagnostics.diagnostics` already exists, `bloblangDiagnostics.ts:~160`).
  - `diagnosticsFor` (:120) appends them.
  - `refresh` (:~200) puts them into the signature (`signatureOf([...redHat, ...published, ...bloblang])`).
  - Update the header comment. Lint's own collection and dedupe stay.
- `src/adapters/vscode/bloblangDiagnostics.ts` -- no behaviour change. Its emitter already fires on every collection change, and `LintDiagnostics` already subscribes (:114).
- `src/adapters/graphPanel/status.ts:25` -- `statusDiagnostics`. Bloblang ones (source `Bloblang`) take the non-lint branch (range start). No change expected; confirm with a test.
- `src/adapters/graphPanel/graphPanel.ts:229` (`diagnosticsChanged`), `:326` (`computeStatus`), `panels.ts:194,536` -- the consumers. Don't change them. The frozen path is already there (nothing is sent without a valid model).
- `src/core/nodeStatus.ts` -- unchanged.
- `src/extension.ts:171-176` -- already passes `bloblangErrors: bloblangDiagnostics`; the type widens.
- Tests:
  - `src/test/adapters/vscode/diagnostics.test.ts` -- `diagnosticsFor` includes the Bloblang ones, and the event fires on a Bloblang-only change and not on an unchanged one;
  - integration: extend `src/test/integration/suites/91-bloblang-diagnostics.ts` (fake `blobl`, `ERR@L:C` markers, `fakeBinary.ts`) for the matrix, using the real `GraphPanels` from `api()` and `handle.posted` `nodeStatus` messages, as `82-graph-markers.ts` does (its `statuses` helper; `SWITCH_ID`, `withGraph`, `replace` from `graphHelpers.ts`);
  - WITH_LINT needs the fake binary's lint and blobl together, as 91's LINT_DEDUPE does.
- Boundaries met (AI-7):
  - 3.8 markers and 3.6 banner (FROZEN, WITH_LINT; `82-graph-markers.ts` stays green unchanged);
  - 4.5's lint dedupe (`91` LINT_DEDUPE/LINT_KEPT unchanged).

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/vscode/diagnostics.ts` + `src/test/adapters/vscode/diagnostics.test.ts` -- Bloblang diagnostics in `diagnosticsFor` and its signature.
- [x] `src/test/integration/suites/91-bloblang-diagnostics.ts` -- the matrix through the real graph panel.
- [x] Docs -- AD-17 Rule, EXPERIENCE row, CHANGELOG.

**Acceptance Criteria:**
- Given the dev host with the real binary and the graph open, when the user types a Bloblang syntax error into a mapping, then its node shows the error border and icon with the binary's message on hover, and loses them when fixed.
- Given the change, when `npm run compile`, `npm test` (stable is the target), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- `LintDiagnostics.diagnosticsFor` appends `bloblangErrors.diagnostics(uri)`; `refresh` puts them in the signature, so a Bloblang-only change fires once and an unchanged one does not. A unit test also pins `statusDiagnostics` mapping a `Bloblang` diagnostic at its range start (no code change there).
- Integration (91): GRAPH MARKED / CHURN / CLEARED, NESTED / COLLAPSED (switch case mutation + `processor_resources` mapping; the roll-up on the case and the switch is what a collapsed header shows, the webview is not driven), FROZEN, WITH_LINT; NO_BINARY extended with the graph. A file opened with an error gets its status in the snapshot, not a `nodeStatus` post, so the tests read the last of either.
- FROZEN: after the YAML is fixed, the model is mapped against the diagnostics of that moment, before 4.5 republishes its cached error after its 300 ms debounce, so the marker goes for about that long and comes back (two `nodeStatus` posts). Within the plan (4.5's clearing and the consumers unchanged); a follow-up could avoid the blink.
- `npm test` stable: 735 passing. One earlier run failed once in suite 90's `after all` (`ENOTEMPTY` removing its temp dir), unrelated and not reproduced on the rerun.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 0 medium, 5 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | FROZEN's first cycle passes on the stale snapshot from `brokenYaml()`'s `ready`, so a missing recompute would go unseen | low | patch | Test-only. It now requires that the last `nodeStatus` posted after the fix equals the marked status. |
| 2 | NO_BINARY's "no marker" assertion holds trivially: with no binary there is no schema, no model, and no `nodeStatus` | low | patch | Assertion dropped with a comment (no model, 3.9 empty state). The "appears once the binary is found" check stays. |
| 3 | After the YAML parses again, the marker goes away for about 300 ms (4.5's debounce) and then comes back | low | patch (docs) | The intent's "does not remove the marker" covers the broken period, and that holds. Afterwards the marker follows the editor's underline, which is back only after 4.5's debounce. Fixing it means changing 4.5's debounce, which the plan's Never list rules out. CHANGELOG and EXPERIENCE now say so. |
| 4 | Suite 91's teardown doesn't wait for the graph panels the new tests open | low | patch | It now waits for `graphPanels.size === 0`, as suite 90 does. |
| 5 | COLLAPSED is checked only through the host-side roll-up | low | reject | A collapsed header renders the roll-up status (3.8's webview tests). The real-binary acceptance criterion is covered by the user's manual check. |

## Verification

**Results (2026-10-14, after the review patches):** `npm run compile` exit 0; full stable suite (VS Code 1.141.1) 735 passing; `npm run test:webview` 174; `npm run test:corpus` 129. Floor not worked on (user decision). Manual check (the user, dev host, real rpk): an error in the block mapping and in the switch case's quoted mutation marks its node (border, icon, the binary's message on hover), a collapsed switch shows the roll-up, the marker stays while the YAML is broken and returns after the fix, a lint finding on the same node is listed beside the live error, and fixing the error clears the marker. No issues. (An expanded group shows only its own markers, per 3.8.)

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- In the dev host, with the graph open, the user types an error into a mapping and sees its node marked with the message on hover. The mark goes when the error is fixed, and stays while the YAML is broken.
