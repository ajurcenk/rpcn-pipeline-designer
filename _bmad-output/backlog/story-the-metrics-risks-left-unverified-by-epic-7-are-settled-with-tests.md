---
id: 62
type: story
title: "The metrics risks epic 7 left unverified are settled with tests (epic 7 retrospective)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# The metrics risks epic 7 left unverified are settled with tests (epic 7 retrospective)

## Description

Epic 7's retrospective named risks it could not confirm from the code alone (C9 to C12). Bug 61 found one more risk of the same kind: VS Code's per-workspace state can lose an update. When this is done, each risk is either shown not to happen, with the evidence recorded, or fixed with a test that fails without the fix. No risk stays unverified. The structural cleanup the retrospective also asked for is story 63, which comes after this one.

## Acceptance Criteria

1. **Every risk has a verdict with evidence**
   **Given** the risks listed in Notes
   **When** this story is done
   **Then** each one is recorded in the plan as "happens" or "does not happen", with the test or evidence that shows it
2. **A risk that happens is fixed and covered**
   **Given** a risk shown to happen
   **When** its fix lands
   **Then** a test that fails without the fix and passes with it covers it, and the behaviour the user sees matches the Pipeline Metrics section of EXPERIENCE.md (or, for the hidden graph, the graph's Hide)
3. **A risk that does not happen keeps its proof**
   **Given** a risk shown not to happen
   **When** this story is done
   **Then** the test that showed it stays in the suite, so a later change that makes it happen fails that test
4. **A small or costly fix waits for the user**
   **Given** a risk that happens but whose fix is not small (for example, sharing one read across several feeds of a cluster)
   **When** it is found
   **Then** the build stops and asks, and the risk becomes its own ticket unless the user says to fix it here

## Boundaries

- Must not change: what the Pipeline Metrics tab and the graph show for a live local run or Cloud pipeline; the reading pace and the floor between a cluster's reads (AD-25); the structure of the metrics files beyond what a fix needs (that is story 63).

## References

- parent — none
- source — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics-retrospective.md`, Findings C9–C12; action item AI-8
- source — `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md`, the bug 61 entry on `workspaceState`
- related — `_bmad-output/backlog/bug-environment-view-value-default-flake-recurs-after-bug-41-epic-7-retrospective-plan.md` (bug 61, the memento lost-update mechanism)
- design — `_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md`, Pipeline Metrics

## Notes

- The risks, each with what would settle it (from the retrospective):
  - C9: after the tab is closed or bound to something else, a file's feed may stay on the Cloud and read every 10 s while its graph is visible. Settle: close the tab after Show metrics and count the reads with the graph open.
  - C10: with 3 or more feeds on one cluster, each read downloads the whole cluster's body, and the 5 s floor queues the reads behind "read every 10 s". Settle: three feeds on one cluster, and measure their read times.
  - C11: when the Prometheus URL does not parse, the host shown and logged is the raw URL, unmasked. Settle: a unit test with a URL that carries userinfo.
  - C12, the smaller seams:
    - masking depends on the tab's source
    - Set up from the tab after a disconnect says "cluster gone" instead of offering Connect
    - the tab keeps a renamed file's old URI
    - a port rebind takes a Cloud-bound feed back to local
    - an untitled graph's button offers the pick
    - the config is parsed again on every reading. This one is a cost, not a risk; record it, and fix it only if it's cheap.
  - From bug 61: a `workspaceState` write can be lost the same way, for example the graph's per-file Hide. Settle: a test with a memento that loses one update. If it happens, fix it as bug 61 did.
- Decision: AI-8 split into two stories, this one (settle the risks) first and story 63 (the structural cleanup) after it (the user, 2026-11-23).
- Assumption: risk low. Each fix is local and covered by a test.
- Decision: no floor (VS Code 1.100.0) runs (the user).
