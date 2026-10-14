---
type: epic
title: "Bloblang check and test"
parent: initiative-rpcn-vscode-designer
covers: [CAP-1, CAP-13, CAP-14, CAP-15, CAP-16, CAP-17]
after: []
assignee: ""
risk: medium
status: in-progress
---

# Bloblang check and test

## Description

The second release: live Bloblang syntax errors in `mapping` and `mutation` processors, a Bloblang test panel that runs one mapping on a sample message with the developer's own binary, and sample messages saved in the workspace. The spec owns the capabilities (CAP-15–CAP-17); the UI prototype shows the panel's layout and states.

## Outcome

A developer checks and tests a mapping next to its YAML instead of copying it into the docs playground; the spec's second-release success signal (the panel's result and the editor's parse errors match the binary's `blobl` on every corpus mapping) is the signal.

## Requirements

- E4 (R1) → CAP-15: For every `mapping` and `mutation` processor (nested ones and `processor_resources` included), the core returns the processor's Bloblang text (block, folded, plain and quoted scalars decoded) and a map from Bloblang line and column to a document offset, keyed by the processor's node id (AD-7, AD-16).
- E4 (R2) → CAP-15: Each changed mapping is parsed by the developer's binary while typing, debounced and single-flight per mapping; parse errors appear in their own diagnostics collection (source "Bloblang") at the mapped line and column with the binary's message, and clear when the mapping parses; no other Bloblang field gets diagnostics (AD-14 amended).
- E4 (R3) → CAP-15, CAP-10: A Bloblang parse error marks its processor's node in the graph like any error (AD-17 amended).
- E4 (R4) → CAP-16: A "▷ Test mapping" CodeLens above each `mapping:` / `mutation:` field and the command "Redpanda Connect: Test mapping" (the mapping at the cursor) open that mapping's panel; there is one panel per mapping, titled "Bloblang: {label or path}".
- E4 (R5) → CAP-16: The panel runs the mapping on the binary with the sample's content and metadata, and shows the output content and metadata with added or changed fields and keys marked, plus a status with the run's duration and the binary's version; it re-runs when the mapping or the input changes ("Run on change", on by default) and on Run.
- E4 (R6) → CAP-16: On failure the panel shows the binary's parse error (with its caret excerpt) or mapping error, translates the mapping line to the file line, and offers Go to line; a failure on the current sample also shows at the end of that line in the editor; the last successful output stays dimmed; a deleted message and input that is not valid for the mapping each have their own state.
- E4 (R7) → CAP-16, CAP-1: With no usable binary the panel offers Install guide, Set path and Retry, and runs once a binary is found, without reopening (AD-9).
- E4 (R8) → CAP-16: A panel follows its processor through edits (shifted ranges, a changed label), says so when the processor is removed, closes with the file's last tab and follows a file rename.
- E4 (R9) → CAP-17: Each mapping has named samples (content and metadata) in a workspace file next to the config; the panel adds, renames, deletes and switches samples and saves edits; samples link to their mapping by `label`, with the processor's path as a fallback and an offer to add a label; the file reloads on outside edits; the CodeLens shows the sample count.
- E4 (R10) → CAP-16: Every panel control is reachable and operable by keyboard; the panel and its regions have accessible names; run results and errors are announced in a polite live region; colours come from the VS Code theme, high contrast included (EXPERIENCE Accessibility Floor, DESIGN tokens).
- E4 (R11) → CAP-14: Corpus configs with a `mapping` or `mutation` get sample inputs; for each, on v4.100.0 and v4.112.0, the harness compares the extension's run result with the recorded run of the AD-21 one-message pipeline, and its parse diagnostics with recorded `blobl` output.
- E4 (R12) → CAP-13: esbuild builds the panel's webview bundle and the CI `.vsix` carries it.
- E4 (R13) → architecture, UX: AD-21 (how Bloblang runs on the binary) and AD-22 (sample storage and linking) are added; AD-12, AD-14 and AD-17 are amended; EXPERIENCE gains the panel's states, flow and accessibility rules and DESIGN its tokens. Each change lands in the ticket that makes the decision.

## Done when

1. Typing a syntax error in any `mapping` or `mutation` processor shows the binary's message at the right YAML line and column within about a second and marks the processor's graph node; fixing it clears both (VS Code integration tests with a fake binary, plus the corpus parse check).
2. Test mapping opens that mapping's panel, and for 100% of corpus mappings with a sample on v4.100.0 and v4.112.0 the panel's output, error or "deleted" matches the binary's recorded run of the AD-21 one-message pipeline, and every parse error matches `blobl` (corpus harness in CI).
3. Samples are saved next to the config, are there after a window reload, and stay attached to their mapping when processors are reordered.
4. With no binary the panel shows Install guide, Set path and Retry, and runs after Set path without reopening the file.
5. The panel works by keyboard and screen reader, the CI `.vsix` carries it, and the user passes a hands-on check on VS Code 1.141 and 1.100 in light, dark and high-contrast themes.

## Boundaries

