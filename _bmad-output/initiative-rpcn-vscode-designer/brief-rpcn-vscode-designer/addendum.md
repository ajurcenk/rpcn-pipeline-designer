# Addendum: Redpanda Connect Designer for VS Code

Detail that doesn't belong in the brief, kept for the PRD and architecture work.

## Landscape research (2026-10-02)

**Existing extensions.** All of them cover Bloblang only. None uses the config schema or has a visual view.
- `teyfix.vscode-bloblang` v0.2.1, VS Code Marketplace only, built on `teyfix/bloblang-lsp`. It offers highlighting, diagnostics, formatting, completion, hover and definitions, both in `.blobl` files and inside YAML keys. https://github.com/teyfix/vscode-bloblang
- `hsctech-dev.blobl-lsp-vscode` v0.5.0, on both VS Code Marketplace and Open VSX. It targets Bento and Warpstream. https://codeberg.org/hsctech/blobl_lsp_vscode
- `GeorgesHaidar.vsc-benthos` v0.1.5, highlighting only, abandoned since 2023. https://github.com/benthosdev/vscode-benthos

**Benthos Studio.** A hosted visual config builder, now discontinued; its domain now serves an unrelated site. The CLI still contains `studio` code. https://www.redpanda.com/blog/redpanda-connect-pipeline-builder
- *Unverified:* the exact sunset date.

**Redpanda Cloud.** Source: https://docs.redpanda.com/cloud-data-platform/get-started/whats-new-cloud/
- April 2026: a new pipeline editor with a diagram and an IDE-like YAML editor.
- August 2026: a Visual tab (preview) for node-diagram editing kept in sync with the YAML, including `switch`, `branch` and `try`/`catch`. Redpanda calls it a "Studio revival".
- Bloblang V2 comes with autocomplete and a playground (date not stated).
- *Unverified:* which tiers (Serverless, BYOC, Dedicated) have the Visual tab.
- *Unverified:* that Cloud lacks profiling and step-by-step debugging (see Notes for the PRD).

**MCP.** Two MCP servers exist: `rpk connect mcp-server` (experimental, with `init` and `lint` subcommands) and `rpk cloud mcp` (beta). Both are relevant to the later AI-assist phase.

**Comparable products.**
- Kestra: a form editor, YAML editor and topology view kept in sync and validated against a schema, plus a VS Code extension. This is the closest model for this extension. https://kestra.io/docs/no-code/no-code-flow-building
- Datadog Observability Pipelines: UI-first, with import and export.
- Conduit: removed its UI in v0.13.0.

## CLI reference for integration

Docs version 26.2; Connect v4.112.0.
- `rpk connect list --format jsonschema` outputs the full config schema. The `jsonschema` format is supported in the source but not listed in the docs table. Passing `bloblang-functions` or `bloblang-methods` as an argument outputs Bloblang metadata instead.
- `rpk connect lint [paths]`: flags `-r` (resources), `-e` (env file), `--skip-env-var-check`, `--deprecated`. Exits with code 1 on errors. **Has no JSON output**, so diagnostics must be parsed from text, which is a technical risk.
- `rpk connect run`: flags `-r`, `-e`, `-s/--set`, `--log.level`, and `-w` for watch mode.
- `rpk connect test [paths]`: for the later testing phase.
- `rpk connect blobl server`: a local Bloblang playground (marked EXPERIMENTAL; `--no-open`, `--port`, `--mapping-file`, `--input-file`, `--write`).
- **Bloblang execution, checked 2026-10-12 on v4.112.0** (for the second release):
  - `blobl server` serves `POST /execute` with `{"mapping", "input"}` and answers `{"parse_error", "mapping_error", "result"}`. A parse error carries line, column and a caret excerpt; a mapping error names the line and the field (`` failed assignment (line 1): expected number value, got null from field `this.nope` ``).
  - It has gaps: input `metadata` is ignored (`@key` reads null), output metadata is not returned, and `root = deleted()` returns an empty `result` with no flag.
  - `blobl` (no subcommand) applies a mapping (argument or `-f`) to JSON lines from stdin or `-i`, prints one result per line, and reports `failed to parse mapping: …` or `failed to execute map: …`. It has no metadata support either.
  - Options for metadata: run a one-message pipeline through `run` (an input that sets the sample's content and metadata, the mapping under test, and a final mapping that writes `{"content", "meta"}` to stdout), or contribute metadata support to `blobl server` upstream.
- **The docs playground** (source in the docs-ui repo, `blobl-editor/wasm/main.go`) is a Go Wasm module built from the Connect libraries, pinned in its `go.mod` (connect v4.111.1 at the time of writing). It takes a mapping, an input and optional metadata, and returns the output, its metadata, or an error. Some functions are replaced by mock or simplified versions for the browser (for example timezone conversion and strftime formatting). It is not used by this extension (decision 2026-10-12: the developer's binary only), but its input / metadata / output / error shape is the model for the test panel.
- *Unverified:* that the standalone `redpanda-connect` binary has identical subcommands.

## Technical notes for architecture

- Use a VS Code `CustomTextEditorProvider` so the text document stays the source of truth, and undo/redo and git keep working unchanged.
- The graph is read-only in the first release, so the extension edits YAML only through Quick Fixes. Apply them as minimal text edits, or through a parser that keeps the document structure (e.g. the `yaml` package's Document API), never by re-serializing the whole file. This matters again once editing from the graph arrives.
- Open decision: build edit mode on the Red Hat YAML extension's schema support, or on our own LSP.
- Graph rendering: React Flow or similar inside a webview.
- Keep the deployment target separate in the data model, so BYOC deployment can be added later.

## Future roadmap parked from the first release

Testing, AI assistance, BYOC deployment, metrics tracking, debugging, visual editing of nested structures, streams mode, and a bundled schema fallback.

## Notes for the PRD

- **Build the reference corpus early.** Graph accuracy and diagnostics parity are both measured against a corpus of real configs, such as the cookbook examples and community configs. It should be one of the first deliverables.
- **Debugging and profiling groundwork: not in the first release** (owner decision, 2026-10-05). The case against the Cloud Visual tab rests on profiling and step-by-step debugging in later phases; Run stays logs plus Stop for now.
- **Verify the Cloud gap claim.** "BYOC Cloud does not support profiling or step-by-step debugging today" is the product owner's stated position and has not been independently checked. Re-check Cloud's current features before the brief is shared externally.
