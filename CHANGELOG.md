# Change Log

All notable changes to the "rpcn-pipeline-designer" extension are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

- Binary resolution: `rpk connect` on `PATH`, then `redpanda-connect` on `PATH`, then `redpandaConnect.binaryPath` as a fallback; binaries older than v4.100.0 are rejected. The binary is resolved again when the setting changes.
- A warning with **Install guide**, **Set path** and **Retry** appears when no usable binary is found, once per change of state.
- Shared argument builder for lint and run (`--resources` from `redpandaConnect.resourceFiles` only, `--env-file` from `redpandaConnect.envFile`, `NO_COLOR=1`); not used by any command yet.
- Lint on save: findings from `lint --deprecated` appear as whole-line diagnostics (deprecated fields as warnings), hidden on lines YAML by Red Hat already flags (and lint's YAML syntax errors while Red Hat reports one), and cleared by the first edit.
- Hover on a field with documented options lists them (`Options: …`).
- Quick Fix for `value X is not a valid option for this field`: **Change to `<option>`** with the closest options of that field, replacing only the value.
- Completion: fields of a component are offered while a required field is still missing, and documented options (such as `file.codec` or `logger.level`) are suggested as values with their descriptions.
- Run and Stop: run a detected config in a per-file terminal (auto-saves first), stop it with an interrupt (killed after 10 s, or at once on a second Stop), and see the exit status in the status bar.
- Quick Fix for `field X not recognised`: **Change to `<name>`** with the closest valid field names from the binary's schema, replacing only the key. Bundles `yaml` 2.9.1 (ISC), listed in NOTICE.
- Process runner: caller environment and working directory for one-shot runs, and a streaming runner with Stop (SIGINT, then SIGKILL after a grace period) for Run; not used by any command yet.
- The config schema is generated from the binary (`list --format jsonschema`, with docs from `list --format json-full`), cached per binary path and version, and regenerated with **Redpanda Connect: Refresh Schema**.
- Detected Redpanda Connect configs get completion and hover from the binary's schema through YAML by Red Hat.
- Detection: top-level Redpanda Connect keys per YAML document, templates excluded, `redpandaConnect.filePatterns` always wins; follows edits and setting changes.
- Diagnostics parity: the corpus harness checks that the extension's lint diagnostics match every recorded lint line (line, message, severity), with or without the binaries installed.
- Corpus harness (`npm run test:corpus`): lints the `test/corpus` configs with Redpanda Connect 4.100.0 and 4.112.0 in CI and compares the output with recorded results.

## [0.0.1]

- Initial scaffold: opening a YAML file logs the Redpanda Connect binary version to the "Redpanda Connect" output channel.
