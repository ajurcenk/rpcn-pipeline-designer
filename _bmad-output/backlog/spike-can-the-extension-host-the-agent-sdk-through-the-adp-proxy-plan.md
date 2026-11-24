---
title: 'Spike 65: can the extension host the Claude Agent SDK through the Redpanda ADP proxy?'
type: 'chore'
ticket: '65'
created: '2026-11-23'
status: done
baseline_revision: '233067d804dde7347eec4d4c578c93475999b32d'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/backlog/spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy.md
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - scripts/spike/metrics-probe.mjs
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-26 is proposed, not proven. Nobody has yet checked that:
- the Redpanda ADP proxy serves the Anthropic Messages API the Claude Agent SDK needs;
- the SDK runs inside a VS Code extension host, at what package size;
- `rpcn-skills` loads as a plugin and asks its questions in a form the extension receives as data;
- the extension can serve its own tools in process.

The assistant's epic waits for these answers.

**Approach:** Two throwaway pieces, then findings, then AD-26 amended.
- A repeatable contract probe for ADP.
- A small spike extension that embeds the SDK, loaded into the dev host beside the real extension.

The pieces are run against ADP only after the user says so. Spike code is kept for re-runs and never shipped.

## Boundaries & Constraints

**Always:**
- **The ADP file.**
  - Its details come only from `~/.config/rpcn-spike/adp.env`, a regular file the user owns, mode 0600. The probe and the spike extension refuse it otherwise.
  - Keys, read case-insensitively: `ADP_BASE_URL`, `ADP_API_KEY`, optional `ADP_MODEL` (default `claude-opus-5-5`) and optional `ADP_HEADERS` (`Name: value` pairs separated by `;`).
  - The key is never printed, logged, written to a file, put in argv, or put in a capture or the findings.
  - The SDK gets the key only through its `env` option.
- **Captures and findings record shapes:**
  - status codes;
  - header and field names;
  - event types;
  - token counts;
  - timings.

  They never record the key, the ADP host, or the request and response text beyond short redacted samples.
- **Cost cap:**
  - at most 3 full design runs;
  - at most 10 small contract calls per probe run;
  - each run on ADP only after the user says to run.
- **No changes to the main extension:** its `package.json`, `package-lock.json` and `src/` stay untouched. The spike extension has its own `package.json` and lock file under `scripts/spike/assistant-host/`.
- **Skills come from the local `../rpcn-skills` checkout**, with its commit recorded in the findings. The spike loads them read-only. A change to any skill is proposed to the user, and made only with their OK, in that project.

**Never:**
- Shipping the spike extension.
- Committing `node_modules`.
- Loading the user's own `~/.claude` configuration in the SDK (`settingSources: []`).
- Writing outside the dev host's test workspace.
- Floor (VS Code 1.100.0) runs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| File refused | `adp.env` missing, a symlink, not 0600, or missing `ADP_BASE_URL` / `ADP_API_KEY` | Probe and spike exit before any request, naming the file and the fix | exit non-zero |
| Contract happy path | valid file | Plain, streaming and tool-use `/v1/messages` calls recorded by shape; auth header and model name that work recorded; `count_tokens` status recorded | none |
| Contract errors | a wrong key (changed in memory only), an unknown model, a 5 s timeout | Each error's status and body shape recorded | not retried |
| SDK design run | one design request in the dev host | Init lists the three skills; `AskUserQuestion` reaches `canUseTool` with options (or the plain-text form is recorded); answers given; a `ready` design note in the test workspace | Run stopped and recorded on an SDK error or the cost cap |
| In-process tools | `rpcn_componentFields`, and `metrics_bottleneck` on a running local file | Each tool called by the agent; results in `SCHEMA.md`'s envelope (fields) or compact rows (bottleneck), masked | Tool errors returned to the agent, recorded |
| Boundaries | the agent asks for any other shell command, or a write outside the workspace | `canUseTool` asks (other shell) or denies (outside the workspace); recorded | none |
| Dry run | `--dry-run` (no network, no key) | Probe runs against a local fake Messages API; refusal, redaction and the shape recorder are checked | exit non-zero on a failed check |

