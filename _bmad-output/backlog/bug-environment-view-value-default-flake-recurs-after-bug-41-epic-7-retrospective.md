---
id: 61
type: bug
title: "The Environment view's VALUE_DEFAULT test still fails now and then after bug 41 (epic 7 retrospective)"
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

# The Environment view's VALUE_DEFAULT test still fails now and then after bug 41 (epic 7 retrospective)

## Description

The Environment view's integration test "ticket 39 VALUE_DEFAULT / VALUE_AND_NAME / CANCEL" fails now and then in a full stable run, at "its record goes too", and passes when its suite is run alone. Bug 41 (done since `b270ac4`) made that check wait up to 5 s for the secret's record to go. The failure came back in epic 7's refactor sweep (7.10), so the wait did not fix it. Each recurrence costs a full stable rerun of about 14 minutes, and a real failure can hide among them. When this bug is fixed, the test passes in repeated full runs, or the record is shown to come back in the extension itself and that is fixed.

## Reproduction

1. Run the full stable suite (`env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`, `vscode-test --label stable`, capped with `timeout`) several times on one commit.
2. Actual: now and then the Environment view's "ticket 39 VALUE_DEFAULT …" test fails with "its record goes too" (seen in 7.10, 2026-11-21: 1718 passing, 1 failing; that suite alone then passed 34 of 34).
3. Expected: it passes in every full run.

## Cause Hypothesis

Bug 41's investigation found that VS Code's memento replaces a key's whole value when a storage-change echo arrives, from a 0 ms scheduler. So an echo of the earlier set can bring the removed key back after the remove's update resolved. A wait of 5 s doesn't help if the echo restores the record and nothing removes it again: then the record stays, which would also be a small defect in the extension (a recorded key with no value). It may instead be another suite's secret-storage write landing late, as in 7.9's sign-out race. This is a guess from the failure text and bug 41's notes. The test's own wait and the record's writes need reading under load.

## Acceptance Criteria

1. **The test passes reliably**
   **Given** one commit
   **When** the full stable suite runs several times (locally or in CI)
   **Then** "ticket 39 VALUE_DEFAULT …" never fails
2. **The cause is found and fixed where it lives**
   **Given** the cause found
   **When** the fix lands
   **Then** either the test waits on the condition it checks with its assertion unchanged, or, if the record really comes back, the extension removes it, and a test that fails on the defect and passes on the fix covers it
3. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it runs on the current code
   **Then** the failure no longer occurs, with the run count and the commit recorded in Notes — this supersedes 1 and 2

## References

- parent — none
- source — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics-retrospective.md`, Finding V3; action item AI-4
- related — `_bmad-output/backlog/bug-ci-timing-flakes-in-the-integration-suites-epic-6-findings.md` (bug 41, done; its item 2 and its plan's investigation)
- related — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/story-refactor-sweep-plan.md` (7.10, the recurrence)

## Notes

- Decision: filed as a new bug, not a reopened bug 41, so bug 41's record and its other four items stay closed (AI-4 allows either) (the user, 2026-11-23).
- Assumption: risk low (most likely a test wait; if the extension is at fault, a stale record is harmless), severity P2 (each failure costs a full rerun; rerunning is the workaround).
- Open question: AI-4's second half, a note on the secret-storage settle (7.9's 1 s settle and 7.4's wait) in the integration-test memory or AGENTS.md, is not in this bug. Record it here when the cause is known, or separately.
- Decision: no floor (VS Code 1.100.0) runs (the user).
