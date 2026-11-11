---
id: 51
type: bug
title: "Pipeline logs reading and state edge cases (epic 6 retrospective)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
severity: P2
estimate: ""
---

# Pipeline logs reading and state edge cases (epic 6 retrospective)

## Description

The epic 6 retrospective found cases where the Pipeline Logs panel reads the wrong records, or shows a state that does not match what it reads. A retry can skip records, a filter change can read a range the status does not name, the around-the-error search cannot be stopped, and the left-out counts undercount. A record's shown time can put it outside its own window, the strip piles records into its edge bars, and some slow patterns are not refused. The clean live log, history, filter, search and export work as tested. When this bug is fixed, each case behaves as its criterion says and has a test.

## Reproduction

Each case reproduces from the dev host with a log-access user, or from the logs integration suite with the fake reader. Line numbers are the retrospective's, at c783a4a. C1 needs a logs topic with several partitions, which the fake does not have (V3).

1. **C1 Retry skips records.** On a topic with several partitions, with one partition behind, let the reader fail with "Connection lost" and retry. Every partition resumes from the newest timestamp seen on any partition, so records on the partition that was behind are not shown (`src/adapters/vscode/logsPanel.ts:1024,1046-1049`).
2. **C2 Filter change on the live range.** Open the live log, wait, then change a filter or set up new log access. The panel re-reads from the time it opened minus 15 minutes through the tail, with no Stop reading, while the status says "the last 15 minutes" (`logsPanel.ts:649-668,1449`; `tail` `:980-993`).
3. **C3 Filter or Live during the around-the-error search.** Run Show logs around the error, then change a filter or turn Live on while it searches. The search is dropped with no message and the panel reads the last 24 hours, unmarked (`logsPanel.ts:636-670,784,808-836`).
4. **C4 The around-the-error search cannot be stopped.** Run Show logs around the error on a pipeline whose newest ERROR record is hours back. Up to 24 one-hour windows are read, the panel is never in the Reading state, and Stop reading is not offered (`logsPanel.ts:1231-1299,1400-1420`).
5. **C5 Load older undercounts.** Read a range that leaves records out, then Load older. The footer, "N older left out" and the export message show only the last batch's count. With the tail at the cap during Load older, records between the two reads are not shown and nothing says so (`logsPanel.ts:1103-1105,1540-1611`; `this.dropped = merged.leftOut` `:1595`).
6. **C6 Two times per record.** Show a record whose value's `time` differs from its Kafka timestamp. The row shows the value's time; ranges, strip slots and anchors use the Kafka timestamp. Show records around it, or the around-the-error window, is built from the shown time, so the record can fall outside its own window (`src/adapters/logs/records.ts:105`; `logsPanel.ts:676-694,1287,1311-1316,1519,1533`).
7. **C7 The strip's edge bars.** Read a bounded range, then turn Live on. Every live record is counted in the last bar, and clicking that bar does not show them (`src/adapters/logs/filter.ts:103-112`; `src/adapters/logs/history.ts:248-255`).
8. **C8 The read position does not advance.** Read past a batch with no record at or after the read position (a compacted or control batch). The position stays where it was, so the tail spins and a range read stalls (`src/adapters/logs/platformaticReader.ts:244-262`).
9. **C9 A failed metadata re-read ends the read.** Let a fetch fail, then let the metadata re-read that follows fail too. The read ends instead of being retried (`platformaticReader.ts:286-288`).
10. **C10 Stop reading, then Live.** Read a bounded range, Stop reading, then turn Live on. The rows read are dropped and the panel goes back to the default 15 minutes (`logsPanel.ts:829-835,1400-1419`).
11. **C11 Show logs on another pipeline during Set up.** Start Set up log access, then Show logs on another pipeline before it ends. The new pipeline's Set up and Use another user are disabled or ignored. A second Set up request is ignored with only a log line (`logsPanel.ts:554-583,1427-1442`; `src/adapters/vscode/cloudLogs.ts:108-111`).
12. **C12 Slow patterns.** Search with `.*.*.*x`. It is not refused, though 6.4 says patterns that could take too long are refused. The webview's highlight runs the pattern on the full row text with no cap (`src/shared/logsProtocol.ts:101-142`; `webview/src/logs/LogsView.tsx:111-133`).
13. **C13 Partition ids (check first).** The partition id is taken from its position in the metadata answer, and a leader of −1 during an election is fetched as a node (`platformaticReader.ts:197`). Whether the position is wrong depends on the client's metadata shape.
14. **C15 Export.** Export rows that include a record with no `time` field. That record has no time in the file, and neither the file nor the message names the filter applied (`logsPanel.ts:711-756`; `src/adapters/logs/export.ts:10-15`).

## Cause Hypothesis

The panel keeps its read as separate fields, reset by hand on each change, and each story added paths to them (retrospective A3). The tail, the bounded range, the around-the-error search and Load older share those fields, so a change made in one path leaves another stale or overwritten (C2–C5, C10, C11). The resume point is one value for the whole read, not one per partition (C1). The reader trusts its own position and the metadata answer's order (C8, C9, C13). The shown time and the range time come from two different fields (C6). The strip sizes its bars from the range read, not from the records it holds (C7). The pattern check looks for nested groups only, and the webview does its own matching (C12).

