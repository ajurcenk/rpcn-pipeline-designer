---
id: 65
type: spike
title: "Can the extension host the Claude Agent SDK, through the Redpanda ADP proxy, running rpcn-skills with structured questions and its own tools?"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: true
risk: medium
estimate: ""
---

# Can the extension host the Claude Agent SDK, through the Redpanda ADP proxy, running rpcn-skills with structured questions and its own tools?

## Description

This spike checks whether proposed architecture decision AD-26 holds. The RPCN AI Assistant would embed the Claude Agent SDK in the extension host, send its Anthropic calls through the Redpanda ADP LLM proxy with a model, base URL and key the extension sets, and run the `rpcn-skills` plugin. The skills' questions would reach the extension as structured data, and the extension would serve its own tools in process. AD-26 is adopted, or amended, from what this spike finds, and the assistant's epic and stories wait for it.

## Approach

Prototype code on a branch or in a throwaway folder; it is not shipped. Time box: 3 days. Each step records what was run, what was seen, and its verdict in the findings.

1. **ADP proxy.** The user provides an ADP endpoint and a test key, without the key appearing anywhere but the environment. Check with plain HTTP calls, then through the SDK:
   - `POST /v1/messages`, plain and streaming (SSE), with tool use;
   - `x-api-key` versus `Authorization: Bearer`, and any extra headers ADP requires;
   - the model names it takes: Anthropic IDs or ADP aliases;
   - whether `/v1/messages/count_tokens` and any other endpoint the SDK calls pass through;
   - what a refused key, an unknown model and a timeout look like.
2. **The SDK in the extension host.** A minimal command in a dev-host build runs `query()` with `model`, `env` (`ANTHROPIC_BASE_URL` and the key) and `cwd` set to the workspace. Measure:
   - the package size it adds, and whether the bundled Claude Code binary is per platform;
   - start-up time;
   - behaviour on Linux and macOS. Windows waits for story 1.
3. **Skills as a plugin.** Load a pinned copy of `rpcn-skills` with `plugins: [{ type: "local", path }]` and `skills` limited to `rpcn-design`, `rpcn-author` and `rpcn-test`. Check that the init message lists them, and that `settingSources` can keep the user's own `~/.claude` configuration out.
4. **Structured questions.** Run one design request ("read orders from a topic and post them to an API; failures to a dead-letter topic") to the questions round:
   - Do the questions reach `canUseTool` as `AskUserQuestion` with options?
   - If the skill asks in plain text instead, record the change to `rpcn-design` this needs. Make it only with the user's OK, in the `rpcn-skills` project.
   - Answer the questions and confirm the design note is written with status `ready`.
5. **In-process tools.** Serve two tools with `createSdkMcpServer`:
   - `rpcn_componentFields`, on the extension's binary resolution, returning `rpcn_check`'s `SCHEMA.md` envelope;
   - `metrics_bottleneck`, on a running local file's metrics feed.

   Check that the agent calls them, that results are masked, and what a skill does when the tool is offered beside its own script.
6. **Approvals and boundaries.** Confirm that `canUseTool` and a pre-tool hook can:
   - allow the skills' `rpcn_check` calls;
   - ask for any other shell command;
   - deny writes outside the workspace.
7. **Record the answer.** Write the findings, then amend AD-26 with what changed: auth, headers, model names, package size, any skill change. The user marks the spike done, which adopts AD-26.

Good enough: one design request reaches a `ready` design note through ADP, with structured questions answered in the extension's own callback, both tools called, and the package size known.

## Acceptance Criteria

1. **ADP's contract is known**
   Verify: the findings record the endpoint format, auth header, extra headers, model names, `count_tokens` and the error shapes, each with the call that showed it (no key in the record).
2. **The SDK runs inside the extension host**
   Verify: the findings record a dev-host run on Linux (and macOS if available), the start-up time and the package size added.
3. **rpcn-skills runs as a plugin, with structured questions**
   Verify: the findings record the init message's skills, the `AskUserQuestion` input received, and the design note written (or the skill change needed, with the user's decision).
4. **The extension's own tools work in process**
   Verify: the findings record both tools' calls and results, masking included.
5. **The answer is recorded where the assistant's tickets will find it**
   Verify: `spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy-findings/findings.md` beside this ticket, and AD-26 in the architecture amended from it.
6. **The user accepts it**
   Verify: the user marks the spike done, recorded in its plan, which moves AD-26 from proposed to adopted.

## References

- parent — none
- architecture — `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md`, AD-26 (proposed)
- design — the RPCN AI Assistant prototype canvas: https://claude.ai/artifact/AMTmvbHVtSS3wKBZudoWtq
- source — the `rpcn-skills` project (`../rpcn-skills`): `skills/rpcn-design`, `skills/rpcn-author`, `tools/shared/rpcn_check/SCHEMA.md`
- docs — Claude Agent SDK: skills, plugins, handling approvals and user input (code.claude.com/docs/en/agent-sdk)

## Notes

- Decision: the assistant runs on an embedded Claude Agent SDK, with its own view, because the model, base URL and key must be set by the extension for the Redpanda ADP proxy (the user, 2026-11-23).
- Decision: Claude models only for now; other models would be a later adapter behind the same host port (the user, 2026-11-23).
- hitl: the user provides the ADP endpoint and a test key, and accepts the findings.
- Assumption: risk medium. The SDK's bundled binary, its size and its behaviour inside the extension host are unknown.
- Open question: is any change to `rpcn-skills` needed (questions through `AskUserQuestion`, preferring the host's `rpcn_*` tools)? Each one is proposed to the user before it is made.
- Decision: no floor (VS Code 1.100.0) runs (the user).
