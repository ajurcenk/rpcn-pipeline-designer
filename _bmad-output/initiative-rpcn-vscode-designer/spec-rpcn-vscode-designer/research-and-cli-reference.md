# Research and CLI Reference

Load-bearing facts from the brief addendum (landscape research 2026-10-02) and architecture research. Items marked *Unverified* must be checked before relying on them.

## CLI facts (docs 26.2, Connect v4.112.0)

| Command | Facts |
|---|---|
| `rpk connect list --format jsonschema` | Full config schema with `definitions`/`$ref`, no `$schema` keyword, custom `is_*` keys. `jsonschema` format exists in source but is undocumented. `bloblang-functions` / `bloblang-methods` args output Bloblang metadata. |
| `rpk connect lint [paths]` | Flags `-r` (resources), `-e` (env file), `--skip-env-var-check`, `--deprecated`. **No machine-readable output**: stderr lines `<path>(<line>,<col>) <message>`, ANSI color unless `NO_COLOR=1`, exit 1 when lints found, lines carry no severity. Stdin support unverified. |
| `rpk connect run` | Flags `-r`, `-e`, `-s/--set`, `--log.level`, `-w` (watch). |
| `rpk connect test [paths]` | Later testing phase. |
| `rpk connect blobl server` | Local Bloblang playground, marked EXPERIMENTAL (`--no-open`, `--port`, `--mapping-file`, `--input-file`, `--write`). `POST /execute` with `{"mapping", "input"}` returns `{"parse_error", "mapping_error", "result"}`; a parse error carries line, column and a caret excerpt, a mapping error names the mapping line and field. Gaps (v4.112.0): input `metadata` ignored, no output metadata, `deleted()` gives an empty `result` with no flag. |
| `rpk connect blobl` | Applies a mapping (argument or `-f`) to JSON lines from stdin or `-i`, one result per line; errors `failed to parse mapping: …` / `failed to execute map: …`; no metadata. |
| `rpk connect mcp-server` | Experimental, `init` and `lint` subcommands; candidate for AI-assist phase. `rpk cloud mcp` (beta) also exists. |

*Unverified:* standalone `redpanda-connect` has identical subcommands and flags.

## Docs Bloblang playground

The docs-site playground (docs-ui repo, `blobl-editor/wasm/main.go`) is a Go Wasm build of the Connect libraries pinned in its `go.mod` (connect v4.111.1 when checked, 2026-10-12). It takes a mapping, an input and optional metadata, and returns the output, its metadata, or an error; some functions are mocked for the browser (timezone conversion, strftime). Not used by the extension (CAP-15–17 run on the developer's binary); its input / metadata / output / error shape is the model for the test panel.

## Landscape

- **Existing VS Code extensions cover Bloblang only**; none uses the config schema or offers a graph.
  - `teyfix.vscode-bloblang` v0.2.1 (Marketplace only) on `teyfix/bloblang-lsp` (MIT, Go, young): highlighting, diagnostics, formatting, completion, hover, definitions in `.blobl` and YAML keys. Candidate for a later Bloblang LSP integration.
  - `hsctech-dev.blobl-lsp-vscode` v0.5.0 (Marketplace + Open VSX), targets Bento/Warpstream, no license — not embeddable.
  - `GeorgesHaidar.vsc-benthos` v0.1.5, highlighting only, abandoned since 2023.
- **Benthos Studio** (hosted visual builder) is discontinued; CLI still contains `studio` code. *Unverified:* sunset date.
- **Redpanda Cloud:** April 2026 pipeline editor with diagram + IDE-like YAML; August 2026 Visual tab (preview, "Studio revival") with node editing synced to YAML incl. `switch`, `branch`, `try`/`catch`; Bloblang V2 autocomplete + playground. *Unverified:* which tiers have the Visual tab.
- **Comparables:** Kestra (form + YAML + topology view synced and schema-validated, plus VS Code extension) is the closest model. Datadog Observability Pipelines is UI-first with import/export. Conduit removed its UI in v0.13.0.

## Positioning

- Differentiators: local-first and git-native (no Cloud account), schema and lint match the user's runtime (version, edition, custom plugins), lives in the developer's editor, open source, first VS Code extension that understands the Connect config schema.
- Versus Cloud Visual tab: Cloud configures deployed pipelines; this targets developer workflow — git review, fast editing, and later profiling and step-by-step debugging, then BYOC deploy from the same editor.
- Risk: an official Redpanda IDE extension would shift this project to the community alternative; speed of delivery and editing/graph quality are the advantage.

## Notes carried for planning

- Build the reference corpus (cookbook examples + community configs) as one of the first deliverables (CAP-14).
- Debugging/profiling groundwork (e.g. per-processor output in a run panel) is explicitly out of the first release (owner decision); the Cloud differentiation rests on later phases.
- "BYOC Cloud lacks profiling and step-by-step debugging" is the product owner's position, not independently verified; re-check before external sharing.
- Keep the deployment target separate in the data model so BYOC deploy can be added later.
- Who maintains and contributes to the project, and at what pace, is open.

## Vision (later phases)

Author (graph editing later) → Test (Bloblang check and test in the second release, then `rpk connect test`) → Assist (AI generate/explain/fix, possibly via `rpk connect mcp-server`) → Deploy (BYOC) → Observe (metrics, step-through debugging).
