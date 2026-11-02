---
type: epic
title: "Deploy to Redpanda Cloud"
parent: initiative-rpcn-vscode-designer
covers: []
after: []
assignee: ""
risk: high
---

# Deploy to Redpanda Cloud

## Description

A developer deploys the Redpanda Connect config they are editing to a Redpanda Cloud BYOC or Dedicated cluster, and manages the deployed pipeline, without leaving VS Code. The extension signs in with a Redpanda Cloud service account, finds the organization's clusters, translates the local config for the Cloud (variables to cloud secrets, resource files included, local-only parts flagged), creates or updates the pipeline through the cluster's Data Plane API, and shows the deployed pipelines, their state and errors in a Cloud view. The spec lists Cloud deployment as a non-goal; the user brought it into scope on 2026-11-02 (Notes), so this epic's requirements are its own lines below until the spec gains a capability for them.

## Outcome

A developer goes from a config that runs locally to the same pipeline running on their BYOC or Dedicated cluster in one Deploy, and back to the deployed state from the Cloud view, without the Cloud UI.

## Requirements

Source: the user's decisions of 2026-11-02 in this conversation and the brief's roadmap step 4 ("Deploy: push to Redpanda Cloud BYOC clusters"); no parent capability yet (covers is empty until the spec gains one).

- E5 (R1) Sign-in: a service account's client ID and secret are kept in VS Code's secret storage; tokens come from the OAuth client-credentials flow, are cached for their lifetime and renewed when needed; no secret or token appears in a log line, message, setting or file.
- E5 (R2) Clusters: the organization's BYOC and Dedicated clusters are listed with their cloud, region and Connect version, and each one's Data Plane API address is found; a cluster that does not offer the pipeline API is shown as such.
- E5 (R3) Deploy: the active config is created as a pipeline on a chosen cluster with a display name, description, resources and tags.
- E5 (R4) Mapping: a committed sidecar beside the config (`<name>.cloud.json`: the cluster and pipeline ids) and a tag on the pipeline tie the two; deploying again updates that pipeline.
- E5 (R5) Overwrite safety: replacing the config of a running pipeline shows a diff of the deployed and local config and needs a confirmation.
- E5 (R6) Resources: CPU (memory follows) comes from a setting, chosen on the first deploy.
- E5 (R7) Translation: `${VAR}` references become `${secrets.VAR}`; resource files are included in the config or the deploy is refused with the reason; local-only parts (stdin, stdout, local files and programs, `http_server`) get warnings.
- E5 (R8) Cloud secrets: the deploy checks which secrets the cluster has and offers to create the missing ones from the local values, in one confirmation that names them; values never enter the config.
- E5 (R9) Lifecycle: a pipeline can be started, stopped and deleted (after a confirmation), and its state and error are shown.
- E5 (R10) Cloud view: the service account, its clusters and their pipelines in the Redpanda Connect sidebar, with the local file each was deployed from; the deployed config opens read-only and can be compared with the local file; refresh.
- E5 (R11) Pre-deploy check: the config is checked against what the cluster runs (its Connect version and components) where the APIs allow.

## Done when

1. With a service account set, the active config deploys to a chosen BYOC or Dedicated cluster and shows as running in the Cloud view.
2. Deploying again updates the same pipeline, after a diff and a confirmation when it is running.
3. A config using `${VAR}` deploys with `${secrets.VAR}`; missing cloud secrets are offered for creation; no secret value appears in the config, a log line, argv, a message or a file.
4. Start, stop and delete, with the state and error, work from the Cloud view and from commands.
5. Integration tests against a local fake of the Control Plane and Data Plane APIs pass in CI, and a manual deploy to the user's real cluster passes.

## Boundaries

A new `cloud` adapter (HTTP clients for the Control Plane and Data Plane APIs, the token cache), separate from the binary adapter; the deploy reuses the binary only for the local lint. Not this epic: logs and metrics, browser (user) sign-in, Serverless clusters, editing pipelines that exist only in the Cloud, streams mode.

- Touch point: the Environment view's secrets and `redpandaConnect.env` — read to create cloud secrets; owner: this epic.
- Touch point: the Redpanda Connect sidebar container — a new Cloud view beside Environment; owner: this epic.
- Touch point: lint — reused for the pre-deploy check; owner: this epic.

## References

- parent — _bmad-output/initiative-rpcn-vscode-designer/initiative-rpcn-vscode-designer.md
- brief — _bmad-output/initiative-rpcn-vscode-designer/brief-rpcn-vscode-designer/brief-rpcn-vscode-designer.md, roadmap step 4
- constraint — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, section Constraints (theme only, no Redpanda branding, stable APIs, `^1.100.0`)
- design — https://claude.ai/artifact/JXvum3sCSPMWEDeP6e2ivt (boards 1–6: connect, Cloud view, deploy, translation and secrets, update, states)
- api — https://docs.redpanda.com/cloud-data-platform/manage/api/cloud-dataplane-api/ (Data Plane URL, pipelines, secrets)
- api — https://docs.redpanda.com/api/doc/cloud-dataplane/operation/operation-pipelineservice_createpipeline
- auth — https://docs.redpanda.com/redpanda-cloud/security/cloud-authentication/

## Notes

- Source conflict: spec Non-goals — "BYOC or Cloud deployment" vs the user's 2026-11-02 decision to build it (the brief's roadmap step 4). Settled by the Decision below; the spec is not yet amended (offer `bmad-spec` to add a capability and drop the non-goal).
- Decision (user, 2026-11-02): scope is deploy, lifecycle and a Cloud view; logs and metrics later.
- Decision (user, 2026-11-02): sign-in with a service account's client ID and secret in VS Code's secret storage; browser sign-in later.
- Decision (user, 2026-11-02): BYOC and Dedicated clusters; a cluster that rejects the pipeline API is reported.
- Decision (user, 2026-11-02): a committed sidecar per config plus a tag on the pipeline.
- Decision (user, 2026-11-02): `${VAR}` to `${secrets.VAR}`, checking the cluster's secrets and offering to create the missing ones from local values.
- Decision (user, 2026-11-02): confirm before replacing a running pipeline, with a diff; resources from a setting with a first-time prompt.
- Decision (user, 2026-11-02): the opening spike runs on the user's real BYOC or Dedicated cluster with a service account they create.
- Decision (user, 2026-11-02): tracer is entry 2 (connect, pick a cluster, deploy as written, see it running); entries 3 and 4 can run beside each other after it.
- Unknown: whether Dedicated clusters offer the pipeline API today (the Data Plane API page lists BYOC and Serverless); entry 1 answers it.
- Unknown: whether any API reports a cluster's allowed components or validates a config before create; entry 1 answers it, entry 8 waits on it.
