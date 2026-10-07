# Pipeline Designer for Redpanda Connect

A VS Code extension for [Redpanda Connect](https://docs.redpanda.com/redpanda-connect/) configs: a read-only pipeline graph beside the YAML editor, Redpanda Connect-aware YAML editing, and local runs.

> **Status: early proof of concept (0.0.1).** This build finds the Redpanda Connect binary, warns when none is usable, and generates and caches the config schema from it; details go to the **Redpanda Connect** output channel. The graph, lint, schema-backed editing and run features arrive in later releases.

## Finding the binary

When the extension activates (the first time a YAML file opens), it looks for Redpanda Connect in this order:

1. `rpk` on `PATH`, run as `rpk connect` (needs `rpk connect install`).
2. `redpanda-connect` on `PATH`.
3. `redpandaConnect.binaryPath`, used only when `PATH` gives no usable binary. A value naming `rpk` runs as `rpk connect`.

A binary older than v4.100.0, or one whose version check fails, is not used. The binary is looked up again when `redpandaConnect.binaryPath` changes and on **Redpanda Connect: Refresh Schema**.

If no usable binary is found, a warning appears once (and again only after the state changes) with three actions:

- **Install guide** opens the [Redpanda Connect install docs](https://docs.redpanda.com/connect/install/).
- **Set path** picks a binary and saves it to the user setting `redpandaConnect.binaryPath`.
- **Retry** looks for the binary again.

## Schema

For the resolved binary, the extension runs `list --format jsonschema` and merges in the field descriptions, examples and defaults from `list --format json-full`. The result is cached in the extension's global storage as `schema-<hash>.json`, whose name changes with the binary path, its version and the transform version. Later activations still run `--version` to find the binary, but on a cache hit they skip both `list` runs. After a successful write (never on a cache hit), other `schema-<16 hex>.json` files unused for more than 30 days are removed.

**Redpanda Connect: Refresh Schema** looks for the binary again and regenerates the schema, even when a cached copy exists. The schema is served to YAML by Red Hat for detected configs only (completion and hover).

## Which files are Redpanda Connect configs

An open YAML file is treated as a Redpanda Connect config when one of its YAML documents has a top-level `input`, `pipeline`, `output`, `buffer` or `*_resources` key (`cache_resources`, `rate_limit_resources`, `processor_resources`, `input_resources`, `output_resources`). Templates (a document with top-level `name`, `type` and `mapping`) are not. A file matching a `redpandaConnect.filePatterns` glob is always treated as a config, templates included. Detection follows edits and setting changes; there is no need to reopen the file. Resource files are not found automatically: lint and run pass exactly the files in `redpandaConnect.resourceFiles`.

## Requirements

- VS Code 1.100 or newer.
- [YAML by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) (`redhat.vscode-yaml`). VS Code installs it automatically with this extension.
- Redpanda Connect v4.100.0 or newer: `rpk` on `PATH` with `rpk connect install` run, or a `redpanda-connect` binary on `PATH`; otherwise its location in `redpandaConnect.binaryPath`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `redpandaConnect.binaryPath` | `""` | Fallback path to the `redpanda-connect` or `rpk` binary. `PATH` is tried first (`rpk connect`, then `redpanda-connect`); this setting is used only when neither is usable. `~` expands to the home directory, a relative path resolves against the first workspace folder, and a bare name is looked up on `PATH`. |
| `redpandaConnect.autoOpenGraph` | `true` | Open the graph beside a detected config (not used yet). |
| `redpandaConnect.filePatterns` | `[]` | Globs always treated as Redpanda Connect configs, matched relative to the file's workspace folder or against its absolute path: `*.rpcn.yaml` matches only at a folder root, `**/*.rpcn.yaml` anywhere. |
| `redpandaConnect.resourceFiles` | `[]` | Resource files passed to lint and run (not used yet). |
| `redpandaConnect.envFile` | `""` | Environment file passed to lint and run (not used yet). |

## Development

```sh
npm ci
npm run compile          # type-check, lint, bundle to dist/
npm test                 # unit + integration tests in a downloaded VS Code
scripts/spike/fetch-binaries.sh   # pinned Redpanda Connect 4.100.0 and 4.112.0 into .cache/ (needs an authenticated gh)
npm run test:corpus      # lint every test/corpus/*.yaml with both binaries and compare with the recorded output
npx vsce package --no-dependencies
```

Press F5 in VS Code to start an Extension Development Host.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
