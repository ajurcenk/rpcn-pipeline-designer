# Spike 65 findings: the Claude Agent SDK in the extension host, through the Redpanda ADP proxy

Answers spike 65 (`../spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy.md`) for proposed AD-26.

**Run details:** 2026-11-24, Linux x64, VS Code 1.143.1 (Electron Node 24.21.0), Redpanda Connect 4.112.0. The SDK was `@anthropic-ai/claude-agent-sdk` 0.3.329, which bundles Claude Code 2.1.329. The model was `claude-opus-5-5` through ADP.

**Verdict:** AD-26 holds, with the amendments at the end. Every acceptance criterion has evidence in `captures/`. The biggest cost is the package size.

## How it was run

- **The contract probe** (`scripts/spike/adp-probe.mjs`): 9 plain-HTTP calls, none retried, recorded by shape only. Captures: `captures/01-…09-*.json`, `run.json` and `summary.tsv`.
- **The spike extension** (`scripts/spike/assistant-host/`): loaded into the dev host beside the Pipeline Designer, 3 design runs. Captures: `captures/design-run-1…3/` (`events.jsonl`, `run.json`).
- **The offline checks** (no network, no key): the probe's `--dry-run` (109 checks), `check/offline.cjs`, and `check/run-refusal.mjs` with and without `--fake-run` (29 checks). Captures: `captures/offline-fake-run/`.
- **Credentials:** `~/.config/rpcn-spike/adp.env`, mode 0600, never read by the orchestrator or written anywhere. Every run's leak self-scan is clean.
- **Cost:** about $0.97 in all: $0.43, $0.40 and $0.14 for the three runs, plus the probe's small calls.

## 1. ADP's contract (AC 1)

