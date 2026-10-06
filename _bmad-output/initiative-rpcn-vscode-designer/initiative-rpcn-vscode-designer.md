---
type: initiative
title: "Pipeline Designer for Redpanda Connect"
parent: none
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7, CAP-8, CAP-9, CAP-10, CAP-11, CAP-12, CAP-13, CAP-14]
after: []
assignee: ""
risk: medium
status: in-progress
---

# Pipeline Designer for Redpanda Connect

## Description

An open-source VS Code extension (POC) that makes local Redpanda Connect development smarter: a schema-aware YAML editor driven by the developer's own binary, a read-only pipeline graph beside it, and a local run loop. The spec owns the capabilities, constraints and non-goals; this initiative delivers them as CI-built `.vsix` packages installed by hand; registry publishing is parked for the POC.

## Outcome

Redpanda Connect developers author, check and run pipelines locally in VS Code with live schema help and a graph of the pipeline; the spec's success signal (graph accuracy, diagnostics parity, newcomer under 10 minutes) is the measure.

## Done when

1. A CI-built `ajurcenk.rpcn-pipeline-designer` `.vsix` installs in VS Code and pulls in `redhat.vscode-yaml` (registry publishing parked, see Notes).
2. For 100% of the reference corpus the graph is accurate and editor diagnostics match `rpk connect lint`, checked in CI against v4.100.0 and v4.112.0.
3. A newcomer with a binary installed builds and runs a first working pipeline in under 10 minutes (EXPERIENCE Flow 3).
4. Every capability CAP-1–CAP-14 works in a released build, not only on a branch.

## Boundaries

Capability boundary: one solo owner with agent lanes; epics are cut by separately usable outcome (baseline → smart YAML editing and run → graph). Out of scope: the spec's Non-goals and the architecture spine's Deferred table (BYOC deploy, graph editing, streams mode, Bloblang LSP, lint while typing, panel restore after reload, debugging groundwork, telemetry, i18n). Tracer path: open a cookbook config → binary and schema resolved (epic-foundation) → completion and lint on save (epic-smart-yaml-editing) → graph beside it with a marker on the faulty node (epic-pipeline-graph).

- Touch point: redhat.vscode-yaml — schema supplied via `registerContributor`, no code change there; owner: epic-smart-yaml-editing
- Touch point: the user's `rpk` / `redpanda-connect` binary — consumed via the RedpandaConnect adapter; owner: epic-foundation

## References

- spec — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, section Capabilities
- constraint — the same spec, section Constraints
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md (AD-1–AD-20; cross-epic decisions AD-9, AD-10, AD-12, AD-15, AD-18, AD-19, AD-20)
- ux — _bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md and DESIGN.md

## Notes

- Decision: three epics in the order foundation → smart YAML editing and run → pipeline graph; CI packaging lives in the opening epic so every epic ships an installable `.vsix` (user, 2026-10-06).
- Decision: shared decisions are homed in the architecture spine, so no coordination stories (user, 2026-10-06).
- Parked: CAP-13 registry publishing (Marketplace and Open VSX) is skipped for the POC; CI packages a `.vsix` instead (user, 2026-10-06).
- Decision: "production" for every epic means a green CI build whose `.vsix` installs in VS Code (user, 2026-10-06).
- Decision: repo ticket store in the project repo github.com/ajurcenk/rpcn-pipeline-designer (user, 2026-10-06).
