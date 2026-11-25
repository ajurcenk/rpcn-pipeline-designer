---
title: 'Story 8.1: tracer bullet — from a request to a ready design note in the assistant view'
type: 'feature'
ticket: '1'
created: '2026-11-24'
status: done
baseline_revision: 'f13b51248166ad822a0f7ecc5f518c794aac60be'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment', 'quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-rpcn-ai-assistant/epic-rpcn-ai-assistant.md
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - _bmad-output/backlog/spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy-findings/findings.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The extension has no assistant. Spike 65 proved the pieces in a throwaway extension. Nothing in the Pipeline Designer yet connects a view, AD-26's host port, the embedded Agent SDK, the bundled skills and the user's endpoint.

**Approach:** The thinnest path through every AD-26 layer, built for real in the Pipeline Designer and ported from the spike (`scripts/spike/assistant-host/`):
- **The port and the adapter.** An `AssistantHost` port, then an `AgentSdkHost` adapter. It runs `query()` on the pinned SDK with:
  - the model, base URL and key;
  - the built environment;
  - the bundled skills as a plugin;
  - `settingSources: []`;
  - `cwd` set to the workspace folder;
  - an in-process tool server, empty for now (`alwaysLoad`);
  - a pre-tool hook and `canUseTool`.
- **Minimal access.** The settings, plus a command that stores the key in secret storage.
- **A plain assistant view.** A request runs `rpcn-design`. Each `AskUserQuestion` shows as cards that can be answered, with the pick first and an Other text answer. Progress lines appear as the run goes. The note that was written shows with its `status`.
- **Two test fakes,** which every later story reuses:
  - a scripted in-memory `AssistantHost`;
  - a local fake Messages API with scripted turns.

## Boundaries & Constraints

**Always:**
- **Layering.** `AssistantHost`, its event types and the fakes' scripts have no `vscode` or SDK import. Put them in `src/adapters/assistant/` (port and adapter) and `src/shared/assistantProtocol.ts` (view messages), and add an eslint block that keeps `vscode` out of `src/adapters/assistant`. The vscode glue goes in `src/adapters/vscode/assistant*.ts`.
- **The SDK.**
  - `@anthropic-ai/claude-agent-sdk` is pinned exactly at 0.3.329, with `zod`, in the root `package.json`.
  - It is external in `esbuild.js`, and loaded with a dynamic `import()` the way `platformaticReader.ts` loads its ESM module.
- **Access.**
  - The settings are `redpandaConnect.assistant.model` (default `claude-opus-5-5`), `redpandaConnect.assistant.baseUrl` and `redpandaConnect.assistant.auth` (`bearer` or `x-api-key`, default `bearer`).
  - The key is in secret storage only, under `redpandaConnect.assistant.apiKey`.
  - It reaches the agent only through `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` in its environment.
  - It is added to the output channel's global mask.
- **The environment** is the whole list in AD-26:
  - `HOME`, `PATH`, `LANG`;
  - `ANTHROPIC_BASE_URL` and the key;
  - the four model variables, all set to the chosen model;
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `DISABLE_AUTOUPDATER`;
  - `RPCN_BINARY`, from the binary AD-9 resolved;
  - `CLAUDE_CONFIG_DIR` and the `uv` and XDG folders, under the extension's global storage.
- **Boundaries in this story** (story 8.5 completes them), ported from the spike:
  - `uv run` of an `rpcn_check.py` inside the bundled skills, with no shell metacharacters, is allowed;
  - reads inside the bundled skills are allowed;
  - writes outside the workspace are denied;
  - anything else asks through a modal.
- **Stage from files.** The note shown and its status come from the file on disk: `<name>.design.md` in the workspace, its frontmatter `status`.
- **Tests:**
  - No automated test calls a real model endpoint.
  - The integration suites use the scripted fake host and the fake Messages API.
  - Real calls only in the user's manual check, at most 2 runs.
- **No edits to `rpcn-skills`.** A needed change becomes a change request to that project.

