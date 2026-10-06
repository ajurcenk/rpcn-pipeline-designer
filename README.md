# Pipeline Designer for Redpanda Connect

A VS Code extension for [Redpanda Connect](https://docs.redpanda.com/redpanda-connect/) configs: a read-only pipeline graph beside the YAML editor, Redpanda Connect-aware YAML editing, and local runs.

> **Status: early proof of concept (0.0.1).** This build only checks that a Redpanda Connect binary is available: opening a YAML file writes the binary's version to the **Redpanda Connect** output channel. The graph, lint, schema and run features arrive in later releases.

## Requirements

- VS Code 1.100 or newer.
- [YAML by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) (`redhat.vscode-yaml`). VS Code installs it automatically with this extension.
- A local `redpanda-connect` binary on `PATH`, or its location in `redpandaConnect.binaryPath`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `redpandaConnect.binaryPath` | `""` | Path to the `redpanda-connect` binary. When empty, `redpanda-connect` is looked up on `PATH`. |
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
