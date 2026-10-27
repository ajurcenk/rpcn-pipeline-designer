---
id: 26
type: bug
title: "A hidden file renamed over a file whose graph is open leaves a graph open on a hidden name"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
severity: P3
estimate: ""
---

# A hidden file renamed over a file whose graph is open leaves a graph open on a hidden name

## Description

When a file whose graph is hidden is renamed onto another file whose graph is open, with "Replace", the open graph stays and shows the moved content, while the name is now marked hidden. The graph and the file's Hide disagree: the user sees a graph for a file they hid, and next session it will not open.

## Reproduction

1. `a.yaml` hidden (Hide graph), `b.yaml` with its graph open.
2. Move or rename `a.yaml` onto `b.yaml` and choose **Replace**.
3. Actual: `b.yaml`'s graph is open, showing `a.yaml`'s content, and `b.yaml` is marked hidden.
4. Expected: one consistent outcome, decided below.

## Cause Hypothesis

On a rename, a moved graph decides the new name's Hide (ticket 17), but a hidden file has no graph, so nothing decides: the Hide moves with the file while the overwritten file's graph stays. The same happened before ticket 17.

## Acceptance Criteria

1. **The graph and the Hide agree**
   **Given** a hidden file renamed onto a file whose graph is open
   **When** the rename overwrites it
   **Then** the outcome decided below holds: never an open graph on a name marked hidden
2. **Other renames are unchanged**
   **Given** the rename cases of 3.10 and ticket 17
   **When** they run
   **Then** they behave as today
3. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers the reproduction
4. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the outcome is already consistent, with the evidence recorded in Notes — this supersedes 1 to 3

## References

- parent — none
- source — _bmad-output/backlog/bug-a-rename-that-overwrites-a-file-keeps-the-wrong-panel-plan.md, Review Triage Log row R4
- source — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the entry from ticket 17 on the hidden flag

## Notes

- Open question: which outcome — the open graph closes (the content is the hidden file's), or the name is not marked hidden (the open graph wins), or the Hide is dropped.
