---
title: "Product Brief: Redpanda Connect Designer for VS Code"
status: final
created: 2026-10-02
updated: 2026-10-12
---

# Product Brief: Redpanda Connect Designer for VS Code

*Display name: "Pipeline Designer for Redpanda Connect", published by `ajurcenk` (provisional ID `ajurcenk.rpcn-pipeline-designer`). It must not imply official Redpanda branding.*

## Executive Summary

Developers build Redpanda Connect pipelines today by writing YAML by hand. They look up component fields in the docs and find out about mistakes only when they run `lint` or the pipeline itself. Redpanda Cloud is bringing back a visual editor (the "Visual tab", in preview since August 2026), but it works only in the browser and needs a Cloud account. Developers who work locally, keep configs in git and run their own binary have nothing comparable in their editor.

This project is an open-source VS Code extension that makes local Redpanda Connect development fast and visual. A config file opens in the **Designer**, a custom editor with two views side by side: a **read-only pipeline graph** for seeing and navigating the pipeline, and a **Redpanda Connect–aware YAML editor** where all editing happens. Tabs switch to the graph alone or the YAML alone when developers want more space. The promise is a *smarter* editor, not just a faster one. The Designer takes its schema and validation from the developer's own `rpk connect` / `redpanda-connect` binary, so completion and checks always match the components they can actually run. A "Run" command gives a full local edit → check → run loop.

The first release focuses on developer experience for local authoring. It is also meant as the foundation for a broader Redpanda Connect workbench: testing, AI assistance, BYOC deployment, metrics and debugging.

## The Problem

