---
id: 42
type: story
title: "Deploy includes the resource files or refuses with the reason"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# Deploy includes the resource files or refuses with the reason

## Description

A config that uses resources from `redpandaConnect.resourceFiles` runs locally, but Deploy to Redpanda Cloud sends only the config, so the pipeline in the Cloud lacks them. When this is done, Deploy sends the resources the config uses in the one config the Cloud runs, or refuses before anything is sent and names what it cannot include. This is the second part of epic 5's requirement E5 (R7), split from ticket 5.6.

## Acceptance Criteria

1. **The resources are sent**
   **Given** a config that uses a cache and a processor resource defined in a resource file listed in `redpandaConnect.resourceFiles`
   **When** it is deployed
   **Then** the config sent holds those resources, translated for the Cloud as the config is (variables as secrets), and the local files are unchanged
   **And** "Nothing changed" and the update's diff compare the text as sent
2. **A resource that cannot be included is refused**
   **Given** a resource file that cannot be read, or a resource whose name the config defines too
   **When** the config is deployed
   **Then** nothing is sent and the message names the file or the resource and why
3. **No resource files, no change**
   **Given** a config with no resource files set
   **When** it is deployed
   **Then** the deploy behaves as before

## Boundaries

- Must not change: the deploy of a config without resource files, the variables' translation (5.6), the pre-deploy check (5.8).

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud.md, E5 (R7)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-translate-the-config-for-the-cloud-plan.md (the split)

## Notes

- Decision: moved here from epic 5's refactor sweep (5.9) rather than built there (user, 2026-11-09).
- Open question: how the resources are merged into the config sent (the config's own `*_resources` lists, or another form the Cloud accepts).
