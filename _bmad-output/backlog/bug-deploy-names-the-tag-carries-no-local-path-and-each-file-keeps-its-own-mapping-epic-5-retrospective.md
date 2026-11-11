---
id: 47
type: bug
title: "Deploy names: the tag carries no local path and each file keeps its own mapping (epic 5 retrospective)"
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

# Deploy names: the tag carries no local path and each file keeps its own mapping (epic 5 retrospective)

## Description

Deploy names a pipeline's file by a tag and keeps a mapping file beside the config. Both names come from the file's path alone. A file outside every workspace folder sends its full local path, user name included, as a Cloud tag. Two files with the same relative path in two workspace folders get one tag, so the row's file, Compare and Deploy again can open the wrong one. And `orders.yaml` and `orders.yml` in one folder share one mapping, so a deploy of one updates the other's pipeline. When this is fixed, the tag carries no local path and names the folder, and each file keeps its own mapping. Pipelines and mappings made before the fix keep working.

## Reproduction

Each case reproduces from the dev host, or from the Cloud integration suite with the fake cloud.

1. **C3 The file tag.** Deploy a file outside every workspace folder. Its absolute local path is sent as the pipeline's tag. In a multi-root workspace, deploy `a/orders.yaml` and `b/orders.yaml`. Both pipelines get the same tag, and the row's file, Compare and Deploy again can resolve either pipeline to either file.
2. **C7 One mapping for two files.** Put `orders.yaml` and `orders.yml` in one folder and deploy each. Both use `orders.cloud.json`. The second deploy updates the first file's pipeline instead of creating its own.

## Cause Hypothesis

The tag is the path relative to the workspace, which drops the folder in a multi-root workspace and falls back to the full path outside every folder. The mapping name drops the file's extension. Both were chosen for one-folder workspaces with one config per name (ticket 5.3).

## Acceptance Criteria

1. **The tag carries no local path**
   **Given** a file outside every workspace folder
   **When** it is deployed
   **Then** no absolute path or user name is sent in the tag or anywhere else in the request
   **And** the tag is the file's base name, or Deploy refuses with the reason and sends nothing
2. **The tag names the workspace folder**
   **Given** a multi-root workspace with `a/orders.yaml` and `b/orders.yaml`
   **When** each is deployed
   **Then** the two pipelines get different tags, each naming its workspace folder
   **And** the row's file, Compare and Deploy again resolve each pipeline to its own folder's file only
3. **Pipelines tagged before the fix still resolve**
   **Given** a pipeline whose tag has the old format
   **When** the row's file, Compare or Deploy again is used
   **Then** a tag that matches one file resolves to it as today
   **And** a tag that matches files in two folders is never resolved to one of them without the user's choice or a message
4. **One mapping per file**
   **Given** `orders.yaml` and `orders.yml` in one folder
   **When** each is deployed
   **Then** each keeps its own pipeline and its own mapping
   **And** a mapping found for another file is never used without a message
5. **Mappings written before the fix still work**
   **Given** a config with a mapping written before the fix, and no other config that shares it
   **When** the config is deployed, or its pipeline is deleted from the Cloud view
   **Then** the same pipeline is updated or deleted as today, and the mapping is found as today
6. **Tests cover the conditions found and fixed**
   **Given** the integration suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers each of criteria 1 to 5, the multi-root ones in the multi-root run

## References

- parent — none
- source — _bmad-output/backlog/bug-deploy-flow-edge-cases-epic-5-retrospective.md, criteria 2 and 6, Reproduction items 2 and 6
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md, findings C3 and C7
- prior — _bmad-output/backlog/bug-deploy-flow-edge-cases-epic-5-retrospective-plan.md, Intent (group B deferred)
- deferred work — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, entry "Bug 45 group B, names"

## Notes

- Decision: bug 45 split; group B (names) is this ticket (user, 2026-11-10). Made from the epic 5 retrospective's recommendations (user, 2026-11-11, "use your recommendations").
- Code at 4fffc16: the tag is set in `src/adapters/vscode/cloudDeploy.ts` (`asRelativePath`, `CONFIG_TAG`); it is resolved in `src/adapters/vscode/cloudView.ts` (the row's file) and `src/adapters/vscode/cloudActions.ts` (`taggedSidecars`); the mapping name is `sidecarPath` in `src/adapters/cloud/sidecar.ts`; the tag key is in `src/adapters/cloud/dataPlane.ts`.
- Open question: how existing tags are read. The fix changes the tag format that the row's file, Compare and Deploy again resolve. Options: read both formats (old by relative path, new by folder and path); rewrite the tag on the next Deploy; or treat an old tag that matches two files as unresolved. Decide in the plan's checkpoint.
- Open question: the new mapping name, and whether an old `<stem>.cloud.json` is renamed on the next Deploy or kept and read as a fallback when only one config could own it.
- Assumption: in criterion 1, the base name is used for a file outside every folder, unless the plan's checkpoint picks refusal (bug 45's assumption, carried over).
- Decision: no floor (VS Code 1.100.0) runs (user).