Capability boundary: Bloblang check (CAP-15) and test (CAP-16, CAP-17) for `mapping` and `mutation` processors only. Owns the Bloblang text and position map in `src/core`, a Bloblang execution module in `src/adapters/redpandaConnect` (AD-9: still the only spawn site), the live parse service and its diagnostics collection in `src/adapters/vscode`, the test panel adapter and its webview bundle, the sample file, and the corpus `blobl` records. Changes the graph only to feed Bloblang diagnostics into node status. Not: other Bloblang fields, `${! }` interpolations or `.blobl` files, messages from a run, earlier processors applied first, `rpk connect test`, a bundled engine (spec Non-goals).

## References

- parent — _bmad-output/initiative-rpcn-vscode-designer/initiative-rpcn-vscode-designer.md, section Done when
- spec — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md, CAP-15–CAP-17, Constraints, Non-goals, Success signal, Open Questions
- research — _bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/research-and-cli-reference.md, CLI facts (`blobl server`, `blobl`) and Docs Bloblang playground
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-1, AD-5, AD-7, AD-9, AD-12, AD-14, AD-15, AD-16, AD-17
- ux — _bmad-output/initiative-rpcn-vscode-designer/brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html (layout and the five states); _bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md and DESIGN.md
- retrospective — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/epic-pipeline-graph-retrospective.md, AI-7 and AI-8

## Notes

- Waits on epic-foundation because: the binary adapter is the only spawn site, and the corpus harness runs the pinned binaries.
- Waits on epic-smart-yaml-editing because: the Bloblang field list, the parse cache and the diagnostics adapter are reused.
- Waits on epic-pipeline-graph because: node ids and ranges link samples and markers, NodeStatusService takes the new diagnostics, and the webview bundle, CSP and panel group logic are reused.
- Source conflict: AD-14 — "Still no Bloblang diagnostics" vs CAP-15 live Bloblang syntax diagnostics; entry 5 amends AD-14 (spec already amended, 08ec533).
- Source conflict: AD-12 — lint "runs on save only" and is the authoritative validation vs a live Bloblang parse; entry 5 records that the Bloblang parse is not lint and has its own collection, so lint's clear-on-first-edit does not clear it.
- Open question: metadata in and out of a test (spec Open Questions); entry 1 answers it and entry 7 implements the answer.
- Open question: sample storage and linking (spec Open Questions); entry 9 decides it in AD-22.
- Unknown: whether `blobl server` exists and behaves the same on v4.100.0; entry 1 probes it, and entries 2 and 5 wait on the answer.
- Decision (user, 2026-10-12): Bloblang parse errors also mark the processor's node in the graph (R3, entry 6).
- Decision (user, 2026-10-12): one test panel per mapping, as in the prototype (R4, R8).
- Decision (user, 2026-10-12): the panel opens from the CodeLens and the Command Palette in this epic; a graph-node action is not in this epic.
- Decision (user, 2026-10-12, "continue"): breakdown of 14 entries in `tickets.toml`. Spike 1 first (it decides the execution route every later entry uses); the tracer bullet is entry 2 (CodeLens and command open a panel that runs the mapping on typed JSON through every layer); contracts early in entry 4; the closing refactor sweep is entry 13 and the user's hands-on checks entry 14 (hitl).
- Decision (user, 2026-10-12): lanes. Panel lane 2 → 7 → 8 → 9 → 10 → 11 is serialised (shared panel adapter, webview and `src/extension.ts`); core 3; diagnostics 5 → 6; corpus 12. Entry 7 waits on 5 because both touch `src/extension.ts` and the Bloblang execution module. After 2, entries 3 and 4 can run in parallel; after 5, 6 and 7; after 7, 8 and 12.
- Decision (user, 2026-10-12): 14 entries, above the typical 8–12, kept as one epic (mostly one lane, one owner).
- Decision (E3 retro AI-7, 2026-10-12): each entry's plan names the earlier tickets its code meets (its `after` and the epics it reuses) and adds at least one combined-sequence test for each such boundary; its review weights them.
- Decision (E3 retro AI-8, 2026-10-12): an entry that adds a protocol message, a setting, a context key, an architecture rule or a user decision updates the AD, EXPERIENCE or DESIGN line in the same commit.
- Decision (user, 2026-10-12, spike 4.1): AD-21 adopted. Live parse: one-shot `blobl -f`, stdin closed; test runs: one-shot `run` on a generated one-message config (metadata in and out, deleted = no output); no `blobl server`. Parity (Done when 2, R11) compares the panel with the recorded run of that pipeline, and parse errors with `blobl`, because `run` and `blobl` differ on multi-line input, `deleted()` and invalid input.
- Decision (user, 2026-10-14, 4.8 planning): the no-binary state (R7) is split out of entry 8 into a new entry 15, "No-binary state in the test panel", built after 8 and before 9 (entry 9 now waits on 15; the refactor sweep, 13, waits on it too). Entry 8 now covers R6 and R13.
- Note: the open question on metadata in and out is answered by AD-21 (spike 4.1); the `blobl server` unknown is answered (it exists on v4.100.0 but is not used).
