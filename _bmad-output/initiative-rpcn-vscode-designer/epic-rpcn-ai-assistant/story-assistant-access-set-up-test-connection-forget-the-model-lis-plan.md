---
title: 'Assistant access: set up, test connection, forget, the model list and the access states'
type: 'feature'
ticket: '3'
created: '2026-11-25'
status: 'built'
baseline_revision: 'eb25eafa53004c1066df90ca01f26da6eab27054'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-rpcn-ai-assistant/epic-rpcn-ai-assistant.md'
  - '{project-root}/_bmad-output/backlog/spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Setting up access asks only for the key and never checks it. Nothing can forget the key. The model is a free-text setting the user must know. A refused key, a model the endpoint refuses or an unreachable endpoint shows as Claude Code's raw text, such as "Not logged in · Please run /login" or "403 model … is not allowed".

**Approach:**
- Set up asks for the base URL, auth and key, tests them with one call, and stores the key only when the test passes.
- Test connection and Forget assistant access are commands.
- A model chip in the composer opens a quick pick of the endpoint's `/v1/models`, plus Other…, each model with a relative cost mark.
- A classifier maps ADP's, Anthropic's and Claude Code's error texts to the access states: key refused, model not allowed and unreachable. Each state gets its own text and next action.

## Boundaries & Constraints

**Always:**
- **Set up assistant access…**
  1. **Base URL:** an input box prefilled with the current setting.
  2. **Auth:** a quick pick of `bearer` and `x-api-key`, with the current value first.
  3. **Key:** a password box.

  Escape at any step stores nothing and changes no setting. The test call follows (see below). When it passes, the base URL and auth settings are written (Global), the key is stored in secret storage with its base URL, and an info message says so. When it fails, nothing is stored and the classified error is shown with **Try again**. The current one-at-a-time guard stays.
- **The test call** (`src/adapters/assistant/endpoint.ts`, no `vscode` import):
  - **What it sends:** `GET <baseUrl>/v1/models` with the key in the auth header. It carries `anthropic-version`, and uses the extension's proxy and CA handling from 8.2 (`registryAgent`/`proxyConfigFor`). Timeout 15 s.
  - **A 2xx:** gives the model list (`data[].id`, then `display_name`).
  - **A 404 or 405:** means the endpoint serves no list, so the result is "reachable, no model list" (not a failure).
- **Test connection** (`redpandaConnect.assistant.testConnection`) runs the same call with the stored key. It shows the result, and sets or clears the sticky access state.
- **Forget assistant access** (`redpandaConnect.assistant.forgetAccess`) deletes both secrets after a modal confirm, and clears the cached model list. The view goes to No access.
- **Error classifier** (`classifyEndpointError(status, body, text)`, in `endpoint.ts`). Its input is an HTTP status plus a body, or a run's error text. It handles Anthropic's `{type:'error',error:{type,message}}`, ADP's `{code,message,details[{reason}]}` and Claude Code's texts.
  - **keyRefused:** 401, `authentication_error`, ADP `UNAUTHENTICATED`, "Not logged in · Please run /login", "Invalid API key".
  - **modelNotAllowed:** 403 with `model_not_allowed` or "model … is not allowed"; the model name is kept.
  - **forbidden:** another 403 or `permission_error`. It shows as key refused, with the endpoint's message.
  - **unreachable:** `ECONNREFUSED`, `ENOTFOUND`, TLS errors or a timeout.
  - **other:** anything else, with the message kept and masked.
- **Access states.** New values `keyRefused`, `modelNotAllowed` and `unreachable`, placed after `baseUrlChanged` in `accessRest()`.
  - **When they are set:** a failed Test connection, or a run whose error classifies as one of them. That run's turn still shows its masked error line.
  - **What keyRefused clears it:** a successful set-up or Test connection.
  - **What modelNotAllowed clears it:** the same, or a change to the model setting.
  - **unreachable:** not sticky. It shows on the failed turn, with a **Test connection** action, and does not block the composer.
  - **Texts and buttons:**

    | State | Text | Button |
    |---|---|---|
    | keyRefused | "The endpoint refused the key." | Set up assistant access… |
    | modelNotAllowed | "The endpoint does not allow `<model>`." | Choose a model |
    | unreachable | "Could not reach `<host>`." | Test connection |
