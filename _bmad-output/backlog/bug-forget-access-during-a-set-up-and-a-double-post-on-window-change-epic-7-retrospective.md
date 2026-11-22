---
id: 60
type: bug
title: "Forget access during a running Set up, and a double post on a window change (epic 7 retrospective)"
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

# Forget access during a running Set up, and a double post on a window change (epic 7 retrospective)

## Description

Two small defects from the epic 7 retrospective. (a) Forget metrics access, or Forget log access, from the Cloud view row or the palette ignores a Set up of that cluster that is still running. The Set up then stores the access again, so the "removed" message is false. Only the Pipeline Metrics tab's button checks for a running Set up. (b) When the tab's window (1, 5 or 15 min) changes, the tab decides whether the feeds already posted by comparing the length of its posted-message log. That log is capped at 200 entries, so past the cap every window change posts twice and fires a change event twice.

## Reproduction

(a)
1. Start Set up metrics access on a cluster, and leave its input open.
2. From the Cloud view row (or the palette), run Forget metrics access on the same cluster. The "removed" message shows.
3. Finish the Set up.
4. Actual: the access is stored again, and the earlier "removed" message was false. Expected: Forget waits for the running Set up or refuses with a message saying a Set up is running, as the tab's button does. The same holds for log access.

(b)
1. Keep the Pipeline Metrics tab open on a live feed until it has posted more than 200 messages.
2. Change the window.
3. Actual: the rows are posted twice and the change event fires twice. Expected: once.

## Cause Hypothesis

(a) The shared forget path never consults the Set up guard; only the tab's button does. (b) The window handler uses the posted-message log, a capped log kept for tests, to decide behaviour; once the log is full its length no longer changes.

## Acceptance Criteria

1. **Forget doesn't race a running Set up**
   **Given** a Set up of metrics or log access running for a cluster
   **When** Forget for the same access and cluster is run from the row, the palette or the tab
   **Then** it waits for the Set up or refuses with a message saying why, and never reports a removal that the Set up then undoes
2. **A window change posts once**
   **Given** the Pipeline Metrics tab, with or without readings, and however many messages it has posted
   **When** the window changes
   **Then** the tab posts the new rows once and fires one change event
3. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers Forget from the row during a Set up, for metrics and for logs, and a window change after the posted log is full
4. **Or: no change is needed, with proof**
   **Given** the reproductions
   **When** they are run on the current code
   **Then** the expected behavior already holds, with the evidence recorded in Notes — this supersedes 1 to 3

## References

- parent — none
- source — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics-retrospective.md`, Findings C5, C6; action item AI-3
- related — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/story-refactor-sweep-plan.md` (7.10, the shared Set up guard and forget path)

## Notes

- Assumption: risk low, severity P3, as the retrospective rated both "low".
- Open question: (a) wait for the Set up, or refuse? The tab's button refuses today; the fix should match it unless the user says otherwise.