- **Writing pipeline YAML is slow and error-prone.** Redpanda Connect has hundreds of components, each with its own fields. Developers jump between the editor and the docs, and typos or wrong field names only show up at lint or run time.
- **It's hard to see a pipeline's structure.** A long config with brokers, a chain of processors, `switch` and `branch` is hard to follow as text, especially when reviewing or taking over someone else's pipeline.
- **No editor understands the config schema.** The only extensions cover Bloblang, and one of them is abandoned. None offers a visual view.
- **Bloblang mappings are written blind.** A `mapping` or `mutation` processor is checked only by `lint` on save or by running the whole pipeline. To see what a mapping does to a message, developers copy it into the Bloblang playground on the docs site (https://docs.redpanda.com/connect/guides/bloblang/playground/), paste a sample message, and copy the result back. That playground runs its own build of Bloblang, not the developer's binary.
- **The visual option is tied to Cloud.** Benthos Studio, the earlier visual designer, is gone. The new Cloud Visual tab does not cover local, git-based, self-hosted or community-edition workflows.

## The Solution

The Designer is a VS Code custom editor for Redpanda Connect config files, where the YAML text is always the single source of truth.

- **YAML editor:**
  - completion, hover docs and validation based on the schema
  - `lint` diagnostics shown inline
  - Bloblang highlighting in `mapping`, `check` and `${! }` interpolations
  - snippets
- **Graph view (read-only):** a graph of input → processors → output, plus resources.
  - Nested structures (`switch`, `branch`, `workflow`, `try`/`catch`, brokers) appear as collapsible groups.
  - Nodes with errors or warnings are marked, with the message on hover.
  - Clicking a node selects its YAML, and moving the cursor in the YAML highlights its node.
  - The graph updates as the developer types; while the YAML is broken it keeps the last valid graph.
- **Editing happens only in YAML.** The extension never rewrites the file from the graph, so comments, `${ENV}` variables and formatting are never at risk. The only edits it makes are Quick Fixes the developer chooses.
- **Run locally:** save and run the current pipeline with the local binary, with logs in the VS Code Terminal.
- **Check and test Bloblang mappings** (second release, added 2026-10-12):
  - Bloblang syntax errors in `mapping` and `mutation` processors are underlined in the YAML as the developer types, with the parser's message.
  - A mapping opens in a **Bloblang test panel** beside the editor, with the sample **input** (and its metadata), the **output** the mapping produces, and the **error** when the mapping fails: a parse error, or a failure while mapping that input (for example "expected number value, got null from field `this.user.id`"). The output updates as the mapping or the input is edited.
  - The mapping runs on the developer's own binary, so the result matches the version, edition and plugins they run, unlike the docs playground.
  - The sample input is saved in a file next to the config in the workspace, so it can be committed with the pipeline and is there the next time the panel opens.

## What Makes This Different

This is not the first visual designer for Redpanda Connect: Benthos Studio came before it, and the Cloud Visual tab exists today.

**Why not just use the Cloud Visual tab?** The Cloud editor is a place to configure deployed pipelines. This extension is built around how developers actually work: git-based version control and review, fast editing in their own editor, and, in later phases, profiling and step-by-step debugging of pipeline execution. Redpanda Cloud BYOC does not support these today. With this extension, developers build and debug locally, then deploy to BYOC from the same editor.

What sets us apart:

- **Local-first and git-native.** Files live in your repo and changes go through normal code review. No Cloud account is needed.
- **Matches your runtime.** The schema and lint come from your installed binary, including its version, edition and custom plugins.
- **In the editor developers already use**, next to their other code.
- **Open source**, so the community can extend it.
- **The first VS Code extension that understands the Connect config schema.** Today's extensions cover only Bloblang.

Honest risk: if Redpanda ships an official IDE extension, this project's value shifts to being the community or open-source alternative. Speed of delivery and how smart the editing and graph feel are the real advantage.

## Who This Serves

- **Primary: Redpanda Connect developers who build and test pipelines locally and later deploy them to Redpanda Cloud BYOC.** In the first release they get a fast local loop for authoring, validating and running pipelines. In later phases the same tool takes them from a local pipeline to a BYOC deployment without leaving the editor. They want fewer trips to the docs, earlier errors, and confidence that what runs locally will run in BYOC.
- **Secondary: newcomers to Redpanda Connect.** Snippets, completion, hover docs and a graph that grows as they type make it easier to get started. `[ASSUMPTION]`
- **Secondary: reviewers and maintainers.** They need to understand an unfamiliar pipeline quickly. `[ASSUMPTION]`

## Success Criteria

The first release is judged on developer experience, not adoption numbers:

- **Graph accuracy:** for 100% of a reference corpus of real configs (including the Redpanda Connect cookbook examples), the graph shows every component, every route (`switch` cases, brokers) and every nested group correctly, and clicking any node lands on the right YAML.
- **Diagnostics parity:** for every config in the reference corpus, the errors shown in the editor match the output of `rpk connect lint`.
- **Bloblang result parity** (second release): for every `mapping` and `mutation` in the reference corpus with a sample input, the test panel shows the same output, or the same error, as the binary's `blobl` command on that input, and every parse error the editor underlines is one the binary reports for that mapping.
- **Time to first valid pipeline:** a new user who has the binary installed can build and run a working pipeline in under 10 minutes.

## Scope

**In the first release (local development):**
- Detect the `rpk connect` or `redpanda-connect` binary, with a setting to override the path. A clear message guides installation when it's missing.
- Generate the schema from the binary and cache it per version.
- YAML editor: schema validation and completion, lint diagnostics with Quick Fixes for common errors (for example a mistyped field name), hover docs with examples, Bloblang highlighting, snippets.
- Graph view: read-only, side by side with the YAML by default, nested blocks as collapsible groups, error and warning markers, selection linked both ways with the YAML.
- Single-file configs plus resource files.
- Recognizing Redpanda Connect files by their content (top-level `input`, `pipeline`, `output` or resource keys), plus a workspace setting for file patterns and an "Open in Designer" command. Detected files open in the Designer by default, with a setting to turn that off. There's no required file-naming convention.
- Local run: auto-save, then run with logs in the integrated Terminal and a stop control.
- Packaged by CI as an installable `.vsix` under the Apache 2.0 license; publishing to the VS Code Marketplace and Open VSX is parked for the POC.

**In the second release (Bloblang check and test, added 2026-10-12):**
- Live Bloblang syntax checking in `mapping` and `mutation` processors (the `mapping` / `mutation` field of the processor, including nested ones in `switch`, `branch` and `try`), shown as editor diagnostics while typing. This replaces the first release's non-goal "no Bloblang diagnostics" for these two processors only.
- A Bloblang test panel for one mapping at a time: sample input and metadata, output (content and metadata), and the parse or mapping error.
- Execution on the developer's own binary only; with no usable binary the panel shows the same guidance as the graph.
- Sample inputs saved as workspace files next to the config, one per mapping.

**Not in the second release:**
- Other Bloblang locations: `check`, `request_map` / `result_map`, other `*_map` / `*_mapping` fields, `${! }` interpolations and standalone `.blobl` files.
- Capturing real messages from a run, and running a mapping in the context of the whole pipeline (earlier processors applied first).
- Writing `rpk connect test` unit-test definitions from the panel, and running `rpk connect test`.
- A bundled Bloblang engine (the docs playground's Wasm module) for use without a binary.

**Explicitly out of the first release:**
- BYOC or Cloud deployment.
- Any editing from the graph: adding, removing, reordering or configuring components, and property forms generated from the schema.
- Streams mode with multiple pipelines.
- A bundled schema for use without a binary.
- Unit testing, AI assistance, metrics and debugging.

## Vision

A local workbench for Redpanda Connect that covers a pipeline's whole lifecycle in the editor:

1. **Author:** the pipeline graph and YAML editor, later with editing from the graph.
2. **Test:** check and test Bloblang mappings against sample input (the second release), then run `rpk connect test`.
3. **Assist:** AI help to generate, explain and fix pipelines, possibly through `rpk connect mcp-server`.
4. **Deploy:** push to Redpanda Cloud BYOC clusters.
5. **Observe:** pipeline metrics and step-through debugging.

The first release earns the right to the rest by being the best way to write a pipeline.

## Open Questions

- How to get structured lint output, since `lint` has no JSON flag. Options are parsing its text output, contributing a flag upstream, or using another source.
- Whether to integrate with the existing open-source Bloblang language servers or build our own Bloblang support. *Partly answered (2026-10-12):* Bloblang checking and execution come from the developer's binary, not a language server.
- How the test panel gets **metadata** in and out. The binary's `blobl server` ignores input metadata, returns no output metadata, and gives an empty result with no flag when a mapping deletes the message (checked on v4.112.0). See the addendum for options.
- Where sample inputs are stored (folder and file naming) and how a sample stays attached to its mapping when processors are reordered or renamed.
- Who maintains the project and contributes to it, and at what pace.