- **Model chip:**
  - **Where:** the left of the composer's bottom row, as `<model> ▾`. It is shown whenever access is set up.
  - **The pick:** a VS Code quick pick of the cached list, with the current model checked and **Other…** last (an input box for any name).
  - **The list:** from the last successful test call. It is fetched again when the pick opens, if more than 10 minutes old, and kept only in memory.
  - **Cost marks:** each item's description holds a relative cost mark by family name, not a price: `$$$` for opus, `$$` for sonnet and fable, `$` for haiku, none otherwise.
  - **When a name is picked:** it is written to `redpandaConnect.assistant.model` (Global). The next run uses it.
  - **No list:** when the endpoint has none, the pick shows the current model and Other… only.
- **State message:** gains `model` (the setting) and `modelNotAllowed` (the refused name or null). The new webview messages are `chooseModelRequested` and `testConnectionRequested`.
- **Masking:** no key in any setting, file, argument, log, message, quick pick or capture. Every endpoint text goes through `mask()`.

**Never:**
- storing the key before the test passes;
- calling `/v1/messages` (or anything that costs tokens) to test;
- persisting the model list to disk;
- a price table, or a calculated price;
- changing how the agent receives the key (the env vars are unchanged).

## I/O & Edge-Case Matrix

| Scenario | Input | Expected | Error handling |
|---|---|---|---|
| SETUP_OK | URL, `x-api-key` and key; the fake `/v1/models` gives 200 with 3 models | Settings written, key stored, info message; the chip shows the model | — |
| SETUP_401 | The fake gives 401 (Anthropic body) | Nothing stored; "The endpoint refused the key." with Try again | — |
| SETUP_ADP_401 | 401 with ADP's body | The same as SETUP_401 | — |
| SETUP_ESC | Escape at the auth step | No setting changed, nothing stored | — |
| SETUP_NO_LIST | `/v1/models` gives 404 | Stored, with "reachable, no model list"; the pick has the current model plus Other… | — |
| UNREACHABLE | URL to a closed port | Nothing stored; "Could not reach `<host>`." | — |
| TIMEOUT | The fake hangs past 15 s (a seam shortens it) | Classified unreachable | — |
| TEST_CONN | Test connection with a stored key, fake 200 | Info message; a sticky state cleared | — |
| FORGET | Forget, then confirm | Both secrets gone; the view shows No access | Cancel keeps both |
| RUN_401 | A fake-model run that fails "Not logged in · Please run /login" | The turn shows the masked error; access goes to keyRefused | — |
| RUN_403_MODEL | A run that fails `403 model "x" is not allowed for provider "p"` | modelNotAllowed with `x`; Choose a model opens the pick | — |
| MODEL_CHANGE | In modelNotAllowed, a different model picked | The state clears; the next run uses the new model | — |
| PICK | The chip, then `claude-sonnet-4-6` | The setting is written; the chip shows it | — |
| PICK_OTHER | Other…, then a typed name | The setting is written | Escape changes nothing |
| COST_MARKS | Models opus, sonnet, fable, haiku and `my-alias` | `$$$`, `$$`, `$$`, `$` and none | — |
| NO_LEAK | After set-up, a test, a run and forget | The key is in no setting, file, log, message or quick-pick item | — |

## Decisions (the user, 2026-11-25)

- **The test call:** `GET /v1/models` only, which costs no tokens. A refused model shows on the first run, as model not allowed with Choose a model.
- **Set-up:** asks for the URL, then auth, then the key, each prefilled with the current setting.
- **States:** key refused and model not allowed are sticky until fixed, and replace the composer with their panel. Unreachable is not sticky.
- **Plan size:** about 2,600 tokens, kept as one story.

</frozen-after-approval>

## Code Map

- **`src/adapters/vscode/assistantAccess.ts`** (268 lines):
  - **`setUpAccess()`** (l.178): extend it with the URL and auth steps, the test call and conditional storage. Keep the busy guard, `usableBaseUrl`/`normalBaseUrl` (l.56, l.67) and the secrets (l.16, l.18).
  - **New methods:** `testConnection()`, `forget()`, `models()` (cached) and the sticky failure (`lastFailure`), firing `onDidChange`.
  - **`register()`** (l.113): add the two commands. `AssistantAccessUi` (l.37) gains `pick` and `confirm`.
  - **`mask()`** (l.168): already masks key shapes. Use it on all endpoint text.
