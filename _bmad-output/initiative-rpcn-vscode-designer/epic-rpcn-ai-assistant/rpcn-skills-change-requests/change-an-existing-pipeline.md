# Change request: rpcn-author changes an existing pipeline, as a reviewable proposal

## Context

The Redpanda Connect VS Code extension's RPCN AI Assistant (architecture AD-26, epic 8) runs `rpcn-skills` through the Claude Agent SDK. A developer with a pipeline open asks to change its logic, for example "drop test orders before posting" or "retry the API with backoff". The assistant needs a skill path from that request to a change of the existing files that the developer can review before it lands.

## The problem today

At the current pinned copy (`3afb844`):
- **`rpcn-author` never writes over an existing pipeline.** `SKILL.md` Step 2: "If `<dir>/<pipeline>` exists, never write over it: ask in Step 5's round (headless: stop, `blocked`)". So a request to change an existing pipeline, or to rebuild it after its design note changed, stops or asks for another name.
- **The only path that edits an existing pipeline is Step 7,** which applies a test report's Proposed changes. Those come from failed checks, not from a change the user asks for.
- **`rpcn-design`'s re-run** (`references/rerun.md`) can update a note with a stated change. But nothing then carries that change into the existing pipeline.

## Requested change

Add a **change mode** to `rpcn-author`: an explicit request to change an existing pipeline, or to bring it in line with its updated design note, produces a **minimal, reviewable change** of the existing files instead of a refusal.

1. **When it applies:**
   - the request names an existing pipeline (or its folder) and asks to change it, with trigger phrases such as "change my pipeline to …", "update `<name>.yaml` so …", "apply the design change", "rebuild from the updated note";
   - or `<name>.design.md` is `ready` and newer than the pipeline. Its `hash --check` shows the pipeline was built from an older version, or the user says so.

   A plain "write a pipeline" over an existing file keeps today's rule.
2. **What it does:**
   - **Reads first:** the existing pipeline, its resources, `.blobl` files and `.env.example`, and its design note when there is one.
   - **Picks and checks:** new components and fields with `list` and `fields`, as Steps 3 and 4 do.
   - **Changes only what the request or the note's change needs:**
     - existing labels, comments, field order and unrelated parts stay as they are;
     - an inline mapping isn't moved into a `.blobl` file unless asked (the rule in `pipeline-files.md` today);
     - `.env.example` only gains names.
   - **Lints the changed files,** up to 3 revisions as today, and reports the result.
   - **Records departures:** a change that departs from the note adds a Deviations row, as today.
3. **How the change is offered for review,** the main ask:
   - **Interactive:** make the change with **Edit** on the existing files, never a whole-file Write, one Edit per change. The host can then show each one as a diff and approve or refuse it. That's how the extension's `canUseTool` sees the old and new text. A refused Edit leaves the file as it was. The skill reports what was refused, and doesn't retry it differently.
   - **Headless:** write nothing to the pipeline. Instead write `<name>.change.md`, a proposal file in the same shape as the test report's Proposed changes: numbered items, each with a title, a `Cause:` line naming the request or the note's change, and a fenced unified `diff` against each file. It also carries the handoff header with `inputs` hashing the files the diffs apply to, so a stale proposal is caught. Step 7 learns to apply a `<name>.change.md` the same way it applies a test report.
4. **Questions:** only what the change leaves open, in one round, through `AskUserQuestion` when the host offers it (per `888de77`).

## What must not change

- A new pipeline is still never written over an existing file without this explicit change mode.
- Step 7, applying a test report, works as today.
- Secrets and addresses stay `${ENV}`.
- Only components and fields the binary reports are used.
- `rpcn-author` still writes only Deviations rows and `updated` in a note (`design-format.md`, "Who writes what").
- Headless never asks.

## How to check it

1. **An interactive change on a built pipeline,** for example "drop test orders before posting":
   - the existing YAML changes through Edits only;
   - unrelated lines are byte-identical;
   - lint is clean;
   - a refused Edit leaves the file untouched and is reported.
2. **A note changed by `rpcn-design`'s re-run,** then "apply the design change": the pipeline follows the note, and any departure adds a Deviations row.
3. **Headless:** the same request writes `<name>.change.md` with verified diffs, and no pipeline file changes. Step 7 applies it.
4. **A plain "write a pipeline"** over an existing name still asks or blocks, as today.
5. **New trigger evals** for the change phrases, with misses for "design …" (still `rpcn-design`) and "test …" (still `rpcn-test`).

## Reference

- Extension: AD-26 and epic 8 (`rpcn-vscode-byoc-plugin`, `_bmad-output/initiative-rpcn-vscode-designer/epic-rpcn-ai-assistant/`). The extension applies edits as minimal ranges (its AD-19) and shows diffs before applying.
- Skills: `skills/rpcn-author/SKILL.md` (Steps 2, 6 and 7), `references/pipeline-files.md`, `references/apply-report.md`, `skills/rpcn-test/references/test-report-format.md` (Proposed changes), `skills/rpcn-design/references/rerun.md`, `design-format.md` ("Who writes what").
- Related request: "rpcn-design describes an existing pipeline" (for a pipeline with no note).
