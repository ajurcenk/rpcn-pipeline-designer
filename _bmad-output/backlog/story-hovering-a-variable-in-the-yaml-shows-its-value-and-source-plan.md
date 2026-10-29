---
title: 'Hovering a variable in the YAML shows its value and source'
type: 'feature'
ticket: '34'
created: '2026-10-28'
status: done
baseline_revision: 'b40c0d966ee81eb51233d54967f9e70f7109945f'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A config's variable values show only in the Environment view (ticket 31), away from the line that uses them.

**Approach:** A hover on `${NAME}`, `${NAME:default}` and `env("NAME")` (literal name) in a detected config shows the value the commands get, its source (with the settings level), and each weaker source it overrides, from the Environment view's own model for that config. Masked values stay masked; "Show value" reveals that row in the Environment view. A missing variable offers "Set variable…" (ticket 31's set action); a default in use is shown.

**Decisions (user, 2026-10-28):** the hover appears beside the Bloblang hover on `env("NAME")` (VS Code shows both); "Show value" opens the Environment view on the config and reveals that one row, the hover stays masked; inline hints and the graph not chosen.

## Boundaries & Constraints

**Always:**
- Sources, precedence, states and masking are exactly the Environment view's (`environmentModel` and the view's mask rule): secret, env-file and VS Code environment values as `••••••••`; `redpandaConnect.env` and the extension's `NO_COLOR` in clear.
- The hover is computed when asked (current settings, secrets, env file on disk, the document's text), so a change shows on the next hover.
- Command links are limited to the two commands the hover uses (`isTrusted: { enabledCommands }`); their arguments carry the config URI and the name, never a value.

**Never:**
- Changing how variables reach the commands, precedence, the Environment view's rows or its set action; a value in a log line or message; a masked value in clear in the hover; replacing the Bloblang or YAML hovers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PLAIN | `${TOPIC}`, `env` {TOPIC: orders} at folder level | hover: TOPIC = `orders`, from `redpandaConnect.env` (folder) | none |
| OVERRIDES | `${API_TOKEN}` in `.env` and a secret | hover: from the env file, masked; overrides Secrets | none |
| MASKED_SHOW | the same, "Show value" | the Environment view shows this config, its API_TOKEN env-file row revealed, the view focused; the hover text never had the value | none |
| MISSING | `${REGION}`, nothing sets it | hover: missing; "Set variable…" runs `SET_MISSING_COMMAND` for REGION and the config | set cancelled: nothing changes |
| DEFAULT | `${PORT:8080}`, nothing sets PORT | hover: the default `8080` is used | none |
| DEFAULT_SET | `${PORT:8080}`, PORT set | hover as PLAIN (the set value wins) | none |
| ENV_CALL | `env("ZONE")` in a mapping | variable hover beside the Bloblang hover | none |
| CURRENT | a value changed after a hover | the next hover shows it | none |
| NOT_A_USE | an undetected file, plain text, `${!this.x}`, `env(this.name)` | no variable hover | none |

</frozen-after-approval>

## Code Map

- `src/core/envUsage.ts` -- `REFERENCE` / `ENV_CALL` regexes (keep them the one definition). Add a pure `envReferenceAt(text, offset)`: the use under `offset` (name, default if any, start/end), same rules as `envUsage`; unit-tested in `src/test/core/envUsage.test.ts`.
- `src/adapters/vscode/environmentModel.ts` -- `environmentModel(inputs)`, `EnvironmentVariable` (source, value, state, overriddenBy, level). No change expected.
- `src/adapters/vscode/environmentView.ts` -- `compute(uri)` (~:470) builds the model for any config; expose it (e.g. `modelFor(uri)`). The mask rule lives in `variableItem` (~:401, `masks`); share it rather than copy. `setRevealed` (~:697) and `refresh` (~:275, clears reveals) — the new reveal command must set the view's config, refresh, then reveal the row and focus the view (`treeView.reveal`). `SOURCE_LABELS` / `SOURCE_NAMES` (~:55) for wording; `stateText` (~:433). `register` (~:238) registers commands; `SET_MISSING_COMMAND` takes `(name, configUri)`.
- New `src/adapters/vscode/envHover.ts` -- `HoverProvider`: detected configs only (`DetectionRegistry.isDetected`), `envReferenceAt` on the document text, the view's model for the document, a trusted `MarkdownString`.
- `src/extension.ts` (~:149) -- register the hover for YAML beside the Bloblang hover.
- `package.json` -- the reveal command declared and hidden from the Command Palette (`when: false`), like other link-only commands if any; check the file's convention.
- Tests: suite `src/test/integration/suites/95-environment-view.ts` has the sources set up (setting, `.env`, secrets) and the set action's UI seams; add the matrix rows there through `vscode.executeHoverProvider`, asserting the hover text has no masked value, and the reveal through the view's test seam (`items()`).
- Docs: `README.md` Environment view section (~:143), `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/envUsage.ts` -- `envReferenceAt` with unit tests (each form, the default, `${!…}`, escaped quotes, computed name, offsets at the edges).
- [x] `src/adapters/vscode/environmentView.ts` -- expose the model for a URI and the mask rule; a reveal command (config URI, source, name).
- [x] `src/adapters/vscode/envHover.ts`, `src/extension.ts`, `package.json` -- the hover and its registration.
- [x] `src/test/integration/suites/95-environment-view.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when compile, unit, stable, multi-root, corpus and webview runs execute, then all pass and ticket 31 and 32's tests are unchanged.
- Given any hover from this provider, when its markdown is read, then it holds no secret, env-file or VS Code environment value.

## Implementation Notes

- `envReferenceAt` uses an exclusive end (`start <= offset < end`); inside a default, the outer `${NAME:…}` is the use (as `envUsage`).
- `EnvironmentView.modelFor(uri)` computes the model uncached (the view's cache and reveals are untouched); `masksValue` and `variableStateText` are exported from the view and used by both. `getParent` was added for `TreeView.reveal`.
- New hidden command `redpandaConnect.environment.revealVariable` `(configUri, source, name)`: sets the view's config, refreshes, reveals the row and calls `treeView.reveal(node, { select, focus })`. `SET_MISSING_COMMAND`'s registration now also accepts the config URI as a string (command-link args are JSON); its behaviour is otherwise unchanged.
- The hover is registered in `activate` right after the view (it needs the view), not inside `registerEditorProviders`.
- The hover names overridden sources only, never their values; a `noValue` / `ignored` row and the env file's note are listed with the view's wording.
- Through `vscode.executeHoverProvider` each hover takes ~6 s in the test host (another provider, not this one: the direct-provider test is instant), so the new tests add ~90 s to the stable run.
- ENV_CALL runs in a nested suite of 95 with the fake binary's schema (`useSchemaBinary`), so both the Bloblang `env` hover and the variable hover are asserted. The hover tests have a 180 s per-test timeout. `revealVariable` returns false when `treeView.reveal` throws; `EnvironmentView.visible` is a test seam. The env file's note shows on every hover when set.

## Review Triage Log

Quick review. Verdicts: 0 high, 2 medium, 4 low, 1 false. No masked value reaches the hover's markdown, a log line or a message.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `revealVariable` returns true before `treeView.reveal(…, { focus })`, whose failure is only logged; MASKED_SHOW does not verify "the view focused" | medium | patch | Real: the return precedes the reveal. Returns false when the reveal throws; the test asserts no "could not reveal" line. |
| 2 | PLAIN at folder level untested (the stable run has no folder) | low | patch | A multiroot hover on folder B's `env` value asserts the folder level. |
| 3 | ENV_CALL: the Bloblang hover beside the variable hover is not asserted | low | patch | The test waits for the Bloblang provider and asserts both hovers. |
| 4 | "Env file: <note>" only when the name has an env-file row: a file stopped before the name's line, or unreadable, leaves a Missing hover unexplained | medium | patch | Real (`rows.some(v => v.source === 'envFile')` gate). The note shows whenever the model has one. |
| 5 | Hover tests near the suite's 60 s limit (~6 s per `executeHoverProvider`; also the floor and CI) | low | patch | Longest ~20 s locally; a larger per-test timeout for the hover tests. |
| 6 | `SOURCE_NAMES` exported with no outside use | low | patch | Back to a module const. |
| 7 | "Show value" link carries `source` beyond "the config URI and the name" | false | reject | The source is a kind (setting, envFile, …), not a value; the constraint's point is "never a value", and the Code Map names `(configUri, source, name)`. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot` -- expected: all pass.
- `npm run test:corpus` and `npm run test:webview` -- expected: pass.

**Manual checks:**
- Dev host on 1.143.1, `.vscode-test/manual-env-view/env-demo.yaml`: hover each variable (TOPIC, API_TOKEN, BROKERS, PORT, HOME, REGION, `env("ZONE")`); Show value on API_TOKEN; Set variable… on REGION.

Result (2026-10-28, after the review patches): stable 1054 passing (every HOVER test ran and passed); multiroot 8 passing (the folder-level hover); corpus 156 passed; webview 317 passed. Manual check: done by the user on the 1.143.1 dev host (2026-10-28), `.vscode-test/manual-env-view/env-demo.yaml` (each variable's hover, Show value, Set variable… on REGION, `env("ZONE")` beside the Bloblang hover), no issues.