**Never:**
- Assistant access completed, meaning the model list, Test connection, Forget and the access states (story 8.3).
- Packaging and the VSIX (8.2).
- The `rpcn_*` tools (8.4).
- The full Design screens (8.6).
- A key, header value or home path in a setting, file, argument, log or posted message.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path, fake model | key set, fake Messages API scripts the skill invocation, its checks, one `AskUserQuestion` with 2 questions, then a Write of the note | View shows the progress lines, then 2 question cards (pick first); answering sends them back; the note appears with `status: ready` | none |
| Happy path, fake host | the scripted `AssistantHost` emits progress, question, fileWritten, result | Same view states, without the SDK | none |
| No key | no key in secret storage | The view says assistant access isn't set up and offers the set-up command; nothing starts | none |
| No binary | the binary state isn't `ok` | The view says the assistant needs Redpanda Connect; nothing starts | none |
| Agent error | the fake Messages API answers 401 or the SDK throws | The view shows a masked error line; the run ends; a new request works | logged masked |
| Stop | Stop while the run waits on a question or a model turn | The run is aborted; the view shows it stopped; nothing more is written | none |
| No leak | after the happy path on the fake model | The key and header values aren't in settings, global storage files, posted messages or the output channel | the test fails |

## Decisions

- The bundled skills are a vendored, read-only copy committed under `assets/rpcn-skills/` (`skills/` and `.claude-plugin/` only), with the pinned commit in `assets/rpcn-skills/PIN`. `scripts/sync-rpcn-skills.mjs` refreshes the copy from a given ref of a local `rpcn-skills` checkout. It's a copy, never an edit to the skills project (the user, 2026-11-24).
- The pin is `3afb844`, the skills checkout's newest commit, which includes `888de77`'s question-tool change (the user, 2026-11-24).

</frozen-after-approval>

## Code Map

- **Port from the spike** (`scripts/spike/assistant-host/src/`):
  - `extension.ts`: `isRpcnCheckCall` (:41-51), `isInside` (:244-254), the hook and `canUseTool` (:145-177), the env build (:179-198), the `query()` options (:201-215), `askUser` (:257-278), the design-note status parse (:322-338);
  - `tools.ts`: `toolServer` with `alwaysLoad` (:150-186). Keep the server with no tools in 8.1;
  - `capture.ts`: `Redactor` (redaction for logs);
  - `check/fake-run.cjs`: the fake Messages API (:50-106: SSE, scripted `tool_use` turns, `count_tokens`, 404 elsewhere). Port it to `src/test/helpers/fakeMessagesApi.ts` in the `fakeCloud.ts` style (`http.createServer`, `listen(0,'127.0.0.1')`, `url`, `requests[]`, `stop()` with `closeAllConnections`).
- **View pattern** from `src/adapters/vscode/metricsPanel.ts`:
  - `register()` (:234-239), `resolveWebviewView` (:310-347), and `receive(raw)` as the test seam;
  - the posted messages capped;
  - `webviewHtml` (`src/adapters/graphPanel/html.ts:33`), and the `ready`-then-whole-state protocol of `src/shared/metricsProtocol.ts` (:147, :176, :574 parser).
- **Webview:** a new `webview/src/assistant/{host.ts,main.tsx,AssistantView.tsx,assistant.css}`, as for metrics, with tests in `AssistantView.test.tsx` (happy-dom, `vscodeStub.posted`).
- **Build:** `esbuild.js`. Add the `assistant` webview context (:150-165 pattern), and mark `@anthropic-ai/claude-agent-sdk` external in the extension bundle (:93-106; mind the `import.meta.url` define).
- **package.json:**
  - `viewsContainers.activitybar` gets a new `redpandaConnectAssistant` container, icon `$(sparkle)`;
  - `views` gets `{type:"webview", id:"redpandaConnect.assistant"}`;
  - commands: `redpandaConnect.assistant.setUpAccess` ("Set up assistant access…") and `redpandaConnect.assistant.run`, hidden from the palette;
  - the three `redpandaConnect.assistant.*` settings.
