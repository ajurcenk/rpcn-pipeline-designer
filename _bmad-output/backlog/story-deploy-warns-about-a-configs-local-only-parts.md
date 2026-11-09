---
id: 43
type: story
title: "Deploy warns about a config's local-only parts"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Deploy warns about a config's local-only parts

## Description

A config that reads stdin, writes stdout, uses local files or programs, or serves `http_server` deploys to Redpanda Cloud with no warning, though those parts cannot work there as they do locally. When this is done, Deploy shows each such part as a warning in the Problems panel on its line and says so before sending, and the user can deploy anyway. This is the third part of epic 5's requirement E5 (R7), split from ticket 5.6.

## Acceptance Criteria

1. **Local-only parts are warned about**
   **Given** a config with a `stdin` input and a `file` output
   **When** it is deployed
   **Then** each shows a warning on its line in the Problems panel (source "Redpanda Cloud"), and the message lists them with **Deploy anyway**
   **And** Escape sends nothing; Deploy anyway sends the config as before
2. **The warnings go when they should**
   **Given** the warnings shown
   **When** the file changes or closes, or the next deploy runs
   **Then** they are cleared, as the pre-deploy check's findings are (5.8)
3. **A clean config is not asked**
   **Given** a config with no local-only part
   **When** it is deployed
   **Then** the deploy behaves as before, with no prompt

## Boundaries

- Must not change: the pre-deploy check's errors (5.8), the secrets questions (5.7), a clean deploy.

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud.md, E5 (R7)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-check-the-config-against-the-cluster-before-deploying-plan.md (the check's Problems and Deploy anyway)

## Notes

- Decision: moved here from epic 5's refactor sweep (5.9) rather than built there (user, 2026-11-09).
- Open question: the exact list of local-only components (beyond stdin, stdout, `file`, `subprocess`/`command`, `http_server`), and whether one prompt with the pre-deploy check's findings is shown, or two.