- **New `src/adapters/assistant/endpoint.ts`:**
  - **`listModels(baseUrl, auth, key, agent, timeoutMs)`:** the HTTP call, using `registryAgent` and `proxyFor` from `runtime.ts` (l.394, l.259), with `proxyConfigFor` (`assistantRuntime.ts` l.89) supplying the config.
  - **`classifyEndpointError` and `costMark(model)`.**
  - **Tests:** a unit test in `src/test/adapters/assistant/endpoint.test.ts`.
  - **Formats:** ADP and Anthropic, as in spike findings l.24-30 and l.94-95, and `scripts/spike/adp-probe.mjs` `messageSummary` (l.183-199).
- **`src/adapters/assistant/events.ts`:** `resultEventOf` (l.206) and `retryOf` (l.189) keep their text. The view classifies the error text through `classifyEndpointError`.
- **`src/adapters/vscode/assistantView.ts`:**
  - **`accessRest()`** (l.551): add the three states after `baseUrlChanged`.
  - **`event()` case 'error'** (l.1048): classify the error, and set the access state's failure on the access object.
  - **`state()`:** posts `model` and `modelNotAllowed`.
  - **`receive()`:** handles `chooseModelRequested` (which runs the chip's pick) and `testConnectionRequested`.
- **Protocol `src/shared/assistantProtocol.ts`:**
  - the `AssistantAccess` union (l.7) and `ACCESS` (l.386);
  - the state fields (l.158-180), with `parseAssistantHostMessage` (l.492);
  - the new webview messages and their parser.
- **Webview:**
  - `accessPanel()` (`AssistantView.tsx` l.62-85) gains the three panels;
  - `Composer.tsx` bar (l.114-121) gets the chip on the left, posting `chooseModelRequested`;
  - the CSS is theme only.
- **`package.json`:** the two commands, near l.372. The `model` setting's description mentions the chip.
- **Tests:**
  - **`src/test/helpers/fakeMessagesApi.ts`:** serve `GET /v1/models` (models settable), with `modelsStatus` for 401, 404 and the ADP body, and a `hang` option.
  - **99c:**
    - new rows for every Matrix scenario;
    - extend `setAccessForTest` (l.170);
    - reuse `assertNoLeak` (l.100) and `userFilesHolding`;
    - update the AGENT_ERROR 401 test (l.1587) to also expect keyRefused.
  - **Webview tests:** the panels, the chip and the parser.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/assistant/endpoint.ts` (+ test) -- `listModels`, the classifier and `costMark` -- one place for the endpoint's formats.
- [x] `src/adapters/vscode/assistantAccess.ts` -- the set-up steps, the test, forget, the cached models, the sticky failure and the commands -- access.
- [x] `src/shared/assistantProtocol.ts`, `src/adapters/vscode/assistantView.ts` -- the states, `model`, the messages and classifying run errors -- the view.
- [x] `webview/src/assistant/{AssistantView,Composer}.tsx`, CSS (+ tests) -- the panels and the chip -- the UI.
- [x] `package.json`, `src/extension.ts` -- the commands and wiring, including the test API seams -- the surface.
- [x] `src/test/helpers/fakeMessagesApi.ts`, `src/test/integration/suites/99c-assistant.ts` -- every Matrix row -- proof.
- [x] `README.md`, `CHANGELOG.md` -- set up, test, forget, the model chip and the states.

**Acceptance Criteria:**
- Given set-up with a valid key on a fake endpoint, when it completes, then the composer's chip shows the model, and its pick lists the fake's models with their cost marks.
- Given the full stable suite, when it runs, then every 8.1, 8.2, 8.12 and 8.5 assistant test still passes.

## Implementation Notes

- **The state message's extra fields.** Besides `model` and `modelNotAllowed`, the state carries `host` (the base URL's host, for "Could not reach `<host>`.") and `accessMessage` (a 403's own message, shown after "The endpoint refused the key.").
- **Where unreachable shows.** The access object holds `unreachable` as well as the two sticky failures. A request can still start in it, and the next run's start clears it. The webview puts its panel in the failed turn, after the error line, when the last turn failed. A failed Test connection has no turn, so the panel goes above the transcript.
- **The model list cache.** It is keyed by the base URL and auth it was fetched with. A list from another endpoint is never offered.
- **Test seams.** On the access object: `endpoint` (the test call, replaceable), `endpointTimeoutMs` (TIMEOUT) and `now` (the list's age). Outside the 8.3 suite, 99c stubs `endpoint` to pass with no list, so set-ups there make no network call. A key set through `setAccessForTest` stands for a set-up: it clears the failure held and the list.
- **The commands.** Their titles are "Test assistant connection" and "Forget assistant access". The view's buttons say "Test connection".
- **The fake model's 403.** A real Agent SDK run against the fake's ADP 403 `model_not_allowed` ends as modelNotAllowed with the model's name (a 99c row).
- **Manual check: model per turn.** Each turn records the model setting when its run starts (the value given to the host) and posts it as `model` on the turn. A later model change never alters it. The rpcn header shows it after the skill, muted, with the title "Model used for this request", for example `rpcn · rpcn-design · claude-sonnet-4-6 · 1:06`. The "Started (<model>)" row stays.
- **Manual check: the full command.** A shell step keeps its clipped one-line `detail` for display. It also carries `fullDetail`: the whole command, with new lines kept. The view masks it, then caps it at 20,000 characters with "… (cut)". The line's tooltip shows that full text and **Copy command** copies it; with no `fullDetail`, both fall back to `detail`. An approval card's detail was already the whole command; it is now capped the same way after masking.
- **Manual check: approval outcomes in the history.**
  - Each step posts `approval`: `once`, `session` or `deny` (a card the user decided), or `remembered` (no card; a session key covered it).
  - Each step also posts `approvalDetail`: what the card asked about, masked and capped.
  - Its `result` is now only the step's own short result; a denial's is empty. The old forced `allowed`, `allowed (this session)` and `denied` texts, and `SESSION_ALLOWED_RESULT`, are gone.
  - The webview shows "you allowed once", "you allowed for this session", "you denied" or "allowed by this session's approval", with the step's own result after it ("you allowed once · written").
  - Rows the user was asked about get a muted "asked you" badge, whose tooltip is what was asked. A group shows the badge when any member was asked; the members show their own outcomes.
  - The failed and warning marks of a denied step are unchanged.
- **Manual check: the full command in the history (revised by the user).**
  - Every step row keeps the short, one-line, clipped command. It is plain selectable text, so a selection copies that short text through the host copy path.
  - There is no toggle and nothing opens by itself. The tooltip has the full command, and **Copy command** always copies it (`fullDetail`, else `detail`).
  - The 200-steps-per-turn cap no longer drops shell commands. When a turn is over the cap, the oldest step that is no shell command is dropped first; approval rows ("Asks to …", steps with an outcome) and question rows are kept too.
  - Those dropped steps are counted in an "N earlier steps not shown" line at the top of the turn. Only when every row is one of the kept kinds is the oldest dropped.
- **Manual check: the question answers in the history.**
  - When a round is answered, its step keeps `qa`. Each entry holds the header, the question, the skill's pick (with its mark, or `null`), the answer given (the chosen labels joined by ", ", or the Other text) and `kept` (the answer is the pick). All of it is masked, with at most 20 questions and 2,000 characters a text.
  - The "Asked N questions · …" row is collapsed by default; it opens with a click, Enter or Space (`aria-expanded`). Inside, each question is followed by "You: <answer>" and then "(my pick)", or a muted "(my pick was: <pick>)" when the pick was not kept. The "(My pick)" mark is dropped from what is shown, and the text is selectable.
- **Flaky "a turn keeps the model it started on" (1 in 5 runs; the second run never reached its question): the cause.** The access dropped the key it had just written, so the second request did not start. A temporary log of every key change showed two causes.
  - **Ours: overlapping reads.** Every secret store or delete fires its own change, and each change starts a read of both secrets. A read that started before a write and finished after it overwrote the newer state. The suite's setup deletes the key and the test stores it again, so this happened readily.
  - **VS Code's: an echo of an older state.** VS Code runs our extension's secret gets and sets in order on its main thread, so a read issued after a write returns it. Yet in the test instance, where secrets live in application storage with no keyring, a read issued after this window's write of "key + `https://api.anthropic.com`" returned the URL from three writes earlier (the previous test's `fake.url`). Two reads in between had already returned the new state. The result was `baseUrlChanged` or `noAccess` at the next request.
  - **The fix (`assistantAccess.ts`):**
    - Reads are numbered, and a write invalidates every read started before it, so only a read started after this window's last write can apply.
    - For 5 s after a write, a read that returns one of this window's own earlier states is ignored as an echo. Any other state, such as another window's set-up or Forget, is applied as before.
    - The UI-free secret writes share one helper (`writeSecrets`) that records this window's states.
  - **The proof:** a 99c test uses a fake secret storage. Without the numbering it fails "a read started before the write did not overwrite it"; without the echo guard it fails "an echo of an earlier own state is ignored". It also checks that another window's change still applies.
  - **The flaky test itself** now asserts `ready` before its second run and, on a timeout, reports the run's own outcome, so a run that never starts fails at once with its reason.
  - **Note:** with only the numbering in place, the echo made the failure more frequent (2–3 failures per run, in this test and the unreachable one). That is how the second cause was found.
- **Manual check: an `rpcn_check` session key.** In `rules.ts`, a first pipeline stage `uv run <script> <subcommand> [args]` whose script is an absolute path resolving (realpath) to an `rpcn_check.py` inside the skills copy in use gets the key `rpcn_check <subcommand>`. The card then reads "Allow `rpcn_check lint` for this session".
  - Every other key rule still applies to the whole command: no leading assignment, no `$`, path arguments inside the workspace or the skills copy, later stages only read-only filters, `2>&1` and `2>/dev/null` allowed. Chains, substitutions, file redirects and outside paths still give no key.
  - A relative script, a workspace `rpcn_check.py`, or one outside the copy still gives no key, and so do no skills copy, no subcommand, or `rpcn_check` in a later stage.
  - The plain form is still allowed with no card.
- **Manual check: live activity line.** In the running turn, under the step card and before the question cards, a line shows a spinner, the current activity and its own `m:ss` timer. The header's clock stays.
  - **What it says:** a running tool step's label + "…" (for a shell step the label, never the command). Between steps, or once a reply has started: "Thinking…". Before any tool step (nothing yet, or only "Started (model)"): "Waiting for the model…". With question or approval cards open, or once the turn ends, there is no line.
  - **The timer** ticks client-side and restarts when the activity changes (a new step, or a step ending). A re-post of the same activity keeps it running. If the view reloads, the timer starts again from 0.
  - **The spinner** is VS Code's `codicon-loading` with `codicon-modifier-spin`, coloured `--vscode-progressBar-background`. The assistant bundle now imports `@vscode/codicons`' CSS, and esbuild puts the font at `dist/codicon.ttf` as for the graph; the CSP already allows the webview's own fonts. The running step row's mark uses the same spinner instead of `◌`. Under `prefers-reduced-motion: reduce` the spin is off and the timer still ticks.
  - **No host change:** the phases follow from the posted turn (its steps' marks, the reply, the open approvals and questions).

## Plan Change Log

## Review Triage Log

**Pass 1 (Quick lens):** 10 findings. By verdict: high 0, medium 3, low 7. By route: 7 patch, 3 rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `listModels` hits `timer` in its temporal dead zone when `agentFor` throws (a bad proxy), so it rejects with a ReferenceError | medium | patch | Checked: `finish` calls `clearTimeout(timer)` (endpoint.ts l.97), and `const timer` comes at l.124, after `agentFor` at l.104. Patch: declare `let timer` first, and wrap the request's construction in try/catch so the function resolves with the real error. |
| 2 | The set-up guard stays on while the failure notification is open | medium | patch | `settingUp` is reset only in `finally` (l.452), after `await showError(…Try again)` (l.425). Patch: release the guard before the notification; Try again starts a new set-up. |
| 3 | A run's 5xx whose text says timeout, TLS or certificate classifies as unreachable | medium | patch | Checked: `status === undefined && UNREACHABLE.test(text)` (l.235) ignores the status parsed from the text. Patch: use the derived HTTP status. |
| 4 | A failed Test connection's unreachable panel attaches to an earlier failed turn | low | patch | `inTurn` (AssistantView.tsx l.237) cannot tell where the failure came from. Patch: record the origin (run or test) on the failure, and post it, so only a run's failure goes in its turn. |
| 5 | The chip's pick waits up to 15 s on a cold cache, with no feedback | low | patch | Patch: wrap the fetch in `ui.progress`, as set-up and the test do. |
| 6 | A null host renders "Could not reach `the endpoint`." with the fallback in code quotes | low | patch | Patch: plain text "Could not reach the endpoint." when there is no host. |
| 7 | SETUP_ESC does not assert that no setting is written after an Escape at step 2 | low | patch | Patch: add an Escape-at-auth case to the test. |
| 8 | The chip is hidden in the noBinary, noUv, noWorkspace, runtime and skills states | low | rejected | No run can start in those states, so the model does not matter there, and Settings still sets it. Showing the chip there means a new surface outside the composer. |
| 9 | `unreachable` is ordered after noBinary, noUv and noWorkspace, not right after baseUrlChanged | low | rejected | Unreachable does not block (a Decision), so a blocking state shown first is correct. The order matches the decision, not the plan's wording. |
| 10 | A settings-write failure after the secrets are stored leaves the key with the old URL | low | rejected | `config.update` failing on a Global write is unlikely in everyday use. The view then shows baseUrlChanged with Set up, which recovers. A rollback adds branches. |

## Verification

**Commands:**
- `npm run compile && npm run test:webview` -- expected: pass.
- `npm run compile-tests`, then `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 900 xvfb-run -a npx vscode-test --label stable --grep "assistant"` -- expected: pass.
- The full stable suite twice, then `--label multiroot` -- expected: all pass. Run one at a time; never `--label floor`.

**Manual checks:**
- In the dev host, with the user's ADP endpoint and at most 2 real runs:
  - set up with a wrong key, which should be refused, then the right key;
  - the chip's pick lists the provider's models;
  - choosing `claude-opus-5-5`, which this provider refuses, gives model not allowed;
  - Forget.

### Orchestrator verification (final, after every manual-check change, 2026-11-27)

- `npm run compile` passed; `npm run test:webview` 495/495; `npm run compile-tests` passed.
- The full stable suite twice: 1971 passing, 1 pending each time. `--label multiroot` 15 passing. No floor run.
- `vsce package` and `check-vsix`: 65 files, 1.6 MB, no Anthropic package. The codicon font is in the bundle.
- Earlier runs on intermediate trees failed one test each, a different test each time and none in the assistant: the license, metrics Forget and runtime decline tests during a 2-hour run while the machine slept, `HOVER DEFAULT`, and `NOT MAPPED` (7.5). All of those ran 2 to 4 times slower than normal, with the dev host busy.

## Manual Check

- 2026-11-26 to 2026-11-27, the user, VS Code 1.143.1 dev host from `.vscode-test`, through their Redpanda ADP endpoint on `claude-sonnet-4-6` and `claude-sonnet-5`, using bearer auth.
- **Checked by the user:**
  - set up (URL, auth, key), with the test call;
  - the model chip and its pick, with the cost marks;
  - model not allowed;
  - Test connection and Forget.
- **Changes the user asked for during the check, each built and then checked:**
  - the model shown in each turn's header;
  - Copy command copying the full command, while the history keeps the short line;
  - explicit approval outcomes ("you allowed once" and the others) with an "asked you" badge;
  - every shell command kept in the history, including past the step cap;
  - question answers in the history;
  - a session key for the skills' own `rpcn_check` calls (`rpcn_check <subcommand>`);
  - the live activity line with VS Code's spinning icon (option A).
- **A product bug the flaky test found and fixed:** overlapping secret reads, plus a stale echo from VS Code's secret storage, could drop the key just written.
- The final check passed with no issues.
