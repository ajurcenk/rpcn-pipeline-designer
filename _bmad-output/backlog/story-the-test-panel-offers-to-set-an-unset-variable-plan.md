---
title: 'The test panel offers to set a variable its run found unset'
type: 'feature'
ticket: '32'
created: '2026-10-28'
status: 'built'
baseline_revision: 'd47d631e63160b91460793edf66d435f98ea2e97'
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

**Problem:** A test run that stops because the config uses a variable nothing sets shows "The test could not run" with the binary's message (`required environment variables were not set: [REGION ZONE]`) and nothing to do about it.

**Approach:** That result carries the unset names, and the panel's error card offers "Set NAME…" for each. Choosing one runs ticket 31's set action for that name and the panel's config (plain or secret, as there); when it sets a value and Run on change is on, the panel runs again. Every other result is unchanged.

**Decision (user, 2026-10-28):** split from ticket 31. Assumption kept from the ticket: only the `${VAR}` lint message names unset variables; an unset `env("VAR")` in a mapping is a mapping result and gets no button.

## Boundaries & Constraints

**Always:**
- The names come only from that message, each checked against `[A-Za-z_][A-Za-z0-9_]*`; nothing else in the message is trusted.
- Buttons are real buttons in the error card, reachable by Tab, named "Set NAME…" for screen readers; the live region announces the result as today.
- The panel's message from the webview is validated like the others (a known name of the current result only).

**Never:**
- Changing the other result kinds, the panel's other messages, the set action itself (ticket 31), or how variables reach the commands.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OFFERED | a test run stopped by `required environment variables were not set: [REGION ZONE]` | the error card shows "Set REGION…" and "Set ZONE…" after the message | none |
| SET_RERUN | "Set REGION…", a value set (plain or secret), Run on change on | ticket 31's set action runs for REGION and the panel's config; the panel runs again | none |
| NO_RERUN | the same, Run on change off | the value is set; the panel does not run by itself | none |
| CANCEL | the set action cancelled | nothing changes, no run | none |
| BAD_NAME | the message lists a token that is not a valid name | no button for it | none |
| UNKNOWN_REQUEST | the webview asks to set a name the current result does not list | ignored | none |
| OTHER_ERRORS | any other "could not run" result, and every other kind | shown exactly as today, no button | none |

</frozen-after-approval>

## Code Map

