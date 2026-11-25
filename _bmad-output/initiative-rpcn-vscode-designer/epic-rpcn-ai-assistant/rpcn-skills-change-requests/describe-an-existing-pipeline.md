# Change request: rpcn-design writes a design note for an existing pipeline

## Context

The Redpanda Connect VS Code extension's RPCN AI Assistant (AD-26, epic 8) moves a developer through Design → Author → Test, and the design note drives each stage. Most developers already have pipelines that were written by hand, with no note. To change one through the assistant, or to test it against a design, the assistant first needs a note that describes what that pipeline does today.

## The problem today

At the current pinned copy (`3afb844`):
- `rpcn-design` only designs from a plain request, or re-runs over an existing note (`references/rerun.md`). It never reads a pipeline. Its description says it writes the note "before any YAML is written".
- No skill turns an existing `<name>.yaml` into a `<name>.design.md`. So a hand-written pipeline can't take part in the note-driven flow:
  - change it through a note;
  - check it with `rpcn-test`'s Design check;
  - read it with a future `rpcn-scale`.

## Requested change

Add a **describe mode** to `rpcn-design`: from an existing pipeline, write a `design@1` note that describes what it does, without changing the pipeline.

1. **When it applies:** the request names an existing pipeline and asks for its design, with trigger phrases such as "describe my pipeline", "write a design note for `orders.yaml`", "document this pipeline's design", "reverse-engineer the design of …". The request names the pipeline, which is the difference from today's "write a design note for my pipeline" request.
2. **What it reads:** the pipeline, its resources files and its `.blobl` files, through Read only. Each component is checked with `list` and `fields` against the user's binary, as Steps 3 and 4 do. A component the binary doesn't list becomes a `[blocking]` open decision, as today.
3. **What it writes:** `<dir>/<name>.design.md` in the usual 11 sections:
   - **Components** is filled from the YAML, one row per component in config order, with its role in a few words.
   - **Error handling, Delivery and ordering, Idempotency and Batching** say what the config does, for example a `fallback` to a DLQ output, `max_in_flight`, `checkpoint_limit`, `batching` values, or `unordered_processing`. They don't say what it should do.
   - **What the config can't show,** such as whether ordering per key was intended, becomes an open decision. It's `[non-blocking]` with the config's behaviour as the pick, for example "Must order hold per key? Picked: no ordering (`unordered_processing` is on)". It's `[blocking]` only where the four asks of `questions.md` have no answer in the config, such as a sink failure with no target.
   - **The header:**
     - `produced_by` is `rpcn-design` as today;
     - `inputs` lists the pipeline and its resources and `.blobl` files with their `sha256`, so a later change to the pipeline marks the note stale through `hash --check`;
     - `status` follows today's rule, `ready` with no blocking item.
   - **Deviations:** `None.`
4. **Questions:** interactive asks only the open asks the config doesn't answer, in one round, through `AskUserQuestion` when offered. Headless writes them as decisions, per "A choice left open".
5. **It never edits the pipeline** or any of its files.

## What must not change

- Designing from a plain request and re-running over an existing note work as today.
- A note that already exists isn't written over: Step 2's existing-note rule applies. Describing over it asks whether to update it.
- `rpcn-design` still writes no YAML.
- Headless never asks.

## How to check it

1. **A hand-written pipeline** with a `redpanda` input and `unordered_processing`, a `mapping`, and a `fallback` to an `http_client` and a DLQ, through "describe my pipeline `orders.yaml`":
   - the note lists the four components in config order;
   - Delivery says at-least-once with the DLQ;
   - Ordering is a non-blocking pick naming `unordered_processing`;
   - `inputs` hashes the YAML;
   - the pipeline is byte-identical afterwards.
2. **A pipeline with a component the binary doesn't list:** that row is a `[blocking]` decision, and the note is `draft`.
3. **A changed pipeline:** after the YAML changes, `hash --check` on the note reports it stale.
4. **Over an existing note:** it asks whether to update it, and writes nothing until told to.
5. **New trigger evals** for the describe phrases, with misses for "write a pipeline" (`rpcn-author`) and "lint my pipeline" (`rpcn-test`).

## Reference

- Extension: AD-26 and epic 8 (`rpcn-vscode-byoc-plugin`, `_bmad-output/initiative-rpcn-vscode-designer/epic-rpcn-ai-assistant/`).
- Skills: `skills/rpcn-design/SKILL.md` (Steps 2–6), `references/design-format.md`, `references/note-writing.md`, `references/questions.md` ("The four asks", "A choice left open"), `references/handoff-header.md` (`inputs`).
- Related request: "rpcn-author changes an existing pipeline, as a reviewable proposal". The two together let a hand-written pipeline be described, then changed through its note.
