---
title: 'Environment variables set in the settings reach lint, Run, the live Bloblang check and the test panel'
type: 'feature'
ticket: '29'
created: '2026-10-27'
status: done
baseline_revision: '6b4abd39f4f9b448c0396d9a06108130d9bf5abe'
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

**Problem:** A config's `${VAR}` values come only from the `redpandaConnect.envFile` file or the environment VS Code was started with, so changing one means editing a separate file or restarting VS Code from a shell.

**Approach:** A new resource-scoped setting, `redpandaConnect.env`, holds variables as `KEY: value` strings (user, workspace and folder values merged by key, the most specific winning). For each command (lint, Run, the live Bloblang check, the test panel) the extension writes the config's merged, valid variables to an env file in its own storage and passes it as the last `--env-file`, after `envFile`'s, so the setting wins over the env file and VS Code's environment (probed on 4.100.0 and 4.112.0: `--env-file` beats the process environment, the last of several wins). With the setting empty, nothing changes.

**Decisions (user, 2026-10-27):** the setting wins over `envFile` and VS Code's environment; levels merge by key; the values reach the binary through that generated env file (not the process environment, not by parsing the user's env file).

## Boundaries & Constraints

**Always:**
- The generated file: `KEY="value"` lines with `\\`, `\"`, `\n`, `\r` escaped (probed: round-trips exactly on both binaries, `${…}` in a value is not expanded); in a folder under the extension's global storage; owner-only permissions (0600, folder 0700); named by its content, so the same variables reuse one file and a change makes a new one; files no longer current are removed at activation only (a running command may still be starting on one).
- Keys must match `[A-Za-z_][A-Za-z0-9_]*` and values be strings; others are left out and logged once per distinct setting value, naming the keys, never the values.
- A change of the setting clears the live Bloblang check's cache, as an `envFile` change does.
- Values are never written to the output channel or an error message.

**Never:**
- Changing `envFile`'s path rules, the existing argv order before the new flag, or any argv when the setting is empty. Secrets and UI (ticket 30).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| EVERY_COMMAND | `env: {API_TOKEN: "t"}` | lint, Run, live parse, test run each get `--env-file <generated>` as the last env file, holding `API_TOKEN="t"` | none |
| WINS | same name in `env`, the `envFile` file and the process env | the pipeline sees the setting's value; names only the file or the process env sets still arrive | none |
| MERGE | user `{A,B}`, folder b `{B,C}` | a config in b gets A (user), B and C (b); a config in a gets A and B | none |
| CHANGED | the setting edited | the next command gets a new file with the new values; the live check re-parses | none |
| INVALID | `{"1X": "v", "OK": 5, "GOOD": "g"}` | only `GOOD` passed; one log line naming `1X` and `OK` | logged once per value |
| EMPTY | unset or `{}` | argv and env exactly as today | none |
| WRITE_FAILS | storage not writable | the command does not run; the reason is logged and shown as that command's existing failure (no silent drop of the user's variables) | logged |
| ESCAPES | values with spaces, `#`, `"`, `\`, newline, `$`, unicode, empty | the pipeline sees each value exactly | none |

</frozen-after-approval>

## Code Map

- `package.json` -- `contributes.configuration`: `redpandaConnect.env`, `type: object`, `additionalProperties: {type: string}`, `default: {}`, `scope: resource`, a description (precedence; plain text in settings.json, secrets belong in the env file). VS Code's `WorkspaceConfiguration.get` merges object values across levels (MERGE): confirm in a test.
- `src/core/args.ts` -- `fileFlags(resourceFiles, envFile)` (~:88) and `ArgvInput.envFile`: take env files as a list (`envFile` then the generated one), keeping today's order and output for one or none; `buildLintArgs`/`buildRunArgs`/`buildBloblArgs` callers.
- `src/adapters/redpandaConnect/commandLine.ts` -- `CommandSettings` (~:62): add the generated file's path provider (`settingEnvFile: () => EnvFileResult`-like, a failure maps to a new `ArgsFailure` kind with `describeArgsFailure` text); `buildCommandLine`/`buildBloblCommandLine` pass both files. No `vscode` import here (the corpus harness uses it with plain values: its settings omit the new provider, meaning none).
- `src/adapters/redpandaConnect/args.ts` -- `defaultArgsEnvironment(resource)` (~:81): read `config.get('env')`; `commandSettings` (~:69): build the provider (validate, encode, write content-addressed under the storage dir, cache by content). The storage dir comes from `context.globalStorageUri.fsPath` (`src/extension.ts:155/170/206` already pass it); a small module beside `args.ts` (e.g. `envSetting.ts`) holds validation, encoding (pure, unit-tested) and the write.
- `src/adapters/vscode/bloblangDiagnostics.ts:160` -- also reset on `affectsConfiguration('redpandaConnect.env')`.
- `src/extension.ts` -- activation: remove generated files that are not current.
- Tests: unit (`src/test/core/args.test.ts`, `src/test/adapters/redpandaConnect/args.test.ts` patterns): encoding (ESCAPES), validation (INVALID), flag order (EVERY_COMMAND, EMPTY). Integration: suite 91's env-file test (`91-bloblang-diagnostics.ts:480`) and suite 90's (`90-bloblang-panel.ts:973`) patterns for live parse and test run; suite 50/60 fake binaries record argv; the multi-root run (`src/test/integration-multiroot/suites/settings.ts`, ticket 28) for MERGE; the real-binary suite `61-run-real.ts` for WINS and ESCAPES (a real `run` printing the values).
- Docs: `README.md` settings table and the env paragraphs; `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- the setting.
- [x] `src/core/args.ts` -- env files as a list.
- [x] `src/adapters/redpandaConnect/envSetting.ts` (new), `args.ts`, `commandLine.ts` -- read, validate, encode, write, pass.
- [x] `src/adapters/vscode/bloblangDiagnostics.ts`, `src/extension.ts` -- cache reset; sweep at activation.
- [x] Tests for every matrix row (unit where pure; integration for EVERY_COMMAND, CHANGED, WRITE_FAILS; multi-root for MERGE; real binary for WINS and ESCAPES).
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when compile, the unit tests, the stable, multi-root and corpus runs execute, then all pass, and the existing tests' argv expectations are unchanged.