- **Secrets and masking:**
  - the set-up flow follows `cloudMetrics.ts:221-300` (a password box, stored only once given, Escape stores nothing, a `SetUpGuard`-style one-at-a-time rule);
  - masking uses `maskCredentials` (`src/adapters/cloud/errors.ts:131`);
  - the assistant key is added to the global mask in `extension.ts:228-232`.
- **Binary:** `RedpandaConnect.state` (`src/adapters/redpandaConnect/binary.ts:29-47, :324`). When `invocation` is `[rpk, 'connect']`, check how `rpcn_check` treats `RPCN_BINARY` pointing at `rpk`. If it can't run `rpk connect`, record that as a change request for the skills project. Don't edit them.
- **Wiring:** `src/extension.ts` as at :320-333, plus a test-mode seam on `ExtensionApi` (:95-135, exported only in `ExtensionMode.Test`):
  - `assistant?: { view, setHostFactory(factory), setAccessForTest(...) }`;
  - the host factory lets the suites swap in the fake host;
  - the SDK path in tests points `baseUrl` at the fake Messages API.
- **Tests:**
  - a new suite `src/test/integration/suites/99c-assistant.ts`, imported after 99b in `src/test/integration/index.test.ts`;
  - `waitFor` and `userFilesHolding` (`helpers.ts:21, :142`) for the no-leak check;
  - unit tests for the port's event mapping, the shell and path rules and the env build, under `src/test/adapters/assistant/`.
- **The skills copy:** `assets/rpcn-skills/`, pinned at `3afb844` (Decisions). The adapter's plugin path and the shell rule point there; `scripts/**` is excluded from the VSIX by `.vscodeignore`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/assistant/host.ts` -- the `AssistantHost` port and its event types (no vscode or SDK import), plus `rules.ts` (shell and path rules, ported) and `env.ts` (the environment build) -- the boundary later stories extend
- [x] `src/adapters/assistant/agentSdkHost.ts` -- the adapter: dynamic SDK import, `query()` options as AD-26, stream to events, `AskUserQuestion` through `canUseTool` to `question` events with answers returned, the pre-tool hook, an empty `alwaysLoad` tool server, abort -- the tracer's agent layer
- [x] `src/shared/assistantProtocol.ts`, `webview/src/assistant/*`, `esbuild.js` -- the protocol (with a parser for unknown input), the plain view (request box, progress lines, question cards with pick first and Other, note with status, Stop, error line) and its bundle -- the tracer's UI
- [x] `src/adapters/vscode/assistantView.ts`, `src/adapters/vscode/assistantAccess.ts`, `package.json`, `src/extension.ts` -- the provider, the minimal access (settings, set-up command, secret, mask), the wiring and the test seam -- connects the layers
- [x] `package.json` / `package-lock.json` / `.vscodeignore` / `eslint.config.mjs` -- the pinned SDK and zod, the eslint block for `src/adapters/assistant` -- dependencies and layering
- [x] `assets/rpcn-skills/` (copy, `PIN`) and `scripts/sync-rpcn-skills.mjs` (copy `skills/` and `.claude-plugin/` at a ref with `git archive` from a local checkout, write `PIN`, refuse a dirty or missing ref) -- the bundled skills the adapter loads; check `.vscodeignore` doesn't exclude `assets/`
- [x] `src/test/helpers/fakeAssistantHost.ts`, `src/test/helpers/fakeMessagesApi.ts`, `src/test/integration/suites/99c-assistant.ts`, `src/test/adapters/assistant/*.test.ts`, `webview/src/assistant/AssistantView.test.tsx` -- the two fakes and the tests for every row of the Matrix -- reused by every later story

**Acceptance Criteria:**
- Given the dev host with the user's endpoint and key, when the user asks for spike 65's run 2 request, then the question cards appear, and answering them writes a `ready` note shown in the view. This is the manual check, at most 2 runs.
- Given the full stable suite, when it runs, then all pass with no real model call, and no existing test's expected values change.

