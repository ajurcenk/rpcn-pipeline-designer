---
title: 'A hidden file renamed over a file whose graph is open leaves a graph open on a hidden name'
type: 'bugfix'
ticket: '26'
created: '2026-10-27'
status: done
baseline_revision: '5541b5e87b071f6448f26bf033bbc649a68dcaef'
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

**Problem:** A file whose graph is hidden, renamed with "Replace" onto a file whose graph is open, leaves that graph open (showing the moved content) while its Hide moves to the name: the user sees a graph for a name marked hidden, and next session it will not open.

**Approach:** The open graph wins: at a name where a graph stays open after a rename batch (the overwritten file's, not a moved one), a moved file's Hide does not land, so the name is not marked hidden and its graph stays open. Every other rename case of 3.10 and ticket 17 is unchanged; a moved graph still decides its new name's Hide.

**Decision (user, 2026-10-27):** the open graph wins.

</frozen-after-approval>

## Implementation Notes

Oneshot: one condition in `GraphPanels.renamed` / `follows` (`src/adapters/graphPanel/panels.ts`) and a suite 86 test beside `GRAPH_OVERWRITE_HIDDEN`.

- Found while testing: VS Code closes the overwritten file's editor, so b's graph stays only when the moved file's tab becomes b's (a had an editor open); with no tab moving there, b's graph closes with its tab and the name taking a's Hide is already consistent (unchanged).
- `GraphPanels.tabbedRenames`: the files with a text tab when their rename is announced (`onWillRenameFiles`), used up when reported. `follows` takes `stays(key, at)`: for `hidden`, a moved key's Hide does not land at a name with no moved graph when that key had a tab and a graph is open there.
- Suite 86: HIDDEN_OVER_OPEN (fails without the fix), HIDDEN_NO_TAB and HIDDEN_CHAIN (`b→t, a→b`: no graph stays at b, the Hide lands) pin the unchanged cases. Suites 84 and 86: 58 passing.
- After review: a folder's rename records the tabs of the files in it; an announcement first clears the records of its files, and an expired rename (4.13) drops them. HIDDEN_FOLDER (fails on the first version), HIDDEN_CHAIN's a has its editor open. Suites 84 and 86: 59 passing.

## Review Triage Log

Quick review. Verdicts: 0 high, 1 medium, 2 low.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | A rename's folder: the tab check ran on the folder's URI only, so a hidden file with a tab moved in a folder over an open graph still marked the name hidden | medium | patch | The tabs of files within each renamed folder are recorded; HIDDEN_FOLDER. |
| 2 | A tab record of an announced rename that is never reported stays; a later rename of that file with no tab would drop the Hide, and the graph then closes | low | patch | Each announcement clears its files' records before recording; `renamesExpired` drops them. |
| 3 | HIDDEN_CHAIN's a has no tab, so the test does not reach the open-graph half of the check | low | patch | a's editor is open in HIDDEN_CHAIN. |

## Verification

**Commands:**
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|graph"` -- expected: all pass.
- `xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
  Result (2026-10-27): full stable suite 946 passing.

**Manual checks:**
- Dev host on 1.143.1: a hidden file with its editor open moved onto a file whose graph is open, with Replace: the graph stays and the name is not hidden. Done by the user (2026-10-27): no issues.