## Acceptance Criteria

1. **Reading resumes and advances on every partition**
   **Given** a logs topic with one or more partitions, a partition behind the others, a batch with no record at or after the read position, or a failed fetch followed by a failed metadata re-read
   **When** the panel reads, or retries after "Connection lost"
   **Then** each partition resumes from its own last record, the read position always moves past a batch read, and a failed metadata re-read is retried as a failed fetch is
   **And** each partition is fetched by its own id from a leader that exists; a leader of −1 is waited on, not fetched
2. **The panel reads what its status says**
   **Given** the live log, a bounded range, a stopped range or the around-the-error search
   **When** a filter changes, new log access is set up, or Live is turned on or off
   **Then** the panel reads the range its status names, and a range or search it leaves is either kept or ended with a message
   **And** rows already read are not dropped without a message
3. **Every read is in the Reading state and can be stopped**
   **Given** any read that takes more than one request, the around-the-error search included
   **When** it runs
   **Then** the panel is in the Reading state and Stop reading ends it
   **And** Set up log access and Use another user work for the pipeline shown, whichever pipeline the panel showed when they started, and a request that cannot run says why in the panel
4. **The left-out counts are kept across reads**
   **Given** a read that leaves records out, followed by Load older or Export
   **When** the footer, "N older left out" or the export message is shown
   **Then** the counts are the totals for the rows the panel holds, and a gap between two reads is shown as one
   **And** an export says which filter was applied, and a record with no `time` field has its Kafka timestamp in the file
5. **One time per record, and a strip that matches its rows**
   **Given** a record whose value's `time` differs from its Kafka timestamp, or records outside the strip's span
   **When** the row, the strip, Show records around it or the around-the-error window uses its time
   **Then** each uses the same time, so the record falls inside its own window
   **And** each record is counted in the bar for its time, and clicking a bar shows the records it counts
6. **Slow patterns are refused before they run**
   **Given** a search pattern that could take too long, nested or not, such as `.*.*.*x`
   **When** it is typed
   **Then** it is refused with the same message as other slow patterns, on the host and in the webview's highlight, and the highlight never runs a pattern on uncapped text
7. **Tests cover the conditions found and fixed**
   **Given** the logs unit tests and the integration suite
   **When** they run
   **Then** a test that fails on the defect and passes on the fix covers each of criteria 1 to 6, with the integration fake reading several partitions for criterion 1
   **And** the suite covers a filter or Live change during the around-the-error search (G1), Set up log access from the tab returning to the error search with Live and the filter kept (G2), the "cluster gone" branch of the shared palette path for both callers (G3), and an export message with a non-zero newer-dropped count (G4)
8. **Or: no change is needed, with proof**
   **Given** a case's reproduction
   **When** it is run on the current code
   **Then** the expected behavior already holds, or the finding was mistaken, with the evidence recorded in Notes — this supersedes that case's part of criteria 1 to 7

## Boundaries

- Must not change: the 5,000-record cap, filtering on the host, the Node 22.22 floor and NEEDS_NEWER, the backoff schedule, or the log-access and masking paths (bug 52).
- Not in scope: C14 (LogAppendTime batches), deferred until the topic's timestamp type changes. The split of the panel's read state and the protocol renames are story 50; this bug may fix the cases without that split.

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs-retrospective.md, findings C1–C13 and C15 (Diff review: reading and state), G1–G4 and V3 (Verification gaps), action item AI-1, Open questions
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-the-log-panel-s-empty-and-error-states-plan.md (6.6, "resumes where it stopped")
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-filter-and-search-the-log-plan.md (6.4, the slow-pattern refusal)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/spike-6-1-findings/findings.md (several partitions unproven)
- related — _bmad-output/backlog/bug-pipeline-logs-credentials-and-masking-epic-6-retrospective.md (bug 52)
- related — _bmad-output/backlog/story-code-health-for-the-cloud-adapter-and-the-panels.md (story 50, the read state split)

## Notes

- Decision: made from the epic 6 retrospective's AI-1 (user, 2026-11-11, "use your recommendations").
- Decision: C15 is in scope, low (user, 2026-11-11).
- Code at c783a4a: the read state is in `src/adapters/vscode/logsPanel.ts`; the reader in `src/adapters/logs/platformaticReader.ts`; the integration fake in `src/test/helpers/fakeLogs.ts` (one partition, `:94`); the several-partition unit tests in `src/test/adapters/logs/platformaticReader.test.ts:13-31`.
- Open question: C13. Check the Kafka client's metadata shape first. If it keeps partitions in index order, the id part of criterion 1 needs no change; record the evidence here.
- Open question: is the logs topic on the user's clusters ever more than one partition? C1 skips records only with several.
- Open question: the size. The plan's checkpoint decides whether to split, with the user's yes, into reading (C1, C8, C9, C13; criterion 1), state (C2–C5, C10, C11; criteria 2–4), time and strip (C6, C7; criterion 5), and search (C12; criterion 6).
- Decision: no floor (VS Code 1.100.0) runs (user).
