# Change Log

All notable changes to the "rpcn-pipeline-designer" extension are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

- Pipeline graph: two-way navigation. Moving the cursor in the YAML highlights the node under it in the graph (the innermost node; inside a collapsed group, the group's box), without moving focus or revealing the panel, and recomputed after every edit; while the YAML does not parse the highlight stays as it was. Clicking a node selects its YAML and now centres it in the editor the cursor was last moved in (with the file open in two editors, that one; else a visible editor for the file, else the first column), and clicking a group's header label selects the whole group. A recreated graph shows the current highlight.
- Pipeline graph: the graph follows edits live. Every change to a file with an open graph sends the complete model again; while the YAML does not parse, the graph keeps the last valid version under the banner "YAML has errors — showing last valid graph." with the parser's message, and clicking it selects the error in the editor. A file that does not parse when the graph opens shows the banner over an empty canvas. Updates keep the pan, zoom and collapsed groups, and the layout is deterministic, so whitespace, comments and values not shown in the graph move nothing.
- Corpus harness: `npm run test:corpus` also builds the pipeline graph of every `test/corpus` config with both pinned schemas and compares it with a recorded `test/corpus/<name>.graph/<ver>.json` (graph accuracy, no binary needed), and checks that every node's range resolves back to that node. `nodeAt` in the core maps a document offset to the innermost node containing it.
- Pipeline graph: groups are drawn as boxes holding their children (a header with a chevron, the component and its label), routes (`switch` cases, broker outputs, `try` / `catch` bodies, `workflow` branches) as captioned sub-boxes, and resources as standalone nodes. A group's chevron collapses it to one box with a count; the collapse state is kept across redraws. Colours come only from the VS Code theme. Bundles @vscode/codicons 0.0.46-24 (CC-BY-4.0 icons, MIT code), listed in NOTICE. `npm run test:webview` runs the graph view's layout tests (vitest), in CI too.
- Pipeline graph: the model now holds nested components (`switch` cases, `branch`, `try` / `catch`, `workflow` branches, broker and fallback outputs, batching processors, an input's and output's own processors, …) and `*_resources`, with which fields hold children read from the binary's schema. With no schema the graph is empty.
- Pipeline graph: **Show graph** opens a read-only graph beside a detected config (input, `pipeline.processors` and output, laid out with elkjs and drawn with @xyflow/react), one panel per file; clicking a node selects its YAML. Bundles React, react-dom, @xyflow/react and their dependencies (MIT, ISC, BSD-3-Clause) and elkjs (EPL-2.0), listed in NOTICE.
- Quick Fix **Fix all lint findings with a clear fix (N)**: applies the preferred fix of every lint finding in the file that has a clear one, as a single edit. Because the first edit after a save clears all findings, fixing them one by one needed a save after each fix.
- Binary resolution: `rpk connect` on `PATH`, then `redpanda-connect` on `PATH`, then `redpandaConnect.binaryPath` as a fallback; binaries older than v4.100.0 are rejected. The binary is resolved again when the setting changes.
- A warning with **Install guide**, **Set path** and **Retry** appears when no usable binary is found, once per change of state.
- Shared argument builder for lint and run (`--resources` from `redpandaConnect.resourceFiles` only, `--env-file` from `redpandaConnect.envFile`, `NO_COLOR=1`), used by lint on save and Run.
- Lint on save: findings from `lint --deprecated` appear as whole-line diagnostics (deprecated fields as warnings), hidden on lines YAML by Red Hat already flags (and lint's YAML syntax errors while Red Hat reports one), and cleared by the first edit.
- CI runs the test suite on VS Code 1.100.0, the minimum supported version, as well as on the latest stable release.
- Pipeline snippets: a whole-pipeline starter, input/pipeline/output sections, and generate, redpanda, stdout, mapping, switch, branch and log blocks, offered only in Redpanda Connect files (and the starter in a blank YAML file).
- Bloblang methods narrowed to the type of a literal (`"test".`) or of a field assigned one.
- Bloblang completion of names already written: fields after `this.` / `root.`, `let` variables after `$`, metadata keys after `@`.
- Bloblang function and method completion and hover inside Bloblang, from the binary's own docs.
- Bloblang highlighting in mapping fields (`mapping`, `check`, `*_mapping`, …) and in `${! }` interpolations.
- Refresh Schema with no usable binary logs a line and shows the binary warning again; open files follow Set path / Retry / Refresh Schema without reopening.
- Completion on an empty list item inside a component: component names (nested `processors`, `outputs`, …) or the item's fields.
- A **<component>: required fields** item in a new component block inserts the required fields as one snippet.
- Completion in an empty component block (its fields, with docs and defaults) and on an empty value inside a component (its options, or true/false), where YAML by Red Hat offers nothing.
- Hover on a field with documented options lists them (`Options: …`).
- Quick Fix for `value X is not a valid option for this field`: **Change to `<option>`** with the closest options of that field, replacing only the value.
- Completion: fields of a component are offered while a required field is still missing, and documented options (such as `file.codec` or `logger.level`) are suggested as values with their descriptions.
- Run and Stop: run a detected config in a per-file terminal (auto-saves first), stop it with an interrupt (killed after 10 s, or at once on a second Stop), and see the exit status in the status bar.
- Quick Fix for `field X not recognised`: **Change to `<name>`** with the closest valid field names from the binary's schema, replacing only the key. Bundles `yaml` 2.9.1 (ISC), listed in NOTICE.
- Process runner: caller environment and working directory for one-shot runs, and a streaming runner with Stop (SIGINT, then SIGKILL after a grace period) for Run.
- The config schema is generated from the binary (`list --format jsonschema`, with docs from `list --format json-full`), cached per binary path and version, and regenerated with **Redpanda Connect: Refresh Schema**.
- Detected Redpanda Connect configs get completion and hover from the binary's schema through YAML by Red Hat.
- Detection: top-level Redpanda Connect keys per YAML document, templates excluded, `redpandaConnect.filePatterns` always wins; follows edits and setting changes.
- Diagnostics parity: the corpus harness checks that the extension's lint diagnostics match every recorded lint line (line, message, severity), with or without the binaries installed.
- Corpus harness (`npm run test:corpus`): lints the `test/corpus` configs with Redpanda Connect 4.100.0 and 4.112.0 in CI and compares the output with recorded results.

## [0.0.1]

- Initial scaffold: opening a YAML file logs the Redpanda Connect binary version to the "Redpanda Connect" output channel.
