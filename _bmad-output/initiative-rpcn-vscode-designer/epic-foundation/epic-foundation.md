---
type: epic
title: "Foundation: binary, schema and release pipeline"
parent: initiative-rpcn-vscode-designer
covers: [CAP-1, CAP-13, CAP-14]
after: []
assignee: ""
risk: medium
status: done
---

# Foundation: binary, schema and release pipeline

## Description

The platform baseline every other epic builds on: the extension scaffold, the single RedpandaConnect adapter that finds and runs the user's binary, the generated and cached schema, the reference corpus with its test harness, and CI that builds an installable `.vsix`. It opens with a spike that verifies the CLI facts the architecture rests on.

## Outcome

A developer installs the CI-built `.vsix` and the extension resolves their binary and its schema, or tells them how to fix it; CI proves the CLI facts against v4.100.0 and v4.112.0.

## Requirements

- E1 (R1) → CAP-1 (part): Resolve the binary in AD-9 order (`rpk` on PATH as `rpk connect` > `redpanda-connect` on PATH > `redpandaConnect.binaryPath` as a fallback when PATH yields no usable binary), read its version, treat < v4.100.0 as invalid, and expose an observable `binaryState` (`unresolved | ok{path, version} | missing | invalid`) with `onDidChange`; re-resolve on activation, setting change and `refresh()`. (spec CAP-1; AD-9)
- E1 (R2) → CAP-1 (part): Notify once per transition into `missing` or `invalid` with Install guide and Set path; Set path stores `binaryPath` and re-resolves without a reload. (spec CAP-1; EXPERIENCE Flow 2, Voice and Tone)
- E1 (R3) → architecture: Generate the schema with `list --format jsonschema`, apply the one versioned transform, cache it in globalStorage under a URI keyed by hash(path + version), generate single-flight, and offer Refresh schema. (AD-10; input to AD-20)
- E1 (R4) → architecture: One RedpandaConnect adapter owns all process spawning with `NO_COLOR=1`, plus the shared lint/run argument builder (`-r`, `-e`, lint `--skip-env-var-check`). (AD-9)
- E1 (R5) → CAP-14 (part): Reference corpus under `test/corpus/` from the Redpanda Connect cookbook, and a harness that runs in CI against v4.100.0 and v4.112.0; E2 adds diagnostics-parity and E3 graph-accuracy assertions. (spec CAP-14)
- E1 (R6) → CAP-13 (part): CI packages one `.vsix` as `ajurcenk.rpcn-pipeline-designer`, display name "Pipeline Designer for Redpanda Connect", Apache-2.0 LICENSE/NOTICE, `extensionDependencies` `redhat.vscode-yaml`. Registry publishing is parked. (spec CAP-13; spine Operational envelope)
- E1 (R7) → spec Open Questions: Verify the lint stderr format, the `list --format jsonschema` shape and `rpk connect` vs standalone `redpanda-connect` parity against v4.100.0 and v4.112.0.

## Done when

1. CI on every push builds and tests one `.vsix` (`ajurcenk.rpcn-pipeline-designer`, Apache-2.0 LICENSE/NOTICE); installing it in VS Code pulls in `redhat.vscode-yaml`.
2. With a valid binary (>= v4.100.0) the extension resolves it in AD-9 order and caches its transformed schema keyed by path and version (AD-10); with none, or an older one, it shows the Install guide / Set path notification once.
3. CI runs vitest and `@vscode/test-cli` on Node 24 against Redpanda Connect v4.100.0 and v4.112.0, over a seeded reference corpus.
4. The spike's findings (lint stderr format, `list --format jsonschema` shape, rpk vs standalone parity) are recorded and the spec's two open questions are answered.

## Boundaries

Owns the scaffold (generator-code, esbuild two bundles, `src/extension.ts`, OutputChannel, `redpandaConnect.*` namespace), `src/core` skeleton, `src/adapters/redpandaConnect` (binaryState, resolution, arg builder, process spawning), schema generation, transform and cache, CI packaging. Not: registry publishing (parked), Red Hat schema contribution, lint diagnostics, Run UI (epic-smart-yaml-editing), any webview (epic-pipeline-graph). CAP-1 here: detection, version check and the notification; the editor and graph parts are in the later epics. CAP-14 here: the corpus, harness and CI binaries; the assertions come with epic-smart-yaml-editing and epic-pipeline-graph.

## References

- parent — _bmad-output/initiative-rpcn-vscode-designer/initiative-rpcn-vscode-designer.md, section Done when
- spec — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, CAP-1, CAP-13, CAP-14
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-9, AD-10, AD-15, Stack, Operational envelope
- ux — _bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md, Flow 2 and binary-missing state; mockups/key-binary-missing.html
- research — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/research-and-cli-reference.md, CLI facts

## Notes

- Handoff: the spike's verified lint and schema output is an explicit output that epic-smart-yaml-editing's lint parser builds on.
- Decision: the spike runs before the tracer bullet; ticket 2 waits on it by the user's choice, not a technical need (user, 2026-10-06).
- Decision: tracer bullet is ticket 2 — scaffold, a YAML file opening, the binary's version in the output channel, CI packaging a `.vsix`; it owns the package.json identity and every `redpandaConnect.*` contribution so later tickets add code, not manifest churn (2026-10-06).
- Decision: least-certain slice is the spike (CLI facts); after the tracer, binary resolution (3) unlocks 4, 5 and 6 in parallel (2026-10-06).
- Decision: registry publishing (Marketplace, Open VSX, publisher accounts, secrets) is skipped for the POC; CAP-13 is delivered only as the CI `.vsix` (user, 2026-10-06).
- Decision: the reference corpus comes from the Redpanda Connect cookbook examples, with source and license recorded per file (user, 2026-10-06).
- Assumption: Install guide opens the Redpanda Connect installation page in the Redpanda docs; ticket 4 confirms the exact URL.
- Assumption: CI installs the standalone `redpanda-connect` release archives from GitHub pinned to v4.100.0 and v4.112.0; `rpk connect` is checked once in the spike and manually after that.
- Collision: tickets 4, 5 and 6 run in parallel after 3 and all touch `src/adapters/redpandaConnect`; each works in its own file and only ticket 2's index and manifest are shared.
- Decision: epic closed as done (user, 2026-10-06). Closure check: Done when 1 — CI builds the .vsix with LICENSE/NOTICE and installing it into an empty profile pulled in redhat.vscode-yaml 1.24.0; 2 — binary resolution, schema cache and the once-per-transition warning checked by tests and by hand (Set path missing → ok 4.100.0, no reload); 3 — CI runs @vscode/test-cli and the vitest corpus harness on Node 24 against 4.100.0 and 4.112.0; 4 — spike findings recorded, spec open questions answered. Follow-ups placed in epic-2/epic-3 Notes and backlog tickets.