## Decisions

- ADP details come from `~/.config/rpcn-spike/adp.env`, mode 0600 (the user, 2026-11-23).
- The SDK code lives in a separate spike extension, `scripts/spike/assistant-host/`, with its own `package.json`, loaded into the dev host beside the real extension (the user, 2026-11-23).
- The model is `claude-opus-5-5` (or the name `ADP_MODEL` gives), capped at 3 full design runs, each only after the user says to run (the user, 2026-11-23).
- Skills load from the local `../rpcn-skills` checkout, with its commit recorded (the user, 2026-11-23).

</frozen-after-approval>

## Code Map

- `scripts/spike/metrics-probe.mjs` and `scripts/spike/logs-probe.mjs` -- copy, do not import or change:
  - `readEnvFile` (its owner, mode and symlink checks, keys read case-insensitively);
  - `Redactor`, `shape` and `errInfo`;
  - `writeCaptures` and the `--dry-run` structure with a local fake server.
- New `scripts/spike/adp-probe.mjs` and `scripts/spike/adp-probe.sh` -- the contract probe, with plain `fetch` and no SDK:
  - auth tried as `x-api-key`, then as `Authorization: Bearer`;
  - `ADP_HEADERS` added to every call;
  - `anthropic-version` set.
- New `scripts/spike/assistant-host/` -- the spike extension:
  - its own `package.json`, with the `@anthropic-ai/claude-agent-sdk` dependency, pinned;
  - an activation command, "Spike: run the assistant", that reads `adp.env` (the same checks) and calls `query()` with `model`, `env`, `plugins: [{ type: "local", path: <../rpcn-skills> }]`, `skills: ["rpcn-design", "rpcn-author", "rpcn-test"]`, `settingSources: []`, `cwd` set to the workspace folder, `canUseTool`, and an in-process MCP server from `createSdkMcpServer`;
  - each stream message, question, approval and tool call logged by shape to its own output channel and to a capture file.
  - **`rpcn_componentFields`** runs `fields` on the binary the main extension resolved. That's `vscode.extensions.getExtension('ajurcenk.rpcn-pipeline-designer').exports.redpandaConnect`, always exported (`src/extension.ts:445`).
  - **`metrics_bottleneck`** finds a running file's port with the exported `run.portOf(uri)`, reads its `/metrics`, and computes the rows and the slowest component with the main extension's compiled core modules (`out/src/core/` metrics model, read-only import by relative path).
  - The metrics tab's feeds are exported only in test mode (`src/extension.ts:458`), so the spike reads the port directly.
- Dev host: start it with two `--extensionDevelopmentPath` arguments, the repository and `scripts/spike/assistant-host`. VS Code is 1.143.1 from `.vscode-test`.
- New `_bmad-output/backlog/spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy-findings/` -- `findings.md`, plus `captures/NN-<step>.json` and `run.json`.
- `architecture-rpcn-vscode-designer.md`, AD-26 -- amended from the findings by the orchestrator after the user's acceptance. Not by the implementer.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/spike/adp-probe.mjs` and `adp-probe.sh` -- the contract probe, with `--dry-run` against a local fake -- answers ADP's contract
- [x] `scripts/spike/assistant-host/` -- the spike extension (package, activation, the run command, the two tools, the capture log), plus a README with how to start the dev host with both extensions -- answers the SDK, skills, questions and tools questions
- [x] Measure: the spike extension's packaged size (`npx vsce package` there, or the size of its `node_modules` with and without the SDK, and of any bundled Claude Code binary, per platform), and the time from the run command to the first stream message
- [x] `--dry-run` of the probe passes, and the spike extension compiles and activates in the dev host with no `adp.env` (it refuses cleanly)
- [x] Stop before any ADP call, and report what is ready for the user to run