| Question | Answer | Evidence |
|---|---|---|
| Format | ADP serves the Anthropic Messages API as a pass-through. Its answers carry Anthropic's own headers (`anthropic-organization-id`, the `anthropic-ratelimit-*` headers) behind Cloudflare | `02`–`04` |
| Auth | **Bearer works** (`Authorization: Bearer`, the SDK's `ANTHROPIC_AUTH_TOKEN`). **`x-api-key` also works**: every design run authenticated with `ANTHROPIC_API_KEY`. The probe's first `x-api-key` call hit a 10 s TCP connect timeout (`UND_ERR_CONNECT_TIMEOUT`) before any answer, a one-off network failure rather than a refusal | `01`, `02`; `design-run-*/run.json` (`api_key_source`) |
| Extra headers | None needed (`ADP_HEADERS` empty) | `run.json` |
| Model names | Standard Anthropic IDs: `claude-opus-5-5` answers as itself. `/v1/models` lists 15, among them `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` | `02`, `06` |
| Streaming | 200, `text/event-stream`, the standard event sequence (`message_start` … `message_stop`) | `03` |
| Tool use | 200, `stop_reason: tool_use` with the expected input | `04` |
| `count_tokens` | Passes through: 200, 131 ms | `05` |
| Wrong key | 401 in 37 ms, in **ADP's own error format** (`code`, `message`, `details[{@type, reason, domain}]`), not Anthropic's | `07` |
| Unknown model | 403 `model_not_allowed`: "model … is not allowed for provider anthropic-api". ADP keeps an allowlist of models | `08` |
| Timeout | A 5 s client timeout surfaces as a client `TimeoutError` | `09` |
| Latency | About 6.8 s to the first byte for a one-word reply on Opus 5.5, and 3.3 s for tool use. In the design runs, calls took 24–43 s of API time over 16–19 turns | `02`–`04`; `design-run-*` |

What Claude Code sends, from the fake run: one streaming `POST /v1/messages` with the headers `anthropic-beta`, `anthropic-dangerous-direct-browser-access`, `x-app`, `x-claude-code-session-id`, `x-client-app` and `x-stainless-*`. ADP tolerated all of them in the real runs.

## 2. The SDK inside the extension host (AC 2)

- **Loading.** The SDK is ESM only. A CommonJS extension loads it with a dynamic `import()` in about 90–100 ms.
- **Start-up.** From `query()` to the first stream message takes about **0.28–0.32 s** in all three runs.
- **Platforms.** Linux x64 was run. macOS and Windows were not (Windows waits for story 1).
- **Package size: the main cost.**
  - The spike's production dependencies are about 450 MB. About 378 MB of that is the per-platform `claude` binary. There are 8 platform packages, each 360–384 MB.
  - `vsce package` with dependencies on linux-x64 is **178 MB**, against 53 KB without them.
  - Shipping it needs one VSIX per platform, or a first-run download of the binary.
- **`env` replaces the whole environment.** The adapter has to build it. The spike passes:
  - `PATH`, `HOME`, `LANG`;
  - `ANTHROPIC_BASE_URL` and the key;
  - `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL`, all set to the ADP model so no background call names a model ADP refuses;
  - `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`;
  - `RPCN_BINARY`;
  - the `uv` and XDG folders, moved into the workspace.
- **Writes outside the workspace.** Left alone, Claude Code writes `~/.cache/claude-cli-nodejs`, and the binary's Snowflake driver writes `~/.cache/snowflake`. Pointing `XDG_CACHE_HOME` into the workspace keeps both inside it.

## 3. Skills as a plugin, and structured questions (AC 3)

- **Loading.** `plugins: [{ type: "local", path: <rpcn-skills> }]` loads `rpcn-skills` 0.1.0 with `rpcn-skills:rpcn-design`, `rpcn-skills:rpcn-author` and `rpcn-skills:rpcn-test`, even with `settingSources: []`. The init message also lists:
  - 16 skills bundled with Claude Code (`deep-research`, `dataviz`, `claude-api` and others);
  - 3 built-in plugins (`cc-plugin-agents-md`, `cc-plugin-privacy`, `cc-plugin-plugin-authoring`).

  The `skills` option only filters what the model may invoke.
- **Run 1** (`rpcn-skills` at `560f483`): `rpcn-design` ran Steps 1–4. It then wrote round 1 as a plain numbered list and stopped, as its rules then said. No design note was written. Five reads of the skill's own reference files asked for approval, because they're outside the workspace. The spike's hook now allows reads inside the skills checkout.
- **The change.** The skills project changed both skills from this spike's change request, in `888de77` "Design and Author ask through the host question tool when one is offered".
- **Run 2** (`888de77`, clean tree):
  - one `AskUserQuestion` call with 2 questions reached `canUseTool` as data: **Ordering** (No ordering (My pick) / Per customer_id / Overall) and **Duplicates** (No dedupe (My pick) / Dedupe on order id / API dedupes on id), 3 options each, single choice, each option described;
  - the failure target and delivery were settled by the request's "dead-letter topic", as the skill's rules say;
  - the answers were returned, and the skill **went on without stopping**;
  - it wrote `orders_to_api.design.md`, **`status: ready`**, with all 11 sections: a `redpanda` input, a `fallback` over `http_client` and a `redpanda` DLQ to `orders.dlq`, at-least-once, and 4 non-blocking picks;
  - it then ran its own handoff check;
  - 56 s, 19 turns.

## 4. In-process tools (AC 4)

- **The tool server.** It's `createSdkMcpServer` with **`alwaysLoad: true`**. Without that, Claude Code put both tools behind its tool search instead of the model's tool list.
- **`rpcn_componentFields`.** It runs the skills' own `rpcn_check.py fields` with `RPCN_BINARY` set to the binary the Pipeline Designer resolved, and returns its envelope with home paths and secrets masked. Its output equals the script's output for three components and two error cases (`check/offline.cjs`).
  - **Run 1** called it 4 times (`redpanda` input; `http_client`, `fallback` and `redpanda` outputs) instead of the skill's script.
  - **Run 2** never called it, and used the script 9 times.
  - **So the agent's use of a host tool varies between runs.**
- **`metrics_bottleneck`.** It finds the port of a running file through the Pipeline Designer's exported `run.portOf`, reads `/metrics` twice 2 s apart, and computes rows and the slowest component with the Designer's compiled `out/core/` metrics model.
  - **Run 3**, with `metrics_a.yaml` running, called it on the first turn: 5 rows, slowest `slow_one`, 0 errors.
  - The answer named `slow_one` (`pipeline.processors[0]`, its 5 ms `sleep`) correctly. 11 s, 3 turns, no approvals.

## 5. Approvals and boundaries

- **One rule for shell commands,** in the hook and `canUseTool` alike: `uv run` of an `rpcn_check.py` that resolves inside the skills checkout, with no shell metacharacters. Anything else asks.
  - The fake run checked this: a chained command asked and was denied, and an `rpcn_check.py` the agent wrote into the workspace asked and was denied.
  - In the real runs, all the skills' checks were allowed without asking: 8, 9 and 0 calls.
- **Writes.**
  - Outside the workspace: denied by the hook, in the fake run.
  - Inside it: they reach `canUseTool`. Run 2's design note asked, and the user allowed it.
- **No denials and no leaks.** No run was denied anything. No key, ADP host, header value or home path is in any capture.

## Amendments to AD-26

1. **Auth.** `ANTHROPIC_AUTH_TOKEN` (Bearer) or `ANTHROPIC_API_KEY` (`x-api-key`), chosen by a setting. Both work through ADP, and Bearer is the default.
2. **Errors.** The adapter maps ADP's own errors (401 with `details`, 403 `model_not_allowed`) and Anthropic's errors into the view's messages.
3. **Models.** The model setting offers what `/v1/models` lists. The haiku, sonnet, opus and small-fast model variables are all set to the chosen model.
4. **Environment.** The adapter builds the agent's whole environment, as §2 lists, and moves the `uv`, XDG and Claude Code config folders into the extension's storage or the workspace.
5. **Packaging.** One VSIX per platform, or a first-run download of the Claude Code binary. This is a decision for the epic. Expect about 180 MB per platform.
6. **Tools.** The tool server sets `alwaysLoad: true`.
7. **A stage writes its own artifact without asking.** The design note, the pipeline and its `.blobl`/`.env.example` files, and the test report, at the path the stage names inside the workspace. Every other write asks.
8. **Host tools are optional.** The agent may use `rpcn_*` tools or the skills' scripts. Both return the same envelope, so either is fine. If the extension needs its tools used reliably, the skills need a "prefer the host's `rpcn_*` tools" rule, through a change request to the skills project.
9. **The skills filter.** The `skills` option filters what the model may invoke, but bundled Claude Code skills and built-in plugins still load. Whether to hide them further is a decision for the epic.
10. **Latency.** Answers can take several seconds before the first token. The view shows a waiting state and the progress steps.

## Left open

- macOS and Windows: not run.
- The Author and Test stages through the SDK: not in this spike's scope.
- A first-run binary download versus per-platform VSIXs: an epic decision.
