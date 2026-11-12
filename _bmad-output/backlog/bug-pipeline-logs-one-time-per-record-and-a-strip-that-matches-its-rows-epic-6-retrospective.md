---
id: 53
type: bug
title: "Pipeline logs: one time per record, and a strip that matches its rows (epic 6 retrospective)"
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

# Pipeline logs: one time per record, and a strip that matches its rows (epic 6 retrospective)

## Description

A Pipeline Logs row shows the time from the record's own `time` field, but reads, the strip's slots and Load older's anchors use the Kafka timestamp. Show records around this one and the around-the-error window are built from the shown time, so a record whose two times differ can fall outside its own window. The strip clamps records outside its span into the edge bars, so those bars count records that clicking them does not show. When this bug is fixed, each record has one time for every use, and each bar shows the records it counts.

## Reproduction

Paths are at 4f88554.

1. **C6, two times.** The row's time is `parseLogTime(value.time) ?? record.timestamp` (`src/adapters/logs/records.ts:135`); the read and the strip use the Kafka timestamp. Show records around this one builds its range from `kept.row.time` (`src/adapters/vscode/logsPanel.ts:784`), and the around-the-error search picks its candidate by `row.time` (`logsPanel.ts:1537-1538`). Write a record whose `time` is more than 5 minutes from its Kafka timestamp, then Show records around this one: the record is not in the window read.
2. **C7, the strip's edges.** `SlotCounter.strip` counts a record outside the span in the nearest slot (`src/adapters/logs/filter.ts:111-112`). With records outside the span (a non-monotonic CreateTime, or counts from an earlier, wider read), the edge bars are inflated, and clicking one reads a slot range that does not hold them.
3. **C7, Live after a bounded range.** For a bounded range followed by Live, `stripSpan` ends at the range's end (`src/adapters/logs/history.ts:113`), so every live record piles into the last bar, and clicking it misses them.

## Cause Hypothesis

The row's time was chosen for display (6.2), while the reads were built on Kafka timestamps (6.3), and the strip (6.7) clamps rather than leaving out. No story used both times side by side.

## Acceptance Criteria

1. **One time per record**
   **Given** a record whose value's `time` differs from its Kafka timestamp
   **When** the row, the strip, Show records around this one or the around-the-error window uses its time
   **Then** each uses the same time, so the record falls inside its own window
   **And** the row shows which time it is when the two differ, or the rule is stated in the README
2. **Each bar shows what it counts**
   **Given** records outside the strip's span, or a bounded range followed by Live
   **When** the strip is drawn and a bar is clicked
   **Then** each record is counted in the bar for its time or not at all, and clicking a bar shows the records it counts
3. **Tests cover the conditions found and fixed**
   **Given** the logs unit tests and the integration suite
   **When** they run
   **Then** a test that fails on the defect and passes on the fix covers each of criteria 1 and 2
4. **Or: no change is needed, with proof**
   **Given** a case's reproduction
   **When** it is run on the current code
   **Then** the expected behavior already holds, or the finding was mistaken, with the evidence recorded in Notes — this supersedes that case's part of criteria 1 to 3

## Boundaries

- Must not change: bug 51 group A's reading and counts (per-partition positions, the left-out totals and the gap marker); bug 52's masking.
- Not in scope: slow search patterns (bug 54).

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs-retrospective.md, findings C6 and C7
- source — _bmad-output/backlog/bug-pipeline-logs-reading-and-state-edge-cases-epic-6-retrospective.md, criterion 5 (bug 51 group B)
- prior — _bmad-output/backlog/bug-pipeline-logs-reading-and-state-edge-cases-epic-6-retrospective-plan.md (bug 51 group A, done)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-records-per-hour-strip-plan.md (6.7, the strip)

## Notes

- Decision: split from bug 51 as its group B (user, 2026-11-11, "Start A"); ticketed on 2026-11-11 ("make the tickets").
- Open question: which time wins, the value's `time` (what the pipeline wrote) or the Kafka timestamp (what the reads use)? Decide at the plan's checkpoint.
- Decision: no floor (VS Code 1.100.0) runs (user).