- `src/core/bloblangRun.ts` (~:121–:178, `CONFIG_LINT_ERROR`, the `lint` / `error` classification) and `src/adapters/redpandaConnect/bloblangRunner.ts` (`classify`, where a non-parse lint message stays `error`): extract the names from `required environment variables were not set: [A B]` into the result (pure helper in core, unit-tested).
- `src/shared/bloblangProtocol.ts` -- the `error` result (~:69) gains optional `missingVariables?: readonly string[]` (validated ~:209: an array of valid names); a new webview message `setVariableRequested { name }` in `BloblangWebviewMessage` (~:118) and `parseBloblangWebviewMessage` (~:286).
- `src/adapters/bloblangPanel/panels.ts` -- the message switch (~:379–:399, beside `retryRequested`): check the name is in the panel's current result, run `vscode.commands.executeCommand(SET_MISSING_COMMAND, name, configUri)` (`src/adapters/vscode/environmentView.ts:44`, registered ~:247), then, when it reports a value was set and Run on change is on, run again (as `retryRequested` does). Make the command return whether a value was set if it does not already.
- `webview/src/bloblang/OutputView.tsx` -- the `ERROR_TITLE` card (~:136): render the buttons from `result.missingVariables`; post `setVariableRequested`. Tests in `webview/src/bloblang/TestPanel.test.tsx` (pattern ~:489).
- Tests: unit for the name extraction and the protocol validation; webview tests for OFFERED, BAD_NAME, OTHER_ERRORS and the posted message; suite 90 (`src/test/integration/suites/90-bloblang-panel.ts`, its fake binary can print the lint line) for SET_RERUN, NO_RERUN, CANCEL, UNKNOWN_REQUEST with the set action's input seams from ticket 31 (`src/test/integration/suites/95-environment-view.ts` shows them).
- Docs: `README.md` (the test panel's "could not run" paragraph and the Environment view section), `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] Core extraction, protocol field and message, runner.
- [x] Panel handler and the command's result.
- [x] Webview buttons.
- [x] Tests for every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when compile, the unit, webview, stable, multi-root and corpus runs execute, then all pass and the existing test panel tests are unchanged.

## Implementation Notes

- Names: `missingVariablesOf` (`src/core/bloblangRun.ts`) reads each `required environment variables were not set: [A B]`, keeps the tokens matching `isEnvName` (`src/shared/bloblangProtocol.ts`, `[A-Za-z_][A-Za-z0-9_]*`), once each. `classify` adds `missingVariables` only to a non-parse lint stop that names at least one; no other result changes.
- The panel keeps the names of the result it last posted (`offered`); `setVariableRequested` for any other name is logged and ignored. The set action is `SET_MISSING_COMMAND` (it already returned whether a value was set), behind a `setVariable` seam on `BloblangPanelsOptions` (unused by the tests, which drive the real command through ticket 31's `api().environment.ui`).
- Run on change lives in the webview, so the host cannot decide the run again. On a set, the host posts a new host message `variableSet {name}`, and the webview runs its current input when Run on change is on (as Retry: the host acts, the webview's recovery runs).

## Plan Change Log

- 2026-10-28 (implementation): added the host message `variableSet {name}` to the protocol (not named in the Code Map): the host does not know Run on change, so the webview runs again on it. No existing message changed.
- 2026-10-28 (implementation): two existing assertions gained the new field, as the result now carries the names: suite 90's RUN_ERROR (`missingVariables: ['BROKEN']`) and the adapter unit test ENV_LINT (`['API_TOKEN']`). The webview test panel tests are unchanged.

- 2026-10-28 (review fixes): `SET_MISSING_COMMAND` (and `SecretVariables.setCommand`) now resolve with the name set (`undefined`: none), so an edited secret name posts no `variableSet`; suites 95 and multiroot assert names instead of booleans. Names masking would change are left out; `offered` clears on `ready` and the no-binary / removed states; the fake binary's BROKEN error needs the variable unset; `isValidEnvName` delegates to `isEnvName`.

## Review Triage Log

Quick review. Verdicts: 0 high, 2 medium, 4 low.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Suite 90's RUN_ERROR and the adapter's ENV_LINT assertions now include `missingVariables`, against the plan's "existing test panel tests are unchanged" | low | noted | The assertions are extended by the new field, not loosened; that criterion is outside the frozen block. |
| 2 | Nothing proves the run after a set gets the value (the fake always prints the unset-variable line); the "SET_RERUN (secret) + NO_RERUN" test cannot cover NO_RERUN | medium | patch | The fake prints the line only when the variable is unset; a test sets it and runs again; the test renamed. |
| 3 | On the secret path the prefilled name is editable, so `variableSet` can name a variable that was not set | medium | patch | The command reports the name it set; `variableSet` only for the requested one. |
| 4 | `missingVariables` is copied unmasked into a masked result | low | patch | Names masking would change are left out. |
| 5 | `offered` is not cleared when the webview no longer shows the result | low | patch | Cleared on `ready`, the no-binary state and the removed state. Not on the webview clearing its content (the host is not told; only a forged request could use the old names, no button shows): noted, not fixed. |
| 6 | `isEnvName` duplicates `isValidEnvName` | low | patch | `isValidEnvName` delegates to the shared rule. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run test:webview` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot` -- expected: all pass.
- `npm run test:corpus` -- expected: passes.

**Manual checks:**
- Dev host on 1.143.1, `.vscode-test/manual-env-view`: a mapping using `${REGION}`; the test panel's "Set REGION…" by mouse and by keyboard; set as plain, the panel runs again; then the Environment view shows REGION under the setting.

Result (2026-10-28, after the review patches): stable 1040 passing; multiroot 7 passing; corpus 156 passed; webview 317 passed. Manual check: pending.
