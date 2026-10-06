---
type: epic
title: "Smart YAML editing and local run"
parent: initiative-rpcn-vscode-designer
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-11, CAP-14]
after: []
assignee: ""
risk: medium
---

# Smart YAML editing and local run

## Description

The editor becomes Redpanda Connect–aware without any graph: schema completion, hover and validation from the user's own binary through Red Hat YAML, lint findings on save with Quick Fixes, Bloblang highlighting, snippets, file detection, and a local Run with Stop.

## Outcome

A developer edits a detected config in the native editor with schema help that matches their runtime, sees lint findings on save, and runs the pipeline from the editor; the spec's diagnostics-parity measure is the signal.

## Requirements

Completed at inception.

## Done when

1. In a detected config (no naming convention) the native editor offers completion, hover and validation from the user's binary via Red Hat YAML; after Set path these appear without reopening the file.
2. Saving shows lint findings inline, deduplicated against schema diagnostics (AD-12), with Quick Fixes applied as minimal-range edits (AD-19).
3. Bloblang in `mapping`, `check` and `${! }` is highlighted, and snippets scaffold pipeline sections.
4. Run auto-saves, streams logs to a per-file Pseudoterminal and Stop interrupts it; untitled files cannot Run.
5. Diagnostics match `rpk connect lint` for every config in the corpus, checked in CI; the CI `.vsix` carries it.

## Boundaries

Owns `src/adapters/redhatYaml`, the diagnostics, Quick Fix, snippet and terminal parts of `src/adapters/vscode`, the core lint parser and detection predicate, the DetectionRegistry (AD-18), and `syntaxes/`. No webview. CAP-6 here: detection only; auto-open is epic-pipeline-graph. CAP-1 here: editor features appearing after Set path. CAP-14 here: diagnostics-parity assertions.

## References

- parent — _bmad-output/initiative-rpcn-vscode-designer/initiative-rpcn-vscode-designer.md, section Done when
- spec — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, CAP-2–CAP-6, CAP-11, CAP-14
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-9, AD-11, AD-12, AD-13, AD-14, AD-18, AD-19
- ux — _bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md, YAML editor features, Run control, Flows 1–3; mockups/key-run.html

## Notes

- Handoff: provides to epic-pipeline-graph the deduped per-URI diagnostics accessor, `onDidChangeDetection`, and a hook for Show graph to mark a URI detected for the session.
- Waits on epic-foundation because: it needs the RedpandaConnect adapter, the cached schema, CI with the corpus harness, and the spike-verified lint output.
- Open question: lint findings always report column 1 (spike Q2), so diagnostics must map to the whole line; decide the range rule at inception (_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md, Q2).
- Open question: lint does not check resource references; a missing resource fails only at `run` (spike Q2). Decide whether diagnostics parity treats this as expected or adds a run-time check.
- Open question: templates (top-level `name` + `type` + `mapping`) fail `lint`; detection (AD-18) should exclude them (_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md, Q2).
- Open question: Stop sends SIGINT (exit 0 in the spike); add a SIGKILL escalation after a grace period, since a hanging shutdown was not tested (_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md, Q6).
- Open question: the 1.5 builder returns `env` (inherited + `NO_COLOR=1`), but the spawn site (`process.ts`) builds its own env and takes none; wire the builder's env through for lint and Run.
- Open question: check how Red Hat YAML renders the 1.6 merged docs (`markdownDescription`) next to the `anyOf` interpolation rewrite and next to `$ref` on top-level `input`/`output`.
- Note: the Run and Stop commands are contributed but hidden with no handler since 1.2; this epic enables them.
- Note: Run already passes `--set http.enabled=false` (1.5) to avoid port 4195 collisions between per-file runs.
- Source: out-of-scope list in _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/story-refactor-sweep-plan.md, Implementation Notes (user decision 2026-10-06).
