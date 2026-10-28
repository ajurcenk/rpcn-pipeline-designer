---
title: 'Set secret variable declares the name at the level the folder count gives'
type: 'bugfix'
ticket: '33'
created: '2026-10-28'
status: done
baseline_revision: '80895a4868e1c85dd98a6411e1e3d1a0ebfe440a'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** **Set secret variable** declares the name in the folder's settings whenever a `.code-workspace` file is open, so a one-folder workspace opened through a workspace file gets folder settings, unlike the README and the Environment view's plain **Set variable** (ticket 31), which choose by the number of folders.

**Approach:** The secret's declaration uses ticket 31's level rule: the user settings with no folder, the workspace's with one workspace folder, the folder's with more. Names already declared by the old rule stay where they are (user, 2026-10-28). The README states the one rule for both actions.

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/secrets.ts:399` -- `declare(folder, name)`: the target is chosen from `vscode.workspace.workspaceFile`; the rest (inspect at the target, start from the effective list) stays.
- `src/adapters/vscode/environmentView.ts:136` -- `newVariableLevel(folder, folderCount)`, ticket 31's rule, unit-tested in `src/test/adapters/vscode/environmentView.test.ts`. `environmentView.ts` imports only types from `secrets.ts`, so `secrets.ts` can import it with no runtime cycle.
- `src/test/integration-multiroot/suites/settings.ts:265` -- ticket 30 SET: the two-folder case (folder settings), kept. Its teardown clears `secretEnv` at folder level only.
- `README.md:135` -- the **Set secret variable** paragraph ("the workspace's with one folder open").

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/vscode/secrets.ts` -- `declare` takes its level from `newVariableLevel(folder, workspaceFolders.length)` mapped to a `ConfigurationTarget`; doc comment updated.
- [x] `src/test/integration-multiroot/suites/settings.ts` -- a test, last in the suite: remove folder b from the workspace (`updateWorkspaceFolders(1, 1)`, the first folder stays, so the extension host does not restart), set a secret for a, assert it is in `workspaceValue` (the workspace file) and not in a's folder settings; re-add b and clear the workspace value in `finally`. Fails on the baseline.
- [x] `README.md` -- the paragraph says the name goes to the folder's settings with more than one workspace folder, the workspace's with one (also through a `.code-workspace` file), the user's with none; `CHANGELOG.md` Fixed line.

**Acceptance Criteria:**
- Given a one-folder workspace file, when a secret is set for its folder, then the name is in the workspace's settings.
- Given no workspace file and one folder, two folders, or no folder, when a secret is set, then the name lands where it does today (ticket 30's tests unchanged).

## Implementation Notes

Oneshot: one level choice in one function, one test, one README sentence.

- `declare` maps `newVariableLevel`'s level to its target in place (`TARGETS` in `environmentView.ts` stays private). A folder scope with no workspace folder open would now give the user level, not the workspace level; `set` gets a folder only from an open workspace folder, so that case is not reachable.
- The new multiroot test failed on the baseline ("declared in the workspace file": the name was in a's folder settings) and passes with the fix; removing and re-adding folder b kept the extension host, and the environment suite after it still passes.
- README: the no-folder case is in the paragraph's next sentence (the user settings), unchanged.

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot` -- expected: all pass, including the new test; the new test fails on the baseline.

## Review Triage Log

Quick review. Verdicts: 0 high, 1 medium, 3 low, 0 false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | With a folder `secretEnv` list from the old rule, the new name goes to the workspace list, which the folder's list hides (lists do not merge): the secret never takes effect, and setting it again returns early | medium | patch | Real (`secretEnv` is a resource-scoped array, the most specific list wins). `declare` now uses the most specific level, from the rule's level down to the folder, that already has a list; the test adds this case (`OLD_33` + `NEXT_33` in the folder list, the workspace list unchanged, the effective list holds the new name). |
| 2 | README and CHANGELOG promise the workspace list even when a folder list exists | low | patch | Same cause as 1; both now say the name joins an existing folder list. |
| 3 | The new test misses the folder-list case | low | patch | Covered with 1. |
| 4 | In the test's `finally`, a rejected `secretEnv` reset would leave folder b removed for the next suite | low | patch | Folder b is re-added first. |
| 5 | The level-to-target mapping is copied from `environmentView.ts` | low | patch | `TARGETS` exported as `SETTING_TARGETS` and reused. |

## Verification Result

2026-10-28: the new test failed on the baseline and passes with the fix. After the review patches: multiroot 8 passing, stable 1040 passing. Before the patches, one stable run had 2 failures in ticket 32's Set NAME… block (OTHER_NAME: the secret was not set; CANCEL: nothing was offered). The code those tests run does not change here (a config in no folder still declares at the user level), and they passed in the next run, so they are recorded in deferred-work as a flake. Webview and corpus runs are not affected (no webview or core change) and were not run. Manual check: none needed beyond the tests (the reproduction is the multiroot test); the user marked it done on 2026-10-28 without a dev-host check.
