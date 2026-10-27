---
id: 24
type: bug
title: "After an overwrite rename, the moved test panels read the overwritten config's samples"
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

# After an overwrite rename, the moved test panels read the overwritten config's samples

## Description

When a config with open Bloblang test panels is renamed onto another config ("Replace"), the panels move to the new name (ticket 17), but their samples come from the overwritten config's samples file, and the moved config's own samples file stays under its old name. The user sees samples that belong to content that no longer exists, and their own samples seem lost.

## Reproduction

1. `a.yaml` and `b.yaml`, each with a `mapping` processor, a test panel open on each, and a saved sample in each (`a.samples.json`, `b.samples.json`).
2. In the Explorer, move `a.yaml` into a folder holding a `b.yaml`-named file, or rename `a.yaml` to `b.yaml` in a batch rename, and choose **Replace**.
3. Actual: `a`'s panel now shows `b.yaml` and the samples of `b.samples.json`; `a.samples.json` is still there; the user is told "Samples weren't moved: b.samples.json already exists."
4. Expected: the moved panel shows the moved config's own samples.

## Cause Hypothesis

The samples file follows a rename only when the target name has none: when it exists, both files are left and the user is told (4.17's rule for a plain rename). An overwrite rename destroys the target config, so its samples file no longer belongs to anything, but the rule treats it like a live one.

## Acceptance Criteria

1. **The moved panels keep their own samples**
   **Given** a config with test panels and samples renamed onto a config that has its own samples file
   **When** the rename overwrites the target
   **Then** the moved panels show the moved config's samples under the new name, and the outcome for the overwritten config's samples file is the one decided below
2. **A plain rename is unchanged**
   **Given** a rename onto a name that has no config
   **When** it applies
   **Then** the samples file moves as today, and a rename onto a samples file of a config that still exists keeps both and tells the user, as today
3. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers the overwrite rename, and one covers a batch where two renames land on one name
4. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the moved panels already show their own samples, with the evidence recorded in Notes — this supersedes 1 to 3

## References

- parent — none
- source — _bmad-output/backlog/bug-a-rename-that-overwrites-a-file-keeps-the-wrong-panel-plan.md, Review Triage Log row 6
- source — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the entry from ticket 17 on samples after an overwrite rename

## Notes

- Open question: what happens to the overwritten config's samples file — replaced by the moved config's (it belongs to destroyed content), or kept beside under another name, or kept and the user asked.
