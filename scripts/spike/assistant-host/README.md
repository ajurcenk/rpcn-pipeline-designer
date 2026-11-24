# Spike 65: the assistant host (throwaway, never shipped)

A small VS Code extension that embeds the Claude Agent SDK in the extension host and runs the
`rpcn-skills` plugin through the Redpanda ADP proxy. It answers spike 65's SDK, skills, questions and
tools questions; `scripts/spike/adp-probe.mjs` answers ADP's contract. The plan is
`_bmad-output/backlog/spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy-plan.md`; the
findings go in `…-findings/findings.md` beside it.

It is not part of the Pipeline Designer: it has its own `package.json` and lock file, the main
extension's `package.json`, lock file and `src/` are untouched, and `scripts/**` is in the main
`.vscodeignore`. Do not package or publish it. `node_modules/` and `out/` are git-ignored.

## The ADP file

`~/.config/rpcn-spike/adp.env`, a regular file you own, mode 0600 (`chmod 600`). Keys are read
case-insensitively:

```
ADP_BASE_URL=https://<the ADP Anthropic endpoint, without /v1>
ADP_API_KEY=<your test key>
# optional:
ADP_MODEL=claude-opus-5-5
ADP_HEADERS=X-Some-Header: value; X-Other: value
```

The command refuses a missing file, a symlink, a mode other than 0600, or a file without
`ADP_BASE_URL` / `ADP_API_KEY`, before any request. The key goes to the SDK only in its `env`
option (`ANTHROPIC_API_KEY`, sent as `x-api-key`; set the spike's setting `rpcnSpike.auth` to
`bearer` for `ANTHROPIC_AUTH_TOKEN` if the probe found only Bearer works). `ADP_HEADERS` become
`ANTHROPIC_CUSTOM_HEADERS`. Every model alias (`ANTHROPIC_DEFAULT_HAIKU_MODEL`, `_SONNET_`,
`_OPUS_`, `ANTHROPIC_SMALL_FAST_MODEL`) names the ADP model. The key, the ADP host and the header
values, and any 8-character or longer start of the key or of a header value, are never logged or
written; each run's leak self-scan checks it, and on a hit the run's capture files are deleted.

## Build

```bash
cd scripts/spike/assistant-host
npm install          # the SDK, pinned (0.3.329), and its platform binary
npm run compile      # tsc -> out/
```

`metrics_bottleneck` imports the main extension's compiled core (`<repo>/out/core/`, read-only).
If it is missing, run `npm run compile-tests` in the repository. The main extension's bundle
(`dist/extension.js`) comes from `node esbuild.js` there.

## Start the dev host with both extensions

VS Code 1.143.1 from the repository's `.vscode-test/`, the Pipeline Designer and this spike side by
side, a test workspace under `.cache/assistant-host/workspace/` (the agent writes only there; the
SDK's config goes to `<workspace>/.spike-65/claude-config`, and uv's cache, Pythons and tools and the
XDG data and cache folders to `<workspace>/.spike-65/`):

```bash
ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$ROOT/.cache/assistant-host/workspace" "$ROOT/.cache/assistant-host/extensions"
cp -rn "$ROOT"/.vscode-test/extensions/redhat.vscode-yaml-* "$ROOT/.cache/assistant-host/extensions/"
(cd "$ROOT" && node esbuild.js)
"$ROOT/.vscode-test/vscode-linux-x64-1.143.1/code" --new-window \
  --user-data-dir "$ROOT/.cache/assistant-host/user" \
  --extensions-dir "$ROOT/.cache/assistant-host/extensions" \
  --extensionDevelopmentPath="$ROOT" \
  --extensionDevelopmentPath="$ROOT/scripts/spike/assistant-host" \
  "$ROOT/.cache/assistant-host/workspace"
```

Then run **Spike: run the assistant** from the command palette. It asks for the design request
(default: "read orders from a topic and post them to an API; failures to a dead-letter topic") and
confirms before it calls ADP. Each run counts against the cap of 3 (`<workspace>/.spike-65/runs.json`).
Only run it when the user has said to.

What it does: `query()` with `model`, `env`, `plugins: [{ type: "local", path: ../rpcn-skills }]`,
`skills: ["rpcn-design", "rpcn-author", "rpcn-test"]`, `settingSources: []`, `persistSession: false`,
`cwd` the workspace folder, `canUseTool`, a PreToolUse hook and the in-process `rpcn` MCP server:

- `AskUserQuestion` reaches `canUseTool`; each question is a quick pick of its options (multi-select
  when asked, and "Other…").
- One Bash rule for the hook and `canUseTool`: `uv run <script> <subcommand> …` with no shell
  metacharacter, the script resolving to an `rpcn_check.py` inside the `rpcn-skills` checkout, is
  allowed; any other shell command asks you in a modal. The hook also allows the `rpcn` tools and
  denies writes outside the workspace.
- `mcp__rpcn__rpcn_componentFields` runs the skills' own `uv run …/rpcn_check.py fields <category>
  <component>` with `RPCN_BINARY` set to the binary the Pipeline Designer resolved, and returns its
  SCHEMA.md envelope as printed (masked). The skills' own calls get the same binary.
- `mcp__rpcn__metrics_bottleneck` reads a running file's `/metrics` twice (port from the Pipeline
  Designer's `run.portOf`) and returns compact rows and the slowest component, from the main
  extension's metrics model. Start the file with Run first.

Everything is recorded by shape in the "Spike: assistant host" output channel and in
`<workspace>/.spike-65/run-<n>-<time>/` (`events.jsonl`, `run.json` with the timings, the init
message, the result and a leak self-scan). Copy a run's folder to the findings'
`captures/design-run-<n>/`.

## Checks without ADP

Under xvfb (one run at a time; HOME is a fresh folder under `.cache/assistant-host/`, so your own
`adp.env` is never read):

```bash
node scripts/spike/assistant-host/check/offline.cjs   # the Bash rule, the capture log, fields parity with rpcn_check.py
X="env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a"
$X node scripts/spike/assistant-host/check/run-refusal.mjs             # refusals: missing, 0644, symlink, no key
$X node scripts/spike/assistant-host/check/run-refusal.mjs --fake-run  # the SDK against a fake Messages API on 127.0.0.1
```

The fake run scripts tool_use turns and checks each decision: an `AskUserQuestion` answered by a
scripted pick, an allowed `rpcn_check` call, a chained command and a workspace `rpcn_check.py`
(both ask, denied), a write outside the workspace (denied by the hook), both `rpcn` tools, a write
inside the workspace, a second run while the first is going (busy), and nothing new in HOME.
