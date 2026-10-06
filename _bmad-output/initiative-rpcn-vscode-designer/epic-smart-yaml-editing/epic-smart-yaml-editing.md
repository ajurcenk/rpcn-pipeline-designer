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
