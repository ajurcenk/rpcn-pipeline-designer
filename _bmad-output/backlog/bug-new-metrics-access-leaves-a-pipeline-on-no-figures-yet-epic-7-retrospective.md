---
id: 59
type: bug
title: "New metrics access leaves a pipeline on \"No figures yet\" (epic 7 retrospective)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
severity: P2
estimate: ""
---

# New metrics access leaves a pipeline on "No figures yet" (epic 7 retrospective)

## Description

When a Cloud pipeline's metrics access is set or replaced, the feed reads again with the new access. It clears the refusal and the failure count, but not the not-served state or the count of reads with no series. So after new credentials the tab keeps showing "No figures yet", or the not-served state, until the user presses Read. The feed's own header says an access change starts it over. It should show the new access's result on the next read.

## Reproduction

1. Show a Cloud pipeline's metrics with access that reads no series for it (for example a pipeline that is not served, or access to another cluster's metrics), until the tab shows "No figures yet" or not served.
2. Run Set up metrics access on that cluster with access that can read the pipeline's series.
3. Actual: the tab keeps "No figures yet" (or not served) after the next read. Expected: the next read with the new access sets the state from its own result, and shows the figures when the series are there.

## Cause Hypothesis

The Cloud feed's "access set or replaced" path resets `refusedMessage` and `failures`, but not `notServed` and `noSeriesReads`, which the "access removed" path does reset. The reading that follows is then judged against the old counts.

## Acceptance Criteria

1. **An access change starts the feed's state over**
   **Given** a Cloud feed whose state comes from reads with the previous access (no figures yet, not served, a refusal, failures)
   **When** its access is set or replaced
   **Then** the next read with the new access sets the state from that read alone
2. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers a not-served feed and a no-series feed that get new access, and one checks that a read in flight with the old access is still dropped
3. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the state already starts over, with the evidence recorded in Notes — this supersedes 1 and 2

## References

- parent — none
- source — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics-retrospective.md`, Finding C4; action item AI-2

## Notes

- Assumption: risk low (one state reset in the feed, seen at once), severity P2 (the figures are impaired; pressing Read works around it).