**Acceptance Criteria:**
- Given the spike pieces, when they are run with no `adp.env` or with `--dry-run`, then no network call is made and each check passes.
- Given the user's go, when the probe and up to 3 design runs execute, then the findings answer each question in the ticket's Approach with the captures that show it, and nothing in the repository holds the key or the ADP host.

## Implementation Notes

- The main extension's compiled core is at `out/core/`, not `out/src/core/` (`tsconfig.json` has `rootDir: src`); `npm run compile-tests` writes it.
- The SDK (0.3.329, pinned) is ESM only; the CommonJS spike loads it with a dynamic `import()`. Its `env` option replaces the subprocess environment, so the spike builds it: `PATH`, `HOME`, `LANG`, `ANTHROPIC_BASE_URL`, the key (`ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` with the spike setting `rpcnSpike.auth: bearer`), `ANTHROPIC_CUSTOM_HEADERS` from `ADP_HEADERS`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` set to the ADP model, `CLAUDE_CONFIG_DIR` and `UV_CACHE_DIR` under `<workspace>/.spike-65/`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `RPCN_BINARY` (the Pipeline Designer's resolved binary, so the skills' `rpcn_check.py` uses it too).
- `persistSession: false` is set too, so no transcript goes to `~/.claude/projects`.
- A design run's captures go to `<workspace>/.spike-65/run-<n>-<time>/` (the agent writes only in the workspace); copy them to the findings' `captures/design-run-<n>/`. The probe replaces only its own files in `captures/`.
- Offline checks beyond the plan: `scripts/spike/assistant-host/check/run-refusal.mjs` (the refusals in the dev host) and `--fake-run` (the whole `query()` path against a fake Messages API on 127.0.0.1), both with a fresh HOME so the user's `adp.env` is never read. The fake run's captures are in the findings' `captures/offline-fake-run/`.
- Fixture lines in the checks write the key as `adp_api_key=` (read case-insensitively), so the Verification grep finds only the README's placeholder.
- `findings.md` was not written by the implementer (the sub-agent harness refuses report files); its offline content is in the hand-off report.
- Review pass 1, patches 1–9 applied (no ADP call; `adp.env` not read):
  1. One Bash rule, `isRpcnCheckCall` (`src/extension.ts`), used by both the PreToolUse hook and `canUseTool`. A command is allowed only if it is `uv run <script> <subcommand> …` with no shell metacharacter (`; & | \` $ < > ( ) { } \ * ? ! [ ] ~ #`, or a newline). Anything else asks.
  2. In that rule, the script must resolve (normalised, symlinks followed) to an `rpcn_check.py` inside `SKILLS_DIR`. A copy the agent wrote into the workspace, a `..` path out of the skills, or a symlink all ask.
  3. `running` is claimed right after the synchronous file check, before the first await. The body moved to `runClaimed`, and `running` is released in a `finally`. The fake run checks that a second run during the first one's dialogs returns `busy`.
  4. The probe's `model_answered` comes from the first successful capture. The dry run checks it in all four cases, including Bearer-only.
  5. `Redactor.secretWithPrefixes` (probe and `src/capture.ts`) redacts every prefix of 8 or more characters of the key and of each `ADP_HEADERS` value. The self-scan also looks for the 8-character starts.
     - On a hit, the probe deletes its own capture files and exits 1. `CaptureLog.finish` deletes the run's folder, and the command reports `leak`.
     - The dry run has an `echoed-key-prefix` case: a non-`sk-` key whose start, and the header value's start, are echoed in an error. It also plants a scan hit to check the deletion and the non-zero exit. `check/offline.cjs` checks the same for the capture log.
  6. `UV_PYTHON_INSTALL_DIR`, `UV_TOOL_DIR`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` now point into `.spike-65`, next to `UV_CACHE_DIR`. They are passed to the SDK and to `rpcn_componentFields`'s `uv run`.
     - `XDG_CACHE_HOME` matters: Claude Code otherwise writes `~/.cache/claude-cli-nodejs`, and Redpanda Connect writes `~/.cache/snowflake` from its Snowflake driver.
     - The fake run now compares a recursive listing of HOME before and after the run and flags any new entry. The snapshot is taken after the Pipeline Designer has activated and settled for 5 s, because that extension's own binary calls also create `~/.cache/snowflake`.
  7. `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` are also set to the ADP model.
  8. `rpcn_componentFields` runs `uv run <SKILLS_DIR>/skills/rpcn-design/scripts/rpcn_check.py fields <category> <component>` with `RPCN_BINARY` set to the binary the Pipeline Designer resolved. It returns the printed envelope unchanged apart from masking. The TypeScript copy of `cmd_fields` is gone.
     - `check/offline.cjs` compares it with `tools/shared/rpcn_check/rpcn_check.py`: the sha1 of `data.fields` for `inputs generate`, `processors switch` and `outputs kafka_franz` (the same hashes as before), and the whole envelope and exit code for `inputs genx` (1) and `nope x` (2).
  9. The fake API in `--fake-run` scripts 8 tool_use turns and checks each decision:
     - `AskUserQuestion` reaches `canUseTool` as data with 2 options, and the scripted pick goes back in the tool result.
     - The skills' `rpcn_check.py binary` is allowed by the hook and runs.
     - A chained command and a workspace `rpcn_check.py` both ask and are denied.
     - A write outside the workspace is denied by the hook without asking.
     - `rpcn_componentFields` returns the envelope with 5 fields.
     - `metrics_bottleneck` loads `out/core` and reports "not running". `core()` now loads before the port check.
     - A write inside the workspace is allowed, and its note is found with `status: ready`.
- Also changed while doing the review patches:
  - The MCP server now uses `alwaysLoad: true`. Without it, the tools sat behind ToolSearch (`DeferredToolPlaceholder`) and were not in the model's tool list. The fake run checks they are there from the first request.
  - The capture log also redacts the repository path (`<repo>`) and the account's home taken from `os.userInfo()` (`~`), as well as `$HOME`.
  - `counts.files_written` is renamed `write_attempts`: it counts tool_use attempts, denied ones included.
  - New check, `check/offline.cjs`: the Bash rule cases, the capture log, and fields parity.
- The fake run's captures in the findings' `captures/offline-fake-run/` are refreshed. There are now 9 main-loop turns, `query()` to init takes about 290–316 ms, and the folder holds no key, header value or `/home` path.

- ADP runs (2026-11-24, the user's go): the probe (9 calls) and design runs 1–3 ($0.97 in all, every leak scan clean). Run 1 stopped at plain-text questions. The skills project then changed both skills from this spike's change request (`888de77`), with no direct edit here. Run 2 got structured questions and a `ready` note. Run 3 called `metrics_bottleneck` on a running file. The orchestrator wrote `findings.md` and copied the runs' captures to `captures/design-run-1…3/`. Spike-side fix after run 1: reads inside the `rpcn-skills` checkout are allowed by the hook.
- Verification (orchestrator, 2026-11-24): the probe's `--dry-run` passes; `npm run compile` and `check/offline.cjs` pass in `assistant-host`; no home path, key or host in `captures/`; the main extension's `src/`, `package.json` and lock file are unchanged; `node_modules` is ignored.

## Review Triage Log

**Pass 1 (quick, before any ADP call):** high 1, medium 6, low 3, false 0, maybe-false 0. Routes: 9 patch, 1 rejected. The orchestrator writes `findings.md` (the implementer's harness refused it).

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `canUseTool` allows any Bash command matching `RPCN_CHECK`, so a chained command (`…; curl … \| sh`) the hook declines is then approved without asking | high | patch | Confirmed: `extension.ts:129` lacks the hook's metacharacter test (`:112`). This breaks the Boundaries row of the Matrix. Fix: one shared predicate for the hook and `canUseTool`, and a fake-run turn with a chained command. |
| 2 | `RPCN_CHECK` accepts an `rpcn_check.py` in any directory, including one the agent wrote into the workspace | medium | patch | Confirmed (`\S*`). Fix: require the script to be under the skills' own directory (`SKILLS_DIR`), resolved and normalised. |
| 3 | The `running` guard is set only after the dialogs and activation, so a second run can start in the gap and spend the cap | low | patch | Confirmed (`:54` vs `:98`). Fix: claim the run before the first await, and release it on every exit. |
| 4 | `model_answered` is `null` when only Bearer works (`a1` is never nullish) | low | patch | Confirmed (`adp-probe.mjs:292`; the dry run's bearer-only case shows `null`). Fix: take the first successful capture, and a dry-run check on the field. |
| 5 | A key prefix echoed by ADP in an error can reach a capture: only the full key is redacted, and the self-scan runs after the files are written and leaves them | medium | patch | Confirmed by reading. Fix: redact any 8+ character prefix of the key before writing, and on a scan hit delete the run's files and exit non-zero, in both the probe and the extension's capture log. |
| 6 | `uv run` can write outside the workspace (managed Python, tools, data under HOME) | medium | patch | Plausible: only `UV_CACHE_DIR` and `CLAUDE_CONFIG_DIR` are moved. Fix: also set `UV_PYTHON_INSTALL_DIR`, `UV_TOOL_DIR` and `XDG_DATA_HOME` (and `XDG_CACHE_HOME`) into `.spike-65`, and extend the fake run's HOME check to any new entry. |
| 7 | Only the haiku and small-fast model variables point at the ADP model, so a `sonnet` or `opus` alias asks ADP for a model it may not serve | medium | patch | Plausible (the `Agent` tool is listed). Fix: also set `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` to the ADP model. |
| 8 | `rpcn_componentFields` reimplements `rpcn_check fields` in TypeScript and already differs (no category list, no 4.100.0 floor check) | medium | patch | Confirmed by the reviewer against `cmd_fields`. The plan says the tool "runs `fields`", and AD-26 lists a second copy that disagrees under Prevents. Fix: the tool runs the skills' own `rpcn_check.py fields` with `RPCN_BINARY` set to the binary the main extension resolved, and returns its envelope unchanged. |
| 9 | The fake run never exercises questions, approvals, the hook or the two tools | medium | patch | Confirmed (`run.json`: all counts 0). Fix: fake turns that return `tool_use` for an `AskUserQuestion`, an allowed `rpcn_check` call, a chained Bash command, a write outside the workspace and both MCP tools, each with its expected decision checked. |
| 10 | The Verification grep also matches the plan's own line | low | reject | The plan's check line names the string itself. That is no leak; the grep's only real match outside the plan is the README placeholder. |
| — | Measurements and the init's extra skills and plugins are not recorded | — | orchestrator | The figures are in the implementer's report. The orchestrator writes them into `findings.md`, with the 16 bundled skills, the 3 built-in plugins and the dirty skills commit noted. |

## Verification

**Commands:**
- `node scripts/spike/adp-probe.mjs --dry-run` -- expected: all checks pass, no network
- `cd scripts/spike/assistant-host && npm install && npm run compile` -- expected: compiles
- the dev host with both extensions, the "Spike: run the assistant" command with no `adp.env` -- expected: refusal naming the file, no request
- `git status --short` -- expected: no change under `src/`, `package.json` or `package-lock.json`; no `node_modules` staged
- `grep -rn "ADP_API_KEY=" scripts _bmad-output` -- expected: only the README's placeholder line

## Acceptance

- 2026-11-24, the user: accepted the findings (`spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy-findings/findings.md`). AD-26 was amended from them and moved to adopted.
