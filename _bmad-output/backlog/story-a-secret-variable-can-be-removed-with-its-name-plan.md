---
title: 'A secret variable can be removed with its name'
type: 'feature'
ticket: '39'
created: '2026-10-29'
status: 'built'
baseline_revision: '7c873b6ae206280ea9713761b0784d99d182f449'
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

**Problem:** The Environment view's Remove and **Remove secret variable** delete only a secret's value; its name stays in `redpandaConnect.secretEnv`, the row stays as "no value on this machine" with no action, and removing the name means editing the right settings file by hand.

**Approach:** A declared name with no value gets **Remove name** in the view, which takes it out of `redpandaConnect.secretEnv` at the level whose list the config uses. Removing a secret that has a value (the view's Remove, or the command) asks: value only (the default, as today) or the value and its name, naming the settings file that changes. **Remove secret variable** also lists declared names with no value. A level left with no name loses the setting there.

**Decisions (user, 2026-10-29):** value only stays the default; an emptied list removes the setting at that level (not `[]`).

## Boundaries & Constraints

**Always:**
- The name is removed only from the list the config uses (the most specific level that has one, as `declare` reads it); when the name is still declared after that (a less specific list that now applies), the user is told where it comes from.
- The value goes before the name; when the value cannot be deleted nothing else changes; when the name cannot be removed after the value went, the message says the value is removed and the name is not, and why.
- No value in any message, log line or prompt.

**Never:**
- Changing how secrets reach the commands, precedence, masking, Clear stored secrets, plain variables or the env file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| NAME_ONLY | declared, no value; Remove name on its row | the name leaves that level's list; the row is gone | none |
| LAST_NAME | the only name at that level | `secretEnv` removed at that level (not `[]`) | none |
| VALUE_DEFAULT | a value stored; Remove, the first (default) choice | value deleted, name kept (as today) | none |
| VALUE_AND_NAME | a value stored; Remove, "value and name" | value deleted, then the name removed; the choice named the settings file | none |
| COMMAND | Remove secret variable | lists the folder's names with a value and declared ones without; with a value: the same choice; without: the name removed after a confirmation naming the file | none |
| STILL_DECLARED | after removal a less specific list holds the name | info: it is still declared in <that level>'s settings | none |
| CANCEL | the choice or the confirmation cancelled | nothing changes | none |
| VALUE_FAILS | the secret storage delete fails | error, nothing else changes, no value in it | as today |
| NAME_FAILS | the settings write fails after the value went | error: the value is removed, the name is not, and why | none |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/secrets.ts` -- `remove(folder, name)` (~:221, deletes the value; keep it); `removeCommand()` (~:324, lists stored names only: add declared names without a value from `declaredSecretNames(config.get('secretEnv'))` for the picked folder); `declare()` (~:408) reads the levels with `inspect` and picks the target: mirror it in a new `undeclare(folder, name)` that removes from the most specific level that has a list, writing `undefined` when no name is left (same `updateSetting` seam), and reports where the name is still declared afterwards. A choice prompt (value only / value and name) as an injectable seam (`SecretVariablesOptions`, like `notify`), used by the command.
- `src/adapters/vscode/environmentView.ts` -- `remove(node)` (~:930) for secret rows: with a value, ask through `EnvironmentUi` (a new `pickRemoval(name, where)` beside `pickKind`, ~:133/:143) then call `secrets.remove` and, for "both", the new undeclare; a new `REMOVE_NAME_COMMAND` for rows with no value. The settings file to name: the folder's `.vscode/settings.json`, the workspace file or the single folder's `.vscode/settings.json`, or "user settings" (as `newVariableLevel`/`SETTING_TARGETS` ~:126-140 name the levels).
- `package.json` -- the Remove menus (~:356, :406, `viewItem =~ /^variable (plain\b|secret hasValue\b)/`): add `redpandaConnect.environment.removeName` inline and in the context menu for `viewItem =~ /^variable secret(?! hasValue)/` (a secret row without `hasValue`), hidden from the palette.
- Tests: suite `src/test/integration/suites/95-environment-view.ts` (its `ui` seam and settings helpers) and the multiroot `src/test/integration-multiroot/suites/settings.ts` (a folder list beside a workspace one, for STILL_DECLARED and the level); unit tests for any pure helper.
- Docs: `README.md` (the Set/Remove secret paragraph, ~:135-139, and the Environment view section), `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `secrets.ts` -- `undeclare`, the command's listing and choice.
- [x] `environmentView.ts`, `package.json` -- the choice on Remove, Remove name.
- [x] Tests for every matrix row (stable and multiroot).
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass and tickets 30, 31 and 38's tests are unchanged except where Remove now asks (their remove steps answer "value only").

## Implementation Notes

## Review Triage Log

Quick review. Verdicts: 0 high, 2 medium, 5 low, 0 false. Confirmed: the Remove name regex matches only secret rows without a value, the value goes first, cancel changes nothing, no value in any message, an emptied list removes the setting.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | "No folder" with a workspace list removes the name from the workspace list, which folders without their own list use too | medium | patch | Real: that is the list the window's configs use (`getConfiguration` without a resource). The level rule stays; the prompt and result now say the list is shared with the other folders' configs. Same root cause as 2. |
| 2 | A folder without its own list edits the shared workspace list; other configs lose the name unannounced | medium | patch | With 1: "also used by the other folders' configs"; after an emptied folder list, the info says which list now applies. Multiroot tests for both, with the view's message. |
| 3 | `removed.where!` can print "undefined" | low | patch | Falls back to the `where` read before the prompt. |
| 4 | `removeName()` accepts a row with a value | low | patch | Only rows with no value. |
| 5 | An untitled workspace's prompt names no file | low | patch | Named as an unsaved workspace's settings. |
| 6 | An emptied folder list lets the less specific list's other names apply | low | patch | Covered by 2's message. |
| 7 | Test gaps (the view's message for STILL_DECLARED; "No folder" with a workspace list) | low | patch | Covered with 1 and 2. |
| 8 | Two existing test lines re-indented | low | patch | Restored. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot`, `npm run test:corpus`, `npm run test:webview` -- expected: pass.

**Manual checks:**
- Dev host on 1.143.1, `.vscode-test/manual-license` (its `REDPANDA_LICENSE`, `REDPANDA_LICENSE_FILEPATH`, `TEST` secrets): Remove name on a row with no value; Remove with "value and name" and with the default; the command's list; the last name leaving the folder settings without `secretEnv`.

Result (2026-10-30, after the review patches): multiroot 10 passing; webview 318 passed; corpus 156 passed. Stable: the run after the patches had 31 graph and test-panel webview failures ("the webview posted ready"), all from webviews that never loaded; the same graph panel suite on the commit before this story fails the same way (PANEL), so it is the test profile's webview environment since a reboot, not this change. The stable run before the patches passed 1085 (the implementer's). The full stable run is pending until the test profile's webview cache is cleared (user to confirm). Manual check: done by the user on the 1.143.1 dev host, `.vscode-test/manual-license` (2026-10-30), no issues.
