---
id: 64
type: story
title: "One read serves every metrics feed of a cluster (epic 7 retrospective C10)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# One read serves every metrics feed of a cluster (epic 7 retrospective C10)

## Description

Each Cloud pipeline's metrics feed downloads its cluster's whole Prometheus body and keeps only its own pipeline. The cluster's floor, at most one read every 5 s, then queues several feeds behind one another. With N feeds on one cluster, each feed reads only every 5N s instead of every 10 s. For example, the tab and two visible graphs on one cluster each read about every 15 s. Story 62 confirmed this and recorded today's gap in a test. When this is done, one read of a cluster's body serves every feed of that cluster, and each feed reads every 10 s however many there are.

## Acceptance Criteria

1. **Every feed keeps its pace**
   **Given** three or more Cloud-bound feeds of pipelines on one cluster, all reading
   **When** they read for a while
   **Then** each feed gets a reading about every 10 s, and the cluster's endpoint is read no more often than the floor allows
2. **One download serves the cluster**
   **Given** several feeds of one cluster due to read within the floor
   **When** they read
   **Then** the cluster's body is fetched once, and each feed gets only its own pipeline's series from it
3. **Failures stay per feed**
   **Given** a shared read that is refused, unreachable or not served
   **When** it fails
   **Then** every feed waiting on it shows that failure in its own state, as a single feed's read does today
4. **A change of access starts fresh**
   **Given** a shared read in flight
   **When** the cluster's metrics access changes
   **Then** that read's result is dropped for every feed, and the next read uses the new access
5. **Story 62's C10 test is updated to the new pace**
   **Given** the "story 62 C10" test, which records today's 5N s gap
   **When** this lands
   **Then** it asserts the 10 s pace instead, and fails on today's code

## Boundaries

- Must not change: a single feed's pace (10 s), the floor between a cluster's reads, the states and texts of the Pipeline Metrics tab, the masking of the password, and a local run's reads.

## References

- parent — none
- source — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics-retrospective.md`, Finding C10; action item AI-8
- source — `_bmad-output/backlog/story-the-metrics-risks-left-unverified-by-epic-7-are-settled-with-tests-plan.md` (story 62: the C10 verdict, its test, and the Decision to file this)
- architecture — `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md`, AD-25 (the reading rules; to be amended)

## Notes

- Decision: C10 is filed as its own ticket rather than fixed in story 62, with AD-25 amended here (the user, 2026-11-23).
- Assumption: risk medium. It changes how every Cloud feed reads (shared code with a cache), and a mistake can slip past review. The check outside the ticket's criteria is the full stable suite run twice, plus a manual check with the tab and two graphs on one cluster.
- Open question: amend AD-25's reading rule with `bmad-architecture` before the build, or as part of it?
- It's rare today: it needs several graphs of one cluster's pipelines visible at once, in separate editor groups.
- Decision: no floor (VS Code 1.100.0) runs (the user).
