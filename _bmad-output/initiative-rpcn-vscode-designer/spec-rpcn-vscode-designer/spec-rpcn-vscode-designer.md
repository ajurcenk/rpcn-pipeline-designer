---
id: SPEC-rpcn-vscode-designer
companions:
  - ../ux-rpcn-vscode-designer/DESIGN.md
  - ../ux-rpcn-vscode-designer/EXPERIENCE.md
  - ../architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - research-and-cli-reference.md
sources:
  - ../brief-rpcn-vscode-designer/brief-rpcn-vscode-designer.md
  - ../brief-rpcn-vscode-designer/addendum.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Redpanda Connect Designer for VS Code (POC)

## Why

Vision plus pain. Developers write Redpanda Connect pipeline YAML by hand, bounce to the docs for component fields, find mistakes only at `lint` or run time, and struggle to see the structure of long configs with brokers, `switch` and `branch`. No VS Code extension understands the config schema or shows a pipeline visually; the only visual editor (Redpanda Cloud's Visual tab, preview since August 2026) is browser- and Cloud-bound, and Benthos Studio is gone. This open-source POC improves the developer experience of building pipelines locally: a smarter, not just faster, YAML editor driven by the developer's own binary, a read-only graph beside it, and a local run loop. Primary user: Connect developers who build locally and later deploy to Redpanda Cloud BYOC. It is the foundation for later testing, AI assistance, BYOC deploy, metrics and debugging (see `research-and-cli-reference.md`).

## Capabilities

- **CAP-1 — Binary detection & onboarding**
  - **intent:** The extension finds the developer's `rpk connect` or `redpanda-connect` binary on PATH (or, as a fallback, a configured path) and guides them to install or point to one when it is missing, invalid or older than v4.100.0.
  - **success:** Resolution follows AD-9 order; with no valid binary a notification and the graph empty state both offer Install guide / Set path (EXPERIENCE Voice and Tone strings); after Set path, schema, graph and diagnostics appear without reopening the file (EXPERIENCE Flow 2).

- **CAP-2 — Schema-aware YAML editing**
  - **intent:** Developers get validation, completion and hover docs that match the components their own binary can run, in VS Code's native editor.
  - **success:** Schema is generated from the binary and cached per path + version, refreshed on version change or Refresh schema (AD-10); schema errors appear live while typing; completion offers only keys/values valid at the cursor; hover shows field docs plus an example (AD-11).

- **CAP-3 — Lint diagnostics on save + Quick Fixes**
  - **intent:** Developers see `rpk connect lint` findings inline and can apply fixes for common errors without leaving the editor.
  - **success:** On save, lint findings appear as diagnostics, a lint finding on the same line as a schema diagnostic is not shown twice, and lint diagnostics clear on the first edit after save (AD-12, AD-17); a misspelled field offers a Quick Fix to the nearest valid field ("Change to `topic`") whose edit touches only that range (AD-19).

- **CAP-4 — Bloblang highlighting**
  - **intent:** Bloblang in `mapping`, `check` and `${! }` interpolations reads as Bloblang inside YAML.
  - **success:** Those regions are highlighted with Bloblang scopes in YAML files; no Bloblang completion or diagnostics are provided (AD-14).

- **CAP-5 — Snippets**
  - **intent:** Developers can scaffold pipeline sections and common components without recalling exact structure.
  - **success:** A newcomer can insert input/pipeline/output and component snippets from completion and reach a valid skeleton (EXPERIENCE Flow 3 steps 2–5).

- **CAP-6 — File detection & graph auto-open**
  - **intent:** Redpanda Connect configs are recognized without a naming convention, and their graph opens beside them by default.
  - **success:** A file is detected by top-level `input` / `pipeline` / `output` / `buffer` / resource keys, by `filePatterns`, or by running Show graph (AD-18); on first open per session the graph panel opens beside it and focus returns to the YAML; a setting disables auto-open; non-config YAML gets no schema, lint or graph.

- **CAP-7 — Read-only pipeline graph**
  - **intent:** Developers see a pipeline's structure — input → processors → output, nested routing and resources — at a glance.
  - **success:** The graph draws every component; `switch`, `branch`, `workflow`, `try`/`catch` and brokers render as collapsible groups that start expanded; resources render as standalone nodes; structure derives from the binary's schema (AD-20); no node can be dragged or edited; nodes and groups are keyboard- and screen-reader-operable (EXPERIENCE Accessibility Floor); visuals follow DESIGN.md tokens.

- **CAP-8 — Graph ↔ YAML two-way navigation**
  - **intent:** Developers move between a node and its YAML in either direction.
  - **success:** Clicking (or Enter on) a node reveals, centers and selects its YAML range in the driving editor; moving the YAML cursor highlights the innermost node containing it without moving focus; navigation never edits text (AD-8, AD-16).

- **CAP-9 — Live graph with last-valid state**
  - **intent:** The graph tracks the YAML as the developer types and never blanks while the YAML is mid-edit.
  - **success:** The graph re-renders on every keystroke with unchanged nodes keeping position; while YAML is unparseable the last valid graph stays with the banner "YAML has errors — showing last valid graph." and node markers frozen; the banner clears on the next successful parse (AD-6, EXPERIENCE Graph ↔ YAML Sync).

- **CAP-10 — Node error and warning markers**
  - **intent:** Developers see which nodes have problems directly on the graph.
  - **success:** A node whose range holds an error shows error border + icon, a warning shows warning border + distinct icon, error wins, severity rolls up to collapsed group headers, hover shows the message verbatim; warnings come only from Red Hat warning diagnostics and `lint --deprecated`, all other lint findings are errors (AD-17).

- **CAP-11 — Local Run with logs and Stop**
  - **intent:** Developers run the current pipeline with their local binary and stop it from the editor.
  - **success:** Run auto-saves a dirty file then runs it; logs stream in one reused terminal per file named "Redpanda Connect: {filename}"; Stop interrupts that file's process and the exit status shows in the status bar; Run is disabled for untitled files with "Save the file to run it." (AD-13).

- **CAP-12 — Show / Hide graph with persisted hide**
  - **intent:** Developers control whether a file's graph is shown, and an explicit choice to hide it sticks.
  - **success:** An editor-title toggle and Command Palette commands Show graph / Hide graph work for detected files with no default keybinding; an explicit Hide persists per file across window reloads and suppresses auto-open until Show graph; closing the YAML tab closes its graph (AD-1).

- **CAP-13 — Packaging and distribution**
  - **intent:** Developers can install a packaged build of the extension in VS Code.
  - **success:** CI on every push builds one `.vsix` (`ajurcenk.rpcn-pipeline-designer`, Apache-2.0) that installs in VS Code and pulls in `redhat.vscode-yaml` as a dependency (architecture Operational envelope).

- **CAP-14 — Reference corpus and parity verification**
  - **intent:** Graph accuracy and diagnostics parity are measured, not asserted, against real configs.
  - **success:** A corpus of real configs (including Redpanda Connect cookbook examples and community configs) exists early; automated tests against the minimum supported binary (v4.100.0) and a pinned current one (v4.112.0) in CI check every corpus config for graph accuracy and for editor diagnostics matching `rpk connect lint` output.

## Constraints

- The user's local binary is required: schema, lint, graph structure and Run all come from it; no bundled schema and no built-in structural table (AD-9, AD-20).
- `redhat.vscode-yaml` is a hard dependency; no YAML language server of our own (AD-11).
- The graph is read-only; the extension never rewrites the file except developer-chosen, minimal-range Quick Fixes, and never re-serializes it, so comments, `${ENV}` and formatting survive (AD-19).
- VS Code's native text editor owns all text; the graph is a panel beside it; no Monaco or editor inside the webview (AD-1).
- Visuals inherit the active VS Code theme only (light, dark, high-contrast); no brand accent, per-type colors or Redpanda branding (DESIGN.md).
- `engines.vscode ^1.100.0`, stable APIs only.
- Open source under Apache-2.0, published as `ajurcenk.rpcn-pipeline-designer` with display name "Pipeline Designer for Redpanda Connect"; name and publisher must not imply official Redpanda branding.
- Minimum supported Redpanda Connect version is v4.100.0.
- Delivered as a CI-built `.vsix` installed by hand; nothing is published to a registry in the POC.
- Scope unit is single-file configs plus resource files.
- POC stakes: sized for typical configs, SemVer 0.x.

## Non-goals

- BYOC or Cloud deployment.
- Any editing from the graph: add, remove, reorder, configure, schema-generated property forms; visual editing of nested structures.
- Streams mode (multiple pipelines).
- Bundled schema for use without a binary.
- Unit testing, AI assistance, metrics, debugging and profiling (including groundwork such as per-processor run output), data-flow visualization, log-error node highlighting.
- Large configs (thousands of lines).
- Lint while typing.
- Bloblang LSP, completion or diagnostics.
- A default keybinding for Show / Hide graph.
- Publishing to the VS Code Marketplace or Open VSX (publisher accounts, tokens, release workflow) — parked for the POC.
- Restoring the graph panel after a window reload.
- Telemetry and i18n.

## Success signal

- For 100% of the reference corpus, the graph shows every component, every route (`switch` cases, brokers) and every nested group correctly, and clicking any node lands on the right YAML.
- For every corpus config, errors shown in the editor match `rpk connect lint` output.
- A newcomer with the binary installed goes from an empty file to a running pipeline in under 10 minutes (EXPERIENCE Flow 3).

## Assumptions

- Newcomers and reviewers/maintainers are secondary users.
- Lint always passes `--skip-env-var-check`; env vars resolve only at run.
- Resource references from processors are not drawn as edges.
- Graph keyboard model follows EXPERIENCE Interaction Primitives.
- SemVer 0.x in `package.json`; `redpandaConnect.*` IDs are provisional until a name is chosen.
- Extension name `rpcn-pipeline-designer` (ID `ajurcenk.rpcn-pipeline-designer`) is provisional; display name is decided.

## Open Questions

- Does the standalone `redpanda-connect` binary match `rpk connect` subcommands and flags? Verify in the first spike.
- Do the real `lint` stderr format and `list --format jsonschema` output match the recorded facts? Verify in the first spike.