## Implementation Notes

- **Port and events.** `src/adapters/assistant/host.ts` (port, events, `questionsOf`), `events.ts` (stream → progress, `result`/`error`, `api_retry`), `rules.ts`, `env.ts`; `agentSdkHost.ts` is the adapter. `fileWritten` comes from a PostToolUse hook on the write tools. A `result` event carries `stopped` for a cancelled run.
- **Writes inside the workspace.** The spike allowed every write inside the workspace in `canUseTool`. Here only a `Write` of a `*.design.md` inside the workspace is allowed without asking (the stage's own artifact, AD-26); any other write inside asks through the modal, and writes outside are denied by the hook.
- **A 401/403 ends the run at once.** Claude Code retries a 401 ten times over about 175 s (measured against a local fake). The adapter reads the SDK's `system/api_retry` message: a 401 or 403 becomes the run's `error` and the run is aborted; other retries are progress lines. No retry variable was added to the environment (the AD-26 list is unchanged, plus `NO_COLOR`).
- **Settings scope.** The three `redpandaConnect.assistant.*` settings are `application` scope, so a workspace cannot point the key at another endpoint. `baseUrl` defaults to `https://api.anthropic.com`.
- **Stage from files.** `src/core/designNote.ts` reads the frontmatter `status` (no YAML import, AD-2); the view reads the written note from disk on `fileWritten` and at the run's end.
- **`HeadersInit`.** The SDK's types pull in `@modelcontextprotocol/sdk`, which names the DOM's `HeadersInit`; `src/adapters/assistant/headersInit.d.ts` declares it as `undici-types`' type (no `skipLibCheck`).
- **Test seam.** `ExtensionApi.assistant` (test mode only): `view`, `access`, `setHostFactory`, `setAccessForTest({ key, model, baseUrl, auth, binary, workspace })`. The stable run opens no folder, so the suite holds a temp folder as the workspace and an `ok` state on a fake binary.
- **`rpk` as `RPCN_BINARY`.** `rpcn_check.py` runs a binary whose name is `rpk` as `rpk connect` (its `_argv_for`), so `RPCN_BINARY` set to the resolved `rpk` path works. No change request is needed. One limit: a binary whose name is not exactly `rpk` but which runs as `rpk connect` (for example a renamed copy set through `binaryPath`) would be run directly by `rpcn_check`.
- **The skills copy.** `assets/rpcn-skills/` at `3afb844ec262012f168f6d7cf0e07294ffe0a92f`. The local skills checkout had uncommitted changes in `skills/`, so the copy was synced from a clean clone of it. The sync script refuses uncommitted changes only in `skills/` and `.claude-plugin/`, the parts it copies.
- **Packaging.** The SDK is external and `node_modules/**` is still in `.vscodeignore`, so a VSIX built today has no SDK: a run would end with an error line. Story 8.2 ships it.

**Review pass 1, the patch rows (1–26):**
- **1, 18: the shell rule.** `isRpcnCheckCall` needs an absolute script path. Every argument that is a path (absolute, or with `/` or `..`, an option's `=` value too) must resolve inside the workspace or the skills copy; otherwise the call asks.
- **2: one run at a time.** `run()` claims the run before its first await and releases it on every exit.
- **3, 15: base URLs.**
  - `usableBaseUrl` accepts `https:`, or `http:` only on `localhost`, `127.0.0.1` or `[::1]`, with no user or password.
  - The key's base URL is stored beside it (`redpandaConnect.assistant.apiKeyBaseUrl`, secret storage). A different setting gives the `baseUrlChanged` state (set up again), and nothing is sent.
  - An unusable URL gives `badBaseUrl`, with Open settings (`openSettingsRequested`).
  - Set up refuses to run on an unusable URL.
- **4: Stop.** The request box and Stop render whenever a run goes, with the access panel above them if access changed.
- **5: open questions and approvals by id.**
  - The status is `approval` while any approval is open, else `question` while any question is. The oldest question's cards are shown.
  - The port gains a `withdrawn` event: the SDK aborting one permission request's signal withdraws its card or approval.
- **6: pass-through variables.** `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (either case), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `TMPDIR` pass through when set (`PASS_THROUGH`). The view now hands `process.env` to the env build, which takes only the listed names.
- **7: `noUv` state.** `uv` is looked up on `PATH` before a run (seam: `setAccessForTest({ uv })`).
- **8: idle timeout.** No message from the agent for 5 minutes ends the run with an error line. The timer is paused while a question or an approval waits on the user. Seam: `view.idleTimeoutMs`, passed as `AssistantHostConfig.idleTimeoutMs`.
- **14: home mask.** `maskHome` replaces the home folder only as a whole path prefix.
- **16: SDK import.** A rejected import is no longer cached (`loadSdk` takes an importer, for its unit test).
- **17: short keys.** A key under 8 characters is refused at set up.
- **19: note status parser.** An unclosed frontmatter has no status. A quoted value keeps a `#` inside its quotes.
- **20: answers by index.** The `answered` message carries `answers: string[]`, one per card in order. The host maps them back to the original (unmasked) question texts.
- **23: request limit.** `assistant.run` applies `MAX_REQUEST_CHARS`.
- **24: teardown.** The teardown asserts that the run ended after Stop.
- **25: sync script.** It stages the full copy beside `assets/rpcn-skills`, then swaps it in by renames.
- **26: small leftovers.** The abort listener of `wait()` is removed once the wait settles, and NotebookEdit has its progress label.
- **Tests added (9–13, 20–22 and the fixes above).**
  - Integration:
    - two runs at once;
    - `badBaseUrl` and `baseUrlChanged`, then set up again;
    - `noUv` and NO_WORKSPACE;
    - two approvals and two questions plus a withdrawn one (fake host);
    - home masking and answers by index;
    - which `fileWritten` is the note;
    - the global output mask, with the key in a Run log line;
    - an allowed approval, x-api-key end to end with the leak scan, and the idle timeout and its pause on a question (fake model).
  - The leak scan now checks the whole key, its first and last 16 characters and every 12-character slice.
  - The secret-storage test reads the stored values back. The rpcn_check result must be a successful envelope.
  - Unit tests: path arguments, relative script, pass-through, the parser fixes, `maskHome`, `usableBaseUrl`, `loadSdk` retry, the idle text.
  - Webview tests: answers by index, Stop under another access state, the new states' panels.
- **The test key.** The first full run after these fixes failed the slice scan as a false positive: the old test key `adpfake-assistant-key-…` shares `-assistant-k` with the suite's temp folder (`rpcn-assistant-k…`), which Claude Code writes into its MCP logs as the `cwd`. The test key is now a random-looking 32-character string.
- **`zod` (row 34).** It isn't imported in 8.1. It stays a dependency as the SDK's peer (`zod ^4`), needed at run time.

- Verification by the orchestrator (2026-11-24, after the review patches): compile and lint clean; test:webview 435 passed; test:corpus 182 passed; the vscode-import grep (including `src/adapters/assistant`) is empty; full stable twice in a row: 1820 passing, 1 pending, each; multiroot 15 passing. No real model call.

## Review Triage Log

**Pass 1 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment, quick):**
- Verdicts: high 2, medium 11, low 16, false 3, maybe-false 0.
- Routes: 25 patch, 6 defer, 6 rejected.
- Duplicates across lenses are merged into one row.
- Verified in the code: `assistantView.ts:269-305` (the busy check comes before two awaits), `assistantAccess.ts:50` (`http:` accepted), `rules.ts:63-83` (no argument path check), `assistantView.ts:177` (`split(home)`), `agentSdkHost.ts:29-34` (a rejected import is cached), `AssistantView.tsx:141` (Stop is inside the ready branch).

| # | Finding (lens) | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The `rpcn_check` rule allows absolute paths anywhere in its arguments, e.g. `lint /home/u/.aws/credentials` (blind) | high | patch | Confirmed: `isRpcnCheckCall` checks only the script. Fix: every argument that is a path (absolute, or containing `/` or `..`) must resolve inside the workspace or the active skills copy, else the call asks. Tests: an absolute path outside, `..`, and one inside. |
| 2 | Two runs can start at once (the busy check comes before awaits), leaving the first orphaned and unstoppable (edge, quick) | high | patch | Confirmed. Fix: claim the run (a `starting` flag) before the first await, and release it on every exit. Test: two `run()` calls together, the second returns `busy`. |
| 3 | `http:` base URLs are accepted; changing `baseUrl` sends the stored key to the new host unconfirmed (blind) | medium | patch | Confirmed. Fix: `https:` only, with `http:` allowed for loopback only. The stored key records the base URL it was set up for, and a different setting gives a distinct state ("the base URL changed; set up access again"), with nothing sent. Tests. |
| 4 | Stop disappears when access changes mid-run (edge, quick) | medium | patch | Confirmed (`AssistantView.tsx:141`). Fix: Stop renders whenever a run is going, whatever `access` says. Webview test. |
| 5 | Parallel approvals or a second question overwrite one status slot; a permission request aborted by the SDK leaves stale cards (blind, edge) | medium | patch | Confirmed by reading. Fix: open questions and approvals tracked by id. Status is `approval` while any is open. An abort of a request's signal removes its card or approval. Tests on the fake host: two approvals and two questions. |
| 6 | Proxy and CA variables are dropped from the agent's environment (blind, edge) | medium | patch | Confirmed (`env.ts`). ADP users behind a proxy can't connect. Fix: pass through `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (either case), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `TMPDIR` when set. Unit test. |
| 7 | A missing `uv` isn't checked before a run (blind) | medium | patch | Fix: a `noUv` access state ("The assistant needs uv on the PATH to run the skills' checks"), checked before starting. Test. |
| 8 | No limit on a stalled run (blind) | medium | patch | Fix: an idle timeout. No message from the SDK for 5 minutes aborts the run with an error line saying so. Test with a short timeout through a seam. |
| 9 | Allow in an approval is never tested (verification) | medium | patch | Add a fake-model test where the approval returns true for a non-note Write: the file exists, the result isn't an error, progress shows Allowed. |
| 10 | The x-api-key path is never tested end to end (verification, quick) | medium | patch | Add an x-api-key fake-model run: an `x-api-key` header, no `authorization`, and the NO_LEAK scan run for it. |
| 11 | The leak scan checks only the whole key and its first 16 characters (quick) | medium | patch | Also check the last 16 characters and any 12-character slice of the key. |
| 12 | The global output mask isn't verified apart from the view's own masking (verification) | medium | patch | Test: a log line from a non-assistant component that contains the key appears masked in `outputLines()`. |
| 13 | The home mask is never exercised (verification) | medium | patch | Fake-host test: progress and an error containing the home folder arrive as `~/…`. |
| 14 | The home mask replaces substrings (blind, quick) | low | patch | Fix: replace the home folder only at a path boundary (`home + sep`, or the end of the text). Unit test with `/home/u` vs `/home/user2`. |
| 15 | A key with a stored URL that's unusable shows the no-access text (blind, edge) | low | patch | Fix: a distinct `badBaseUrl` state with its own text and action (open settings). Test. |
| 16 | A rejected SDK import is cached (edge) | low | patch | Reset `loading` on rejection. Unit test. |
| 17 | A key under 4 characters is never masked (edge) | low | patch | The set-up input refuses a key under 8 characters. |
| 18 | A relative script path is allowed (edge) | low | patch | The auto-allow requires an absolute script path. |
| 19 | The design-note status parser: an unclosed frontmatter, and a quoted value with `#` (edge) | low | patch | Fix both. Unit tests. |
| 20 | Questions with the same (masked) text collide (edge, quick) | low | patch | Key choices and answers by question index, mapped back by index. Tests, including a question with a home path whose answer comes back under the original text (verification). |
| 21 | Which `fileWritten` counts as the note isn't tested with other files (verification) | low | patch | Fake-host test: a write of `orders.yaml`, then the note, then a note outside the workspace; the view keeps the workspace note. |
| 22 | Weak tests: the secret-storage test compares a constant; "rpcn_check ran" only checks it wasn't denied; the NO_WORKSPACE row has no integration test (blind) | low | patch | Read the secret through the seam; assert the check's tool result is a successful envelope; add the NO_WORKSPACE test. |
| 23 | The `assistant.run` command bypasses the request length limit (edge) | low | patch | Same limit as the webview parser. |
| 24 | The test teardown's `waitFor(!running)` result isn't asserted (edge) | low | patch | Assert it. |
| 25 | The sync script can leave a half-copied `assets/rpcn-skills` (edge) | low | patch | Copy to a temp folder, then swap it in. |
| 26 | Small leftovers: wait() abort listeners never removed; no NotebookEdit progress label (blind) | low | patch | Remove the listeners on settle; add the label. |
| 27 | A space in the skills path makes every check ask (edge) | low | defer | The skills path is the extension's install folder, normally without spaces. Goes to 8.5 (boundaries). |
| 28 | Multi-root: the first folder is taken silently (blind) | low | defer | Goes to 8.6 (the Design stage, complete). |
| 29 | Windows environment variables, and `rpk.exe` (blind, edge) | low | defer | Windows is out of scope (backlog story 1). |
| 30 | Stop doesn't close an open approval modal (blind) | low | defer | VS Code can't close a modal message box programmatically. 8.5 moves approvals into the view. |
| 31 | No test renders the webview fed by the real host (intent) | low | defer | The shared protocol and its parser connect the two halves. A cross-check goes to 8.6. |
| 32 | No cost limit per run (blind) | low | defer | Cost is capped by the idle timeout (#8) and `maxTurns`. A budget setting goes to 8.6 if the SDK offers one. |
| 33 | The SDK isn't in the packaged VSIX (blind, edge, verification) | — | reject | Deferred by the plan to 8.2 (Never list), and recorded as a risk. |
| 34 | `zod` isn't imported (blind) | — | false | It's the SDK's peer dependency (`zod ^4`), needed at run time. A comment beside it in `package.json` isn't possible (JSON), so it's noted in Implementation Notes. |
| 35 | The vendored skills copy isn't in the diff (blind, intent) | — | false | It was left out of the review diff on purpose, as a vendored copy. It's on disk, with its `PIN`. |
| 36 | Any `*.design.md` in the workspace can be written, overwriting a note (blind) | — | reject | By design (AD-26: a stage writes its own artifact). The skill's own Step 2 asks before updating an existing note. |
| 37 | `AgentSdkHost.start`'s guard is unreachable (blind) | — | reject | A harmless defensive check on the port's contract. |
| 38 | AC 1 has no manual evidence yet (quick) | — | reject | Not a defect: the manual check comes after the review, by the user. |

## Verification

**Commands:**
- `npm run compile` (lint included) -- expected: no errors
- `npm run test:webview` and `npm run test:corpus` -- expected: all pass
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics src/adapters/assistant` -- expected: no output
- `npm run compile-tests`, then `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 900 xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|assistant"` -- expected: the new tests pass
- the full stable suite, twice, and `--label multiroot` -- expected: all pass. Run one at a time; never `--label floor`.


## Manual Check

- 2026-11-24, the user, VS Code 1.143.1 dev host from `.vscode-test`, through the Redpanda ADP endpoint (within the 2-run cap): the manual check passed with no issues. A plain request in the RPCN AI Assistant view showed progress lines, then question cards with the pick first, and after the answers a `ready` design note in the view (acceptance criterion 1).
