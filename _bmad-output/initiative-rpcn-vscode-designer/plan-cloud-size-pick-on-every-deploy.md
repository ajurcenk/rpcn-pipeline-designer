---
title: 'Deploy shows the pipeline size every time, pre-set to the deployed size'
type: 'feature'
ticket: ''
created: '2026-11-03'
status: 'built'
baseline_revision: 'c7621925011b3c06bbd5e2df9e3e2a3f471fcb26'
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

**Problem:** Story 5.3 asks for the pipeline size (compute units) once and saves it as the workspace setting `redpandaConnect.cloud.computeUnits`; every later deploy uses it silently, so the user neither sees nor changes the CPU and memory a pipeline gets.

**Approach:** Decision (user, 2026-11-03): "we only need to remember the previous pipeline settings if we're deploying the same pipeline a second time. The user can see the selected CPU and memory, but can change it." Every Deploy shows the size pick (1–15 units, each with its CPU and memory): a new pipeline pre-set to 1 unit; deploying the same pipeline again pre-set to that pipeline's current size (read from the Cloud), marked as current. Escape sends nothing. The `redpandaConnect.cloud.computeUnits` setting is removed (nothing saved; a value left in a settings file is ignored). The rest of 5.3 stands: an unchanged config at the current size is "nothing changed", a size change of a running pipeline needs the confirmation naming the old and new size. This supersedes epic 5's R6 "from a setting, chosen on the first deploy" and story 5.3's compute-unit decision.

</frozen-after-approval>

## Implementation Notes
- `src/adapters/vscode/cloudView.ts`: `CloudUi.pickUnits(title, current)` now returns the picked resources; the default UI is a `createQuickPick` (so the pre-set item can be the active one) of 1–15 units, each with its CPU and memory, the deployed size marked "current"; a deployed size that is no whole number of units from 1 to 15 is offered first as "Current size". `deployFile` calls it after the target is known (an update passes the deployed pipeline's resources; a create passes none, so 1 is pre-set). `configuredUnits`, `askUnits`, `unitsTarget`, `UNITS_SETTING` removed.
- `package.json`: `redpandaConnect.cloud.computeUnits` removed (never released; a value left in a settings file is ignored by the code and greyed by VS Code).
- Tests: the cloud suite's pick stub accepts the pre-set size unless a test scripts a size, and records each pre-set; FIRST_DEPLOY, RESOURCES_ONLY and the deployed-size test rewritten for the pick; the multi-root suite's `unitsTarget` test removed with the function.
- README and CHANGELOG: the size paragraphs rewritten (the setting was unreleased, so the 5.3 entry is edited, not followed by a removal entry).
- Review fix: the pick's items and pre-set moved into `sizeChoices` (`src/adapters/cloud/dataPlane.ts`, no `vscode` import) with a unit test in `src/test/adapters/cloud/update.test.ts`; the quick pick only shows them.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | A stale doc comment above `pickUnits` describes the removed first-deploy prompt | low | cloudView.ts `CloudUi`: two JSDoc blocks, the first the old one | patch |
| 2 | dataPlane.ts:16 still names the removed setting | low | the comment cites `redpandaConnect.cloud.computeUnits` | patch |
| 3 | The real size pick (pre-set, "current" mark, "Current size" item) is untested | medium | the suite stubs `pickUnits`; the stub's default copies the logic | patch (`sizeChoices` + unit test) |
| 4 | An update of a pipeline the Cloud returned without resources looks like a new one (pre-set 1, never "nothing changed") | low | real, but not new (5.3 behaved the same) and not met: the API returned resources on every pipeline in the spike and the manual checks | reject |
| 5 | One header comment line breaks the ~100-column wrap | low | cloudView.ts header ~:18 | patch |
