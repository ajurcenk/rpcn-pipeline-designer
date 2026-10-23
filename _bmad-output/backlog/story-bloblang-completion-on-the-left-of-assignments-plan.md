---
title: 'Bloblang completion on the left of an assignment'
type: 'feature'
ticket: '8'
created: '2026-10-23'
status: done
baseline_revision: 'c90cfd614d51a712b960d17306f8b2cd50e8c90f'
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

**Problem:** Bloblang completion (2.19) offers methods after any dot and functions at any expression position, also on the left of `=`, where the text is a path being assigned (`root.user.§ = this.name`, `let v§ =`, `meta foo§ =`). A method or function is never valid there (recorded as a limit in the 2.19 review).

**Approach:** The cursor is on an assignment target when its line, up to the cursor, is only a target (`root…`, `this…`, a bare path, `let <name>`, `meta <name>`), and the same line goes on, after the word under the cursor, with `=` (not `==` or `=>`). Bloblang statements start a line, so the line start is the statement start. There, no methods or functions are offered. The fields already written under a `root.` / `this.` path are still offered, as today (2.20). The right-hand side, `$` / `@` names, a line with no `=` after the cursor (a bare expression is a valid mapping), hover and highlighting are unchanged.

</frozen-after-approval>

## Implementation Notes

Oneshot: a `target` flag on `BloblangContext` set in `bloblangContext`, `bloblangItems` returning nothing for it, and unit tests.

- `src/core/bloblang.ts`: `isAssignmentTarget` checks the cursor's blanked line up to the cursor against a target shape and the rest of the line (to the region's end) for `=` not followed by `=` or `>`. The adapter needed no change: names after `root.` / `this.` come from the receiver as before, and `bloblangItems` gives nothing for a target.
- `src/test/core/bloblang.test.ts`, `src/test/core/bloblangNames.test.ts`: the three ACs, the word under the cursor, bare paths, a single-quoted value, a later line; not targets: `==`, `=>`, a bare expression, an `=` on the next line, after the `=`. Fields under `root.user` still offered on the left.
- `CHANGELOG.md`: an entry. Suite 30 (Bloblang completion and hover) still passes.

## Review Triage Log

Quick review. Verdicts: 0 high, 0 medium, 3 low, 2 rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `root.a.§.b = 1` (a segment the rest of the path follows) still offered methods | low | patch | Confirmed: the rest-of-line check wanted `=` right after the word. It now allows the rest of the path first; test added. |
| 2 | `let § =` / `meta § =` before the name still offered functions | low | patch | Confirmed: the `let`/`meta` branch required a name. The name is optional now; tests added. |
| 3 | Index (`root.a[0].§ =`) and quoted (`root."a b".§ =`) segments are not recognised | low | reject | Rare on a target; quoted segments are blanked by the scanner, so covering them is more than a correction. |
| 4 | The statement start is the line start, not `regionStart` as the ticket's note says | false | reject | The intent chose the line start (Bloblang statements start a line); the reviewer's probes show multi-line `if` and lambda cases behave. |
| 5 | `!=`, `<=`, `>=` not pinned; no tests for 1–2; no integration case | low | patch | Negative cases and tests for 1–2 added. No integration case: the adapter is unchanged and suite 30 still passes. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "core/bloblang"` -- expected: all pass.