## Implementation Notes

- The storage folder reaches lint and Run (which have no `storageDir`) through `envSetting.ts`'s `setActiveEnvSettingFiles`, set at activation; `defaultArgsEnvironment` reads it. Without it (outside the extension) a non-empty setting is an `envSettingUnwritable` failure, not a silent drop.
- New `ArgsFailure` kind `envSettingUnwritable { path, reason }`; `reason` is the fs error text (it names the path, never a value).
- Writes are atomic (temp file + rename); a file that exists is reused, so a file another window's sweep removed is written again.
- Lint's fake-binary coverage of the setting is in the multi-root suite (every command) plus unit tests; suite 50's fake records no argv.

## Plan Change Log

## Review Triage Log

Quick review. Verdicts: 0 high, 2 medium, 3 low.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Global storage is shared by every window: one window's activation sweep removes files (and `.tmp-*`) another window uses or is about to spawn with | medium | patch | The sweep removes only files not current in this window and untouched for a day; `write()` refreshes a file's mtime each time it returns it. |
| 2 | The file name is an unsalted sha256 of the content, visible in argv (`ps`, Run's `$ …` line): a short value can be confirmed offline | medium | patch | HMAC-SHA256 with a random key kept in the folder (0600, created once); still one name per content. |
| 3 | README groups the test panel's write failure under "live checks" in the output channel | low | patch | The panel shows it as its run's error result ("The test could not run"), its existing failure; it is not logged (the review assumed `tell`). README says so. |
| 4 | WRITE_FAILS has an integration test only for Run; no lint INVALID logging check | low | patch | Tests for the live parse, the test panel run and lint's log line. |
| 5 | Suite 60's "no value is logged" check uses one-letter values its regex cannot really catch | low | patch | Distinctive values, asserted absent from every output line. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot` -- expected: all pass.
- `npm run test:corpus` -- expected: passes (the harness passes no setting).

**Manual checks:**
- Dev host on 1.143.1: `redpandaConnect.env` with a variable the config uses, also set differently in the `.env` file: Run prints the setting's value; edit the setting, Run again: the new value, no restart.

Result (2026-10-27, after the review patches): stable 969 passing; multiroot 5 passing; corpus 156 passed. Manual check: done by the user on the 1.143.1 dev host (2026-10-27), no issues.
