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

- E2 (R1) → CAP-2: Supply the schema store's schema to Red Hat YAML for detected files only, as content under our own URI scheme (AD-10, AD-11); completion and hover follow schema changes (new binary, Refresh Schema) without reopening.
- E2 (R2) → CAP-6 (part): One DetectionRegistry decides which files are Redpanda Connect configs: `redpandaConnect.filePatterns`, or top-level `input`/`pipeline`/`output`/`buffer`/resource keys, excluding templates; recomputed on open, change and setting change; `onDidChangeDetection`; a session-mark hook for epic 3's Show graph (AD-18).
- E2 (R3) → CAP-3: On save, lint the saved detected file through the AD-9 builder and spawn site; parse `<path>(<line>,<col>) <message>`; show each finding on its whole line (lint reports column 1); `field … is deprecated` as Warning, everything else as Error; clear the file's lint diagnostics on its first edit after save (AD-12, AD-17 rule).
- E2 (R4) → CAP-3: Suppress a lint diagnostic on a line that already has a Red Hat diagnostic (AD-12).
- E2 (R5) → CAP-3: One Quick Fix type: for "field X not recognised", offer the closest valid field names from the schema at that position, applied as a minimal-range edit (AD-19).
- E2 (R6) → CAP-4: Bloblang highlighting in `mapping`, `check` and `${! }` via a TextMate grammar injected into YAML (AD-14).
- E2 (R7) → CAP-5: Snippets that scaffold pipeline sections and common components.
- E2 (R8) → CAP-11: Run auto-saves, then runs the file through the builder in a per-file Pseudoterminal (logs streamed); Stop sends SIGINT and escalates to SIGKILL after a grace period; untitled files cannot Run; the Run and Stop commands become visible (AD-13).
- E2 (R9) → CAP-1 (part): After Set path / Retry / Refresh Schema, editor features update without reopening; Refresh Schema with no usable binary logs a line and shows the binary warning again.
- E2 (R10) → CAP-14 (part): The corpus harness asserts the extension's parsed lint diagnostics equal `rpk connect lint` for every corpus config (diagnostics parity).
- E2 (R11) → spec Constraints (`engines.vscode ^1.100.0`): CI also runs the VS Code test suite against VS Code 1.100.

## Done when

