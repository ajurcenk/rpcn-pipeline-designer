# Change Log

All notable changes to the "rpcn-pipeline-designer" extension are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

- Binary resolution: `rpk connect` on `PATH`, then `redpanda-connect` on `PATH`, then `redpandaConnect.binaryPath` as a fallback; binaries older than v4.100.0 are rejected. The binary is resolved again when the setting changes.
- A warning with **Install guide**, **Set path** and **Retry** appears when no usable binary is found, once per change of state.
- Shared argument builder for lint and run (`--resources` from `redpandaConnect.resourceFiles`, `--env-file` from `redpandaConnect.envFile`, `NO_COLOR=1`); not used by any command yet.
- The config schema is generated from the binary (`list --format jsonschema`, with docs from `list --format json-full`), cached per binary path and version, and regenerated with **Redpanda Connect: Refresh Schema**.
- Detected Redpanda Connect configs get completion and hover from the binary's schema through YAML by Red Hat.
- Detection: top-level Redpanda Connect keys per YAML document, templates excluded, `redpandaConnect.filePatterns` always wins; follows edits and setting changes.
- Corpus harness (`npm run test:corpus`): lints the `test/corpus` configs with Redpanda Connect 4.100.0 and 4.112.0 in CI and compares the output with recorded results.

## [0.0.1]

- Initial scaffold: opening a YAML file logs the Redpanda Connect binary version to the "Redpanda Connect" output channel.
