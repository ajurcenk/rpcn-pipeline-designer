---
title: 'Test panels may not notice that their config has unsaved changes'
type: 'bugfix'
ticket: '25'
created: '2026-10-27'
status: 'built'
baseline_revision: '688e5c65dd84457870b482f5e43924dfbfb7810c'
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

**Problem:** The test panels' record of which configs have unsaved changes misses the first edit after a save: in the text change event VS Code has not marked the document modified yet, and its own later event (no content changes, the modified flag set) is ignored. Probed on 1.143.1 (2026-10-27): after one edit the record says "saved" while the document is modified; after a second edit it is right. The record decides what follows a rename and what resets on a close without a revert; closing without saving reverts the text, which the panels follow anyway, so the user-visible effect is small (severity lowered to P3 with the user, 2026-10-27).

**Approach:** The record also follows VS Code's events that change only the document's modified state, for documents that have test panels, so it is right after the first edit, after a save, and after an undo back to the saved text. Nothing else changes.

</frozen-after-approval>

## Implementation Notes

Oneshot: one listener branch in `src/adapters/bloblangPanel/panels.ts` and a suite 90 test.

- The text change listener handles VS Code's flag-only events (no content changes) of documents with panels: the record follows `isDirty`, and a document back to saved (undo, revert) marks its panels' places saved. A flag-only event of a file being renamed is skipped, so the old name's record reaches `renamed()` (4.17).
- `match()` takes `saved`: an edit's event passes `false` (its `isDirty` is the old one, so the first edit after a save marked the edited places saved); opening passes `!doc.isDirty`.
- DIRTY_RECORD (suite 90): the record after the first edit after a save, a save, and an undo back to the saved text. It fails without the fix.

## Review Triage Log

Quick review. Verdicts: 0 high, 2 medium, 3 low (2 noted).

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `match()` marks the edited places saved on the first edit after a save (the same stale `isDirty`) | medium | patch | Saved places follow the flag-only event and the save; `match()` takes `saved`. |
| 2 | A rename's revert of the old name's document would clear its record before `renamed()` | medium | patch | Skipped while `renaming(key)`. |
| 3 | After a revert the record is clear, so the close no longer resets the panels | low | noted | They followed the revert's text to the saved places, as a clean close; CLOSE_UNSAVED passes. |
| 4 | No close and reopen test | low | noted | CLOSE_UNSAVED is that case: its insert is the first edit after the document opened saved. |
| 5 | OVERWRITTEN_DIRTY's comment out of date | low | patch | Reworded. |

## Verification

**Commands:**
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|Bloblang test panel"` -- expected: all pass.

- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- 937 passing (2026-10-27).
