# Pipeline Designer for Redpanda Connect

A VS Code extension for [Redpanda Connect](https://docs.redpanda.com/redpanda-connect/) configs: a read-only pipeline graph beside the YAML editor, Redpanda Connect-aware YAML editing, and local runs.

> **Status: early proof of concept (0.0.1).** This build only checks that a Redpanda Connect binary is available: opening a YAML file writes the binary's version to the **Redpanda Connect** output channel. The graph, lint, schema and run features arrive in later releases.

## Requirements

- VS Code 1.100 or newer.
- [YAML by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) (`redhat.vscode-yaml`). VS Code installs it automatically with this extension.
- Redpanda Connect v4.100.0 or newer: `rpk` on `PATH` with `rpk connect install` run, or a `redpanda-connect` binary on `PATH`; otherwise its location in `redpandaConnect.binaryPath`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `redpandaConnect.binaryPath` | `""` | Fallback path to the `redpanda-connect` or `rpk` binary. `PATH` is tried first (`rpk connect`, then `redpanda-connect`); this setting is used only when neither is usable. `~` expands to the home directory, a relative path resolves against the first workspace folder, and a bare name is looked up on `PATH`. |
| `redpandaConnect.autoOpenGraph` | `true` | Open the graph beside a detected config (not used yet). |
| `redpandaConnect.filePatterns` | `[]` | Globs always treated as Redpanda Connect configs (not used yet). |
| `redpandaConnect.resourceFiles` | `[]` | Resource files passed to lint and run (not used yet). |
| `redpandaConnect.envFile` | `""` | Environment file passed to lint and run (not used yet). |

## Development

```sh
npm ci
npm run compile          # type-check, lint, bundle to dist/
npm test                 # unit + integration tests in a downloaded VS Code
npx vsce package --no-dependencies
```

Press F5 in VS Code to start an Extension Development Host.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