1. In a detected config (no naming convention) the native editor offers completion and hover from the user's binary's schema via Red Hat YAML; after Set path these appear without reopening the file.
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
- Open question: lint findings always report column 1 (spike Q2), so diagnostics must map to the whole line; decide the range rule at inception (_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md, Q2). **Answered (2.4):** each finding is a whole-line diagnostic, clamped to the last line.
- Open question: lint does not check resource references; a missing resource fails only at `run` (spike Q2). Decide whether diagnostics parity treats this as expected or adds a run-time check. **Answered (user, 2026-10-06):** expected; parity measures lint output only (Decision below).
- Open question: templates (top-level `name` + `type` + `mapping`) fail `lint`; detection (AD-18) should exclude them (_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md, Q2). **Answered (2.2):** a template is not detected unless a `filePatterns` entry matches it.
- Open question: Stop sends SIGINT (exit 0 in the spike); add a SIGKILL escalation after a grace period, since a hanging shutdown was not tested (_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md, Q6). **Answered (2.3, 2.7):** Stop sends SIGINT, then SIGKILL after 10 s; a second Stop kills at once.
- Open question: the 1.5 builder returns `env` (inherited + `NO_COLOR=1`), but the spawn site (`process.ts`) builds its own env and takes none; wire the builder's env through for lint and Run. **Answered (2.3):** `runProcess` and `runStreaming` take the caller's `env` and `cwd`, with `NO_COLOR=1` forced; lint (2.4) and Run (2.7) pass the builder's env.
- Resolved (manual check, user 2026-10-06): with the 1.6 cached schema wired in by hand (`yaml.schemas`, redhat.vscode-yaml 1.24.0, VS Code 1.103.2), completion and hover with the merged docs work next to the `anyOf` rewrite and `$ref`.
- Note: the Run and Stop commands are contributed but hidden with no handler since 1.2; this epic enables them.
- Note: Run already passes `--set http.enabled=false` (1.5) to avoid port 4195 collisions between per-file runs.
- Source: out-of-scope list in _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/story-refactor-sweep-plan.md, Implementation Notes (user decision 2026-10-06).
- Open question (found in manual check of E1, 2026-10-06): the binary's `list --format jsonschema` barely validates at component level. Component choice (`input`, `processor`, …) is an `anyOf` whose branches are `{properties: {<name>: …}, type: object}` with no `required` and no `additionalProperties: false`, so every object matches a branch and the 978 deeper `additionalProperties: false` never apply. Checked with ajv against the 1.6 transformed schema for 4.112.0: an unknown field (`nope` in a `mapping` processor), a top-level typo (`inptu`) and a wrong type (`count: 'x'` in `generate`) all validate. Completion and hover still draw on the schema. This contradicts AD-12's assumption that Red Hat schema validation is the primary live diagnostic source. Decide at inception: (a) extend the 1.6 transform (e.g. `required: [<name>]` per component branch) so component-level checks apply, verified against the corpus for no false positives; or (b) accept lint-on-save as the real validation and amend AD-12. **Answered (user, 2026-10-06):** (b); AD-12 amended (Decision below).
- Decision: lint on save is the authoritative Redpanda Connect validation; Red Hat provides completion, hover and YAML syntax errors; AD-12 amended (user, 2026-10-06).
- Decision: the schema reaches Red Hat as content via `registerContributor` under our own URI scheme, served from the in-memory store; this removes the 30-day-cleanup risk (retro F4); AD-11 amended (user, 2026-10-06).
- Decision: one Quick Fix type in E2 — "field X not recognised" → closest valid field names (user, 2026-10-06).
- Decision: Refresh Schema with no usable binary logs a line and shows the binary warning again (user, 2026-10-06; retro A1).
- Decision: a CI job runs the VS Code test suite against VS Code 1.100 in this epic (user, 2026-10-06; retro A4).
- Decision: tracer bullet is 2.1 — detection + schema-as-content to Red Hat, completion and hover in a detected file (2026-10-06).
- Decision: 2.3 defines the spawn-site contract (caller env + streaming child) early so lint (2.4) and Run (2.7) build on it (2026-10-06).
- Decision: lint not checking resource references is expected; diagnostics parity measures lint output only, no run-time check (user, 2026-10-06).
- Decision: no separate spike for locating schema nodes; 2.5 settles it as its own uncertainty (user, 2026-10-06).
- Collision: 2.4, 2.7 and 2.8 all edit the composition root (src/extension.ts); 2.7, 2.9 and 2.10 edit package.json contributions — ordered through `after`.
- Decision: no automatic resource-file detection; lint and Run pass exactly the `redpandaConnect.resourceFiles` setting (globs allowed), so results never depend on which files exist nearby or are open; AD-9 and AD-18 amended (user, 2026-10-07, ticket 2.2).
- Note (2.2 review, 2026-10-07): the 1.5 argument builder still takes `detectedResourceFiles` (`src/adapters/redpandaConnect/args.ts:57`, `src/core/args.ts:22` "then detected ones"); after the resource-file decision nothing supplies it. Drop the input and its tests in the first ticket that calls the builder (2.3 or 2.4). **Done (2.3).**
- Decision: lint's YAML syntax findings (`yaml: line N`, N often the enclosing block's first line) are hidden while Red Hat reports a syntax error; Red Hat owns syntax errors (user, 2026-10-07, 2.4 review).
- Decision (2.5 review, user 2026-10-07): the unknown-field Quick Fix offers only shared fields when a component is already present, uses an edit limit of `min(3, max(1, ⌊len/3⌋))`, marks a fix preferred only for a clear winner, and also fixes flow-mapping keys. Fields inside name-keyed maps (`workflow.branches.<name>`, `dynamic.inputs.<name>`) get no fix (known limit).
- Decision (2.7 review, user 2026-10-07): a run the user stopped shows "Pipeline stopped" whatever its exit code; a Stop during a re-run's wait cancels the restart; the editor-title Run follows each editor's own file (`resourcePath in redpandaConnect.detectedPaths`). Stop grace 10 s, second Stop kills (checkpoint default).
- Decision (user, 2026-10-07): new ticket 13 "Schema completion fixes" after the 2.7 manual check: drop `required` from the served schema (completion under an incomplete component) and offer json-full `options` / `annotated_options` as non-strict value suggestions.
- Open question (2.7 manual check, 2026-10-07): an empty component block (`generate:`, `file:` or `stdout:` with nothing under it yet) gets no schema completions from Red Hat 1.24.0, even with `required` dropped and objects allowed to be null, while a plain object (`logger:`) does. Each component branch requiring its own name did not help either. Next: reproduce with a minimal `$ref` → `allOf` → `anyOf` schema; if Red Hat cannot do it, consider our own completion or snippets for component blocks (2.10). **Answered (user, 2026-10-07):** ticket 16 (Decision below).
- Decision (user, 2026-10-07): a second Quick Fix type, ticket 14: `value X is not a valid option for this field` → closest valid options. This extends the earlier "one Quick Fix type" decision. Closed option lists are enforced by lint on save (198 of 216 option fields in 4.112.0 carry a lint rule, case-insensitive); strict schema enums are not added, because Red Hat barely validates values inside components.
- Decision (user, 2026-10-07): AD-11 amended; ticket 16 adds our own completion only where Red Hat 1.24.0 returns none (empty component block, empty value inside a component). This answers the empty-block open question above. An upstream issue in redhat-developer/yaml-language-server remains optional.
- Note (2.16 review, 2026-10-07): Red Hat 1.24.0 and our gap provider both give nothing for an empty list item inside a component (`kafka_franz.batching.processors: - `, `tls.client_certs: - `). Candidate follow-up. **Answered (user, 2026-10-08):** ticket 18; AD-11 amended to include list items.
- Decision (user, 2026-10-08, E2 retrospective F2/A2): ticket 22 adds a "Fix all" code action that applies every clear-winner lint fix as one edit, extending the Quick Fix decisions above. The first-edit clear rule (R3, AD-17) stays; keeping findings on lines an edit did not touch is backlog story 10.
