---
type: epic
title: "RPCN AI Assistant"
parent: initiative-rpcn-vscode-designer
covers: []
after: []
assignee: ""
risk: high
estimate: ""
estimate_basis: ""
---

# RPCN AI Assistant

## Description

A Redpanda Connect developer describes a pipeline in plain words. In its own VS Code view, the RPCN AI Assistant turns the request into a checked design note, and from the note into a lint-clean pipeline, with the Pipeline Designer's graph opened beside it. It runs the `rpcn-skills` project's skills, `rpcn-design`, `rpcn-author` and, as a hand-off, `rpcn-test`. They run against the developer's own Redpanda Connect binary, through the Claude Agent SDK embedded in the extension. The Anthropic endpoint is configurable: a proxy such as Redpanda ADP, or Anthropic directly. The model, base URL and key are set by the extension. The skills' questions appear as choices, and every check the skills make uses the same binary and lint as the rest of the extension. Architecture decision AD-26, adopted from spike 65, binds how it is built. The spec listed AI assistance as a non-goal; the user brought it into scope on 2026-11-23 (Notes).

## Outcome

A developer gets from a plain request to a `ready` design note and a lint-clean pipeline without leaving VS Code or writing YAML by hand. The signal: the request in spike 65's run 2, made in the assistant view, ends with both files written and the graph open.

## Requirements

No spec capability covers this epic (Source conflict in Notes), so its requirements are its own, from AD-26, spike 65's findings and the prototype.

- **E8 (R1) The assistant view.**
  - A view in its own activity-bar container.
  - It shows the stages (Design, Author, Test; Tune and Scale greyed as later), the conversation, each progress step, the files written and the next-step buttons.
  - The stage and the next step come from the artifacts on disk: the design note's `status` through the handoff check, the pipeline, the test report. A reload loses no progress, and the conversation starts fresh.
  - Follow-up messages, Stop and a new conversation.
  - The layout is the prototype's option A, a chat transcript: turns with the skill used, step rows with results, the files a turn wrote with a diff and Keep or Undo, next-step chips, and `/design`, `/build` and `/test` in the composer.
- **E8 (R2) Assistant access.**
  - The settings: model, base URL, and auth (`bearer`, the default, or `x-api-key`).
  - The key is in secret storage only, set by Set up assistant access…, which ends with a test call, and removed by Forget assistant access.
  - The model choice offers what the endpoint's `/v1/models` lists.
- **E8 (R3) The Design stage.**
  - A request runs `rpcn-design`.
  - Its questions arrive as `AskUserQuestion` and show as cards: the skill's pick first as "(My pick)", an "Other" free-text answer, and round 2 when asked.
  - The existing-note question offers update or leave.
  - The note is previewed with its status, and its open decisions are listed.
  - A `draft` note with a blocking decision turns Build off until that decision is answered.
- **E8 (R4) The Author stage.**
  - Build the pipeline from a `ready` note runs `rpcn-author`.
  - The view shows each lint round (at most 3) and lists the files written (`.yaml`, `.blobl`, `.env.example`, and `.resources.yaml` when there is one).
  - It opens the graph beside the pipeline. An existing pipeline is never overwritten, and any deviation from the note is shown.
- **E8 (R5) Tools.** The `rpcn_*` tools (binary, list, fields, lint, Bloblang check, dry run, test, handoff check) and read-only feature tools (metrics figures and the bottleneck, recent log errors, Cloud pipelines and their state, the pipeline model, diagnostics, environment variable names), served in process (AD-26).
- **E8 (R6) Boundaries and approvals.**
  - **Shell:** allowed without asking only for `uv run` of an `rpcn_check.py` inside the active skills copy, with no shell metacharacters.
  - **Writes:** a stage writes its own artifact without asking. Every other write asks, and writes outside the workspace are denied.
  - **Reads:** reads inside the active skills copy need no approval.
  - **Approvals:** prompts show in the view.
  - **Effects outside the editor:** Run and Deploy remain the user's buttons.
  - **The environment:** the agent's environment is built by the extension, and nothing is written under the user's home.
