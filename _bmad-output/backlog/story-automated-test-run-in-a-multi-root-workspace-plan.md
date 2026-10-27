---
title: 'An automated test run checks per-folder settings in a real multi-root workspace'
type: 'chore'
ticket: '28'
created: '2026-10-27'
status: 'built'
baseline_revision: '316adb19be7f5cd144ba5104383a888150b41613'
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

**Problem:** Ticket 4 made `redpandaConnect.envFile` (and `resourceFiles`) per folder, but its tests inject the folder and where the value is defined; the real path (`getConfiguration(…, resource)`, `getWorkspaceFolder`, `inspect`, the first folder) is checked only by hand, so a regression there would pass CI.

**Approach:** A third `vscode-test` run, `multiroot`, opens a two-folder `.code-workspace` fixture and runs its own suite: with a relative `envFile` set in folder B's settings, lint, Run, the live Bloblang parse and the test panel on a config in B pass B's env file; with it set only in the workspace settings, they pass the first folder's for configs in either folder. A fake binary records each command's arguments. The stable and floor runs keep opening no folder and do not load the new suite; CI runs the new one as a step of its own.

## Boundaries & Constraints

**Always:**
- The new suite has its own entry file outside the `out/test/**/*.test.js` glob; its suite titles contain "(integration" (the CI retry script's "tests ran" check).
- Each test sets the settings it needs at the folder or workspace level and removes them after, so the fixture on disk stays as committed.
- `binaryPath` (one per window) points at the fake binary from the user settings, as the existing suites do.

**Never:**
- Changing the stable or floor runs, the existing suites, or product code. `resourceFiles` is not part of this run (ticket 4's unit tests cover its shared resolution).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FOLDER_VALUE | `envFile: ".env"` in folder B's settings; config `b/pipe.yaml` | lint, Run, live parse, test panel run each get `--env-file <B>/.env` | none |
| WORKSPACE_VALUE | `envFile: ".env"` only in the workspace settings; configs in A and B | all four get `--env-file <A>/.env` for both | none |
| OTHER_FOLDER | `envFile` in B's settings; config `a/pipe.yaml` | no `--env-file` for A's config | none |
| EXISTING_RUNS | stable and floor runs | open no folder, unchanged test counts | none |

**Decision (user, 2026-10-27):** the new CI step blocks the build, like the stable one; the multi-root run is on the latest stable VS Code only, not the 1.100.0 floor.

</frozen-after-approval>

## Code Map

- `.vscode-test.mjs` -- add `{ label: 'multiroot', files: 'out/test/integration-multiroot/index.multiroot.js', workspaceFolder: 'test/multiroot/multiroot.code-workspace', mocha: shared.mocha }`; `stable`/`floor` unchanged (`files` glob does not match the new entry).
- `test/multiroot/` (new fixture) -- `multiroot.code-workspace` (folders `a`, `b`, no settings), `a/pipe.yaml`, `b/pipe.yaml` (a `mapping` processor so the live parse and test panel apply), `a/.env`, `b/.env`.
- `src/test/integration-multiroot/index.multiroot.ts` (new) -- root `suiteSetup` as `src/test/integration/index.test.ts:26-28` (`autoOpenGraph` false, Global); imports the suite.
- `src/test/integration-multiroot/suites/settings.ts` (new) -- the matrix. Settings via `vscode.workspace.getConfiguration('redpandaConnect', folderUri).update('envFile', '.env', ConfigurationTarget.WorkspaceFolder)` / `ConfigurationTarget.Workspace`, cleared with `undefined` in teardown.
- `src/test/helpers/fakeBinary.ts` -- reuse `makeTempDir` (:6), `writeFakeBinary` (:11), `connectScript` (:101), `bloblParseBody(capture)` (:191, writes `<capture>/blobl-argv`), `mappingTestRunBody(capture)` (:155, writes `<capture>/argv`); lint and Run bodies get a `printf '%s\n' "$*" >> <capture>/<cmd>-argv` line.
- How existing suites drive each feature (copy their calls, not their no-folder assumptions): lint `src/test/integration/suites/50-lint.ts` (`suiteSetup` sets `binaryPath` :62); Run `60-run.ts:57` (RUN / STOP / RERUN, output seam `RunController.outputOf`); live parse `91-bloblang-diagnostics.ts:480` (`bloblArgv` :104); test panel `90-bloblang-panel.ts:973` (`lastRunArgv` :132).
- `.github/workflows/ci.yml` (~:48) -- a step "VS Code tests (multi-root)" after the stable one: `scripts/vscode-test-ci.sh multiroot`.
- Not to change: `src/adapters/**`, `src/test/integration/**`.

## Tasks & Acceptance

**Execution:**
- [x] `test/multiroot/**` -- the fixture workspace.
- [x] `src/test/integration-multiroot/index.multiroot.ts`, `src/test/integration-multiroot/suites/settings.ts` -- the entry and the matrix's tests.
- [x] `.vscode-test.mjs` -- the `multiroot` label.
- [x] `.github/workflows/ci.yml` -- the CI step.
- [x] `README.md` / `CONTRIBUTING.md` (where test runs are described, if anywhere) -- the new label.

**Acceptance Criteria:**
- Given the change, when `xvfb-run -a npx vscode-test --label multiroot` runs, then every matrix test passes, and a deliberately wrong folder lookup (e.g. `definingFolder` returning `undefined`) makes FOLDER_VALUE fail.
- Given the change, when the stable run runs alone, then it passes with the same test count as before.

## Implementation Notes

- Fixture `test/multiroot/` (workspace file, `a`/`b` with `pipe.yaml` and `.env`); entry `src/test/integration-multiroot/index.multiroot.ts`; suite `suites/settings.ts`: `exercise(folder)` lints on save (a newline added and removed, both saved), runs, test-runs and live-parses the folder's config and returns each command's `--env-file`; a feature that ran nothing fails its test. FOLDER_VALUE, OTHER_FOLDER, WORKSPACE_VALUE; EXISTING_RUNS is the stable run, unchanged.
- `.vscode-test.mjs` label `multiroot` (latest stable); CI step "VS Code tests (multi-root)", blocking; README's Development section.
- Multiroot run: 3 passing. With `definingFolder` returning `undefined`: FOLDER_VALUE fails (B's config got `a/.env`), the other two pass; restored.

## Plan Change Log

## Review Triage Log

Quick review. Verdicts: 0 high, 0 medium, 3 low, 1 false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The mutation check and the stable count are not recorded | false | reject | Both were run (Implementation Notes, Verification). |
| 2 | An aborted run's folder settings survive the next run's teardown (only empty ones were removed) | low | patch | The teardown removes `a/.vscode` and `b/.vscode` whatever they hold (the fixture has none). A leftover workspace value or edited `pipe.yaml` still shows in `git status`; each test clears the three levels first. |
| 3 | A repo path with a space breaks `envFileOf` (argv logged with `$*`) | low | reject | Rare (CI and this checkout have none); the fix changes the shared fake helpers' logging. |
| 4 | A `suiteSetup` that fails before the temp dir adds a TypeError in `suiteTeardown` | low | patch | `dir` removed only when set. |

## Verification

**Commands:**
- `npm run pretest && xvfb-run -a npx vscode-test --label multiroot` -- expected: all pass.
- `xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass, 946 tests.


Result (2026-10-27): multiroot 3 passing; stable (alone) 946 passing.
