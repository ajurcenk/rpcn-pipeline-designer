---
id: 57
type: bug
title: "Metrics ignores a shared sidecar's owner tag"
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

# Metrics ignores a shared sidecar's owner tag

## Description

When a config's only deploy mapping is an old `<stem>.cloud.json` that two configs beside it could own (`orders.yaml` and `orders.yml`), the Cloud actions read the mapped pipeline's `rpcn-vscode/config` tag and, when the tag names that config alone, use the mapping for it (bug 47). The Pipeline Metrics tab's mapped-pipeline lookup does not: it treats the mapping as shared and finds no mapped Cloud pipeline for either config. So, with no local run, the tab offers no mapped pipeline where Show logs, Deploy, Start and Stop find one. It should find the same pipeline the Cloud actions find.

## Reproduction

1. Connect a service account; deploy `orders.yaml` from a build before bug 47, so its mapping is the old `orders.cloud.json` and its pipeline's tag names `orders.yaml`.
2. Add `orders.yml` beside it.
3. With `orders.yaml` active and not running, use Show logs from the palette: the mapped pipeline is used.
4. Use Show Pipeline Metrics (or the tab's mapped-pipeline button) on `orders.yaml`.
5. Actual: no mapped Cloud pipeline (the tab offers the pick or its no-config state). Expected: the pipeline the mapping names, as in step 3.

## Cause Hypothesis

`mappingOf` in `src/extension.ts` (about line 314) calls `findMapping(uri.fsPath)` with no `folders` and no `tagOf`, so an old mapping with several possible owners is always `shared`; the Cloud actions' palette target (`src/adapters/vscode/cloudActions.ts`, about line 156) passes `this.ctx.workspaceFolders()` and `mappedTagOf(this.ctx)`. Giving the metrics lookup the tag needs the Cloud view's context (the tab is built before the view), and reading the tag may load a cluster's pipelines.

## Acceptance Criteria

1. **The metrics lookup finds the pipeline the Cloud actions find**
   **Given** a config whose only mapping is an old `<stem>.cloud.json` with several possible owners, and the mapped pipeline's tag naming that config alone
   **When** the Pipeline Metrics tab looks up the config's mapped Cloud pipeline
   **Then** it finds the pipeline the mapping names, as the Cloud actions do, and none for the other config
2. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers the shared old mapping with an owner tag, and one covers a tag naming neither config (still no mapped pipeline)
3. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it is run on the current code
   **Then** the tab already finds the mapped pipeline, or the difference is intended, with the evidence recorded in Notes — this supersedes 1 and 2

## References

- parent — none
- source — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/story-refactor-sweep-plan.md`, Decisions
- related — `_bmad-output/backlog/bug-deploy-names-the-tag-carries-no-local-path-and-each-file-keeps-its-own-mapping-epic-5-retrospective.md` (bug 47, the tag-aware lookup)

## Notes

- Decision: recorded here by epic 7's refactor sweep (7.10) rather than changed there, as 6.9 did for its flakes (user, 2026-11-21).
- Assumption: P3, as only mappings written before bug 47 with two configs of one stem are affected.