- **E8 (R7) States.** Each with its text and next action:
  - no binary;
  - no assistant access;
  - key refused;
  - model not allowed;
  - endpoint unreachable or timed out;
  - waiting for the first token;
  - a blocking open decision;
  - lint still failing after 3 revisions;
  - the agent's own error.

  Both ADP's error format and Anthropic's are mapped.
- **E8 (R8) Privacy.**
  - The key is never in a setting, file, argument, log, message or capture.
  - Every text shown or logged is masked.
  - Pipeline data in tool results (log messages, records) is marked untrusted.
  - Environment variable values never leave the extension.
- **E8 (R9) The assistant runtime and the skills source.**
  - One VSIX for every platform, carrying a pinned copy of `rpcn-skills` but never Anthropic's SDK or Claude Code binary.
  - The user installs the assistant runtime from VS Code (Install assistant runtime…), after agreeing to Anthropic's terms.
  - The runtime is the pinned SDK and this platform's binary package, downloaded from the npm registry, checked against pinned integrity hashes, and kept in the extension's global storage. Update and Remove commands go with it.
  - `redpandaConnect.assistant.skillsSource` chooses `bundled` (the default), `latest` (downloaded from the skills repository on GitHub, confirmed by the user, revertible) or `path` (a local checkout). The view shows which copy is in use.
- **E8 (R10) The Test hand-off.** "Test the pipeline" runs `rpcn-test` on the built pipeline and shows its verdict, with a link to `<name>.test-report.md`.
- **E8 (R11) Existing pipelines.**
  - Ask RPCN Assistant on an open pipeline (editor title, Explorer, the graph) opens the chat with it attached. The stage comes from its files, so a hand-written pipeline with no note shows as built with no design.
  - Describe writes a design note for what the pipeline does today and never changes the pipeline.
  - Change applies the request as minimal edits, each shown as a diff the user applies or skips. A whole-file write over an existing pipeline is never allowed. Lint follows, and a departure from the note adds a Deviations row.
  - Explain answers from the files and writes nothing.

## Done when

1. In the assistant view, a plain request goes through question cards to a `ready` design note, and Build writes lint-clean pipeline files and opens the graph. A scripted fake host and a fake model each check this in the automated suites.
2. Each state in R7 shows its text and next action, checked by an integration test.
3. The one VSIX installs on a clean VS Code on Linux and on macOS. Install assistant runtime… gets the runtime there, and the request in item 1 runs through a real endpoint, in the user's manual check.
4. Tests show no key, header value or home path in any setting, file, argument, log or capture after a full Design and Author run on the fake model.
5. `skillsSource` switches between `bundled`, `latest` and `path`. The view names the copy in use, and the shell rule allows only that copy's `rpcn_check.py`.
6. On a hand-written pipeline with no note, Describe writes a `ready` note and leaves the pipeline byte-identical, and a Change request lands as approved edits only, lint clean. A fake model checks this in the automated suites.

## Boundaries

- **Follows:** the capability boundary of AD-26. It's one view, one host port, one adapter, one tool layer.
- **Not in this epic:**
  - Tune, Scale and Deploy stages (they wait for their skills);
  - other model families (a later adapter behind the same port);
  - Windows (backlog story 1);
  - resuming the chat after a reload;
  - VS Code Language Model Tools or a standalone MCP server;
  - applying `rpcn-test`'s proposed diffs from the view.
- **Testing:**
  - No automated test calls a real model endpoint. CI and the suites use the scripted fake host and a local fake Messages API.
  - Real model calls happen only in the user's manual checks, at most 2 runs per story.
- **The skills project:** `rpcn-skills` is never edited from here. A needed change goes to that project as a change request.

## References

- parent — `_bmad-output/initiative-rpcn-vscode-designer/initiative-rpcn-vscode-designer.md`
- architecture — `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md`, AD-26 (adopted 2026-11-24); also AD-9 (binary), AD-12 (lint), AD-13 (Run), AD-23 (Cloud), AD-24 (logs), AD-25 (metrics)
- spike — `_bmad-output/backlog/spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy-findings/findings.md` (spike 65), and its code `scripts/spike/assistant-host/` and `scripts/spike/adp-probe.mjs` (fakes and checks to reuse)
- design — the RPCN AI Assistant prototype canvas: https://claude.ai/artifact/AMTmvbHVtSS3wKBZudoWtq (Design questions, design note ready, Author, States)
- ux — `_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/DESIGN.md` (theme tokens, no brand layer); `EXPERIENCE.md` (gains an assistant section during this epic)
- source — the `rpcn-skills` project: `skills/rpcn-design`, `skills/rpcn-author`, `skills/rpcn-test`, and `tools/shared/rpcn_check/SCHEMA.md` (the tools' envelope), at commit `888de77` or the release the bundle pins
- docs — Claude Agent SDK: skills, plugins, handling approvals and user input (code.claude.com/docs/en/agent-sdk)

## Notes

- Source conflict: spec Non-goals — "AI assistance" is a non-goal vs the user's decision on 2026-11-23 to build the RPCN AI Assistant. Settled by the user; no spec capability covers it yet (as epics 5–7).
- Decision (replaced 2026-11-25): one VSIX per platform; no first-run download, no separate extension (the user, 2026-11-24).
- Decision: the extension never redistributes Anthropic's SDK or binary. One VSIX for all platforms; the user installs the runtime on demand from VS Code, from the npm registry, integrity-checked against pinned hashes, after explicit agreement to Anthropic's terms, into the extension's global storage. This replaces per-platform VSIXes (the user, 2026-11-25).
- Decision: the assistant view is a chat transcript, the prototype's option A, chosen over stage cards (B) and a Copilot-style view (C). Entry 12 builds it after entry 2 (the user, 2026-11-25).
- Decision: an approval in the chat offers Allow for this session, which remembers a shell command's program and subcommand (not the exact text, and never a command with pipes, `;`, redirects or `$(…)`) until the window reloads. Entry 5 builds it (the user, 2026-11-25).
- Decision: the assistant works on existing pipelines: describe, change through approved edits, explain (R11, entries 13 and 14). The skill side goes to `rpcn-skills` as two change requests, kept in `rpcn-skills-change-requests/` (the user, 2026-11-25).
- Decision: Test is a hand-off only — run `rpcn-test` and show its verdict and report link (the user, 2026-11-24).
- Decision: after a reload, the stage comes from the files; the conversation starts fresh, with no session resume (the user, 2026-11-24).
- Decision: the tracer bullet is entry 1, from a request to a `ready` design note in the assistant view (the user, 2026-11-24).
- Decision: a pinned copy of `rpcn-skills` is bundled, with a `path` override and a `latest`-from-GitHub option the user confirms (the user, 2026-11-24).
- Decision: three test layers. A scripted fake host and a fake Messages API in the automated suites, at no model cost. Real model calls only in the user's manual checks, at most 2 runs per story (the user, 2026-11-24).
- Decision: after the tracer bullet, the slice least certain is packaging (entry 2).
- Decision: the skills repository's address is a setting default in the code, not in any ticket text.
- Open question: whether to hide Claude Code's bundled skills and built-in plugins further than the skills allowlist (AD-26). Settled in entry 6's plan.
- Decision: 8.2 adds `redpandaConnect.assistant.skillsPath` for a local checkout. 8.10 adds `redpandaConnect.assistant.skillsSource` (`bundled` | `latest` | `path`), whose `path` reads `skillsPath`. Done-when item 5 is met through both (8.2's review, 2026-11-25).
- Settled: the redistribution question from 8.2's review goes away, because the extension no longer ships Anthropic's code. The user downloads it under Anthropic's terms, which the install shows and asks them to agree to (the user, 2026-11-25).
- Waits on epic 2 because: the Run and its argument builder (AD-13), which the tools and the run step use.
- Waits on epic 3 because: the graph panel, which Author opens.
- Waits on epic 5 because: the Cloud view and its pipelines, for the Cloud feature tools.
- Waits on epic 6 because: the logs reader, for the recent-errors tool.
- Waits on epic 7 because: the metrics feeds and the bottleneck logic, for the metrics tools.
