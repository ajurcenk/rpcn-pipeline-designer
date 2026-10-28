---
title: 'Secret environment variables kept in the secret storage reach every command'
type: 'feature'
ticket: '30'
created: '2026-10-27'
status: done
baseline_revision: '9a9da717f1ae80a73344aae9e36690bc4bf7dd22'
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

**Problem:** Ticket 29's `redpandaConnect.env` keeps values in plain text in settings files, which is wrong for tokens and passwords.

**Approach:** A new resource-scoped list setting, `redpandaConnect.secretEnv`, declares secret names (safe to commit). Their values live in VS Code's secret storage on this machine, per workspace folder (or for the window when no folder is open), set, changed and removed by three commands: "Set secret variable" (a name, then the value in a password input; the name is added to the folder's `secretEnv`), "Remove secret variable" and "Clear stored secrets". Lint, Run, the live Bloblang check and the test panel get each declared secret that has a value in their child process environment, never a file, so the env file's or `env`'s value wins for the same name (told once, by name). A declared name without a value here is told once, by name. No value is ever written to the output channel, a message or a test panel result.

**Decisions (user, 2026-10-27):** split from the Environment view (ticket 31); names in the `secretEnv` setting, `env` stays strings only; secrets through the process environment only.

## Boundaries & Constraints

**Always:**
- Commands build their environment synchronously: the extension keeps the values of the declared names in memory, loaded at activation and refreshed on the secret storage's change event and on a `secretEnv` change; a command started before a load finishes gets what is loaded.
- The value input uses `password: true`; the name must match ticket 29's rule (`[A-Za-z_][A-Za-z0-9_]*`), checked in the input.
- The secret storage cannot list its keys on 1.100: the extension records the keys it stored in its global state (not synced) for "Clear stored secrets", which asks for confirmation first.
- A secret or `secretEnv` change clears the live Bloblang check's cache.
- The env file is read for its names only, to tell a clash; nothing else reads it.

**Never:**
- A secret value on disk, in an argv, in a log line or in a message; changing ticket 29's argv or precedence; the sidebar view (ticket 31).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SET | "Set secret variable", folder b, `API_TOKEN`, value | value in the secret storage for b; `API_TOKEN` in b's `secretEnv`; no settings file holds the value | an invalid name is refused in the input |
| EVERY_COMMAND | a declared secret with a value | lint, Run, live parse and test run each have it in their process environment; no file the extension writes holds it | none |
| NO_VALUE | name declared, no value here | commands run without it; one log line names it and the set command | logged once per name and folder |
| CLASH | the name also in the env file or `env` | the other value wins; one log line names the variable and the source that wins | logged once |
| CHANGE / REMOVE | set again, or removed | the next command gets the new value or none, no restart; the live check re-parses | none |
| CLEAR | "Clear stored secrets", confirmed | every recorded key removed from the secret storage | cancel removes nothing |
| NO_LEAK | a failing command, a binary error, a log line | no secret value in any output line, message or panel result | none |
| EMPTY | `secretEnv` unset or `[]` | argv and environment exactly as ticket 29 | none |
| STORE_FAILS | the secret storage rejects | the set command shows an error (no value in it) and stores nothing; commands run with what is loaded | logged |

**Decision (user, 2026-10-28, after review):** text from the binary is masked too: each loaded secret value of the config's folder (4 characters or longer) is replaced with `•••••` in output-channel lines, error and info messages and the test panel's error results; the pipeline's own data (the test panel's successful output, Run's terminal) is shown as produced.

</frozen-after-approval>

## Code Map

- `package.json` -- `redpandaConnect.secretEnv` (`type: array`, `items: {type: string}`, `default: []`, `scope: resource`; description: names only, values in the secret storage, per machine; lists do not merge across levels); commands `redpandaConnect.setSecret`, `removeSecret`, `clearSecrets` with titles and `commandPalette` entries.
- `src/adapters/redpandaConnect/args.ts` -- `defaultArgsEnvironment(resource)` (~:81): `processEnv` becomes `{...process.env, ...secrets for the config's folder and its declared names}`; `secretEnv` read with `config.get`. Ticket 29's names rule lives in `envSetting.ts` (`validateEnvSetting`'s `KEY`): reuse it.
- New `src/adapters/redpandaConnect/secretEnv.ts` (no `vscode` import): name validation, the storage key (`redpandaConnect.secret:<folder URI or window>:<NAME>`), the in-memory values and the once-per-name log lines (NO_VALUE, CLASH), env file name scan (`NAME=` / `export NAME=` lines).
- New `src/adapters/vscode/secrets.ts` -- the `context.secrets` side: load, `onDidChange`, the stored-keys record in `context.globalState`, the three commands (`showQuickPick` for the folder in a multi-root workspace, `showInputBox` for name and value), writing `secretEnv` at `ConfigurationTarget.WorkspaceFolder` (Workspace in a single-folder workspace, Global with none). Expose a test seam on `ExtensionApi` (set/remove/clear without input boxes, and an injectable store if the real secret storage is unusable under the test host).
- `src/extension.ts` -- activation wiring beside `activateEnvSetting` (~:147); the seam on `ExtensionApi` (~:50).
- `src/adapters/vscode/bloblangDiagnostics.ts:160` -- also reset on a secret change and on `redpandaConnect.secretEnv`.
- Tests: unit for `secretEnv.ts`; integration in suites 60 (Run env, fake binary records `env`), 90 (test run), 91 (live parse), 50 (lint), patterns from ticket 29's tests there; multi-root suite for per-folder values; suite 61 (real binary) for EVERY_COMMAND and CLASH through `run`.
- Docs: `README.md` "Environment variables" section and settings table; `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- setting and commands.
- [x] `secretEnv.ts`, `secrets.ts`, `args.ts`, `extension.ts`, `bloblangDiagnostics.ts` -- store, cache, commands, injection, logs, cache reset.
- [x] Tests for every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when compile, unit tests, the stable, multi-root and corpus runs execute, then all pass and ticket 29's tests are unchanged.

## Implementation Notes

- Secrets are added in `args.ts`'s `commandSettings().processEnv` (read once per command line), not as a value in `defaultArgsEnvironment`, which `commandSettings` calls once per settings read. A secret that `redpandaConnect.env` or the env file also sets is still passed (the binary's own precedence lets their `--env-file` win); only the once-per-name warning is kept. The env file scan matches `^NAME=` exactly, as both binaries do.
- "Remove secret variable" removes the value only; the name stays in `secretEnv` (so it is then logged once as having no value). "Set" adds the name at the folder level (multi-root), workspace (one folder) or user (no folder); when that level has no list yet it starts from the effective one, since lists do not merge.
- On 1.143.1 the secret storage briefly returned the previous value after a key was set twice in a row (even after returning the new one), so `secrets.ts` trusts this window's own write over a load for 5 s (`WRITE_SETTLE_MS`), then reloads once so another window's change still arrives.
- A live parse whose debounce ends while "Set" is between storing the value and declaring the name runs without it; the declaration's change re-parses at once. The multi-root test waits for the parses to settle first.
- Masking (review Decision): `maskSecrets` / `SecretValues.mask` in `secretEnv.ts`, applied in the output channel's `log` (all loaded values: a line has no folder), Run's and the test panel's messages (all values) and the panel's non-`ok` results (the config's folder). "Set" offers "No folder" when folders are open; a failing declaration removes the stored value again; recorded-key updates run through one promise chain.
- Test seams: `ExtensionApi.secrets` (only in `ExtensionMode.Test`; set/remove/clear with an injected confirmation); `connectScript({ envCapture })` records named variables of each lint/run/blobl environment. The test host's secret storage works (in memory), so no store is injected except for STORE_FAILS.

## Plan Change Log

## Review Triage Log

Quick review. Verdicts: 1 high, 4 medium, 4 low, 1 false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `ExtensionApi.secrets` is exported in every mode: any installed extension can read every loaded value and set/remove/clear secrets | high | patch | The seam only in `ExtensionMode.Test`. |
| 2 | Text from the binary (lint stderr in log lines, a Bloblang error quoting a value) can carry a secret into the output channel or the panel's error result (NO_LEAK) | medium | intent (user) | Decision (2026-10-28): mask loaded values (4+ characters) in log lines, messages and panel error results; not in the pipeline's data. |
| 3 | A secret also set in the env file or `env` is left out; the env-file name scan accepts `export NAME=` and spaced lines the binaries reject, so a line the binary ignores can drop a secret | medium | patch | Probed 2026-10-28 (`export X=`, `X: v` fail the file; spaced lines make it apply nothing): always pass the secret, warn only, scan `^NAME=` exactly. |
| 4 | `WRITE_SETTLE_MS`: another window's change inside the 5 s is dropped for good | medium | patch | One reload when the settle window ends. |
| 5 | "Set" reports success when declaring the name fails | medium | patch | The stored value is removed again, the command reports the failure only. |
| 6 | `record()` races between overlapping set/remove, losing a key "Clear" then misses | low | patch | Record updates serialized. |
| 7 | A config outside every folder, with folders open, can never get its secret set | low | patch | "No folder" in the folder pick. |
| 8 | A secret set with no folder is declared in the user settings for every workspace; undocumented | low | patch | README says so. |
| 9 | A command before the first load drops secrets silently | low | patch | One "secrets are still loading" line. |
| 10 | The binary may accept `NAME: value` lines the scan misses | false | — | Probed: both binaries reject the file ("expected Environment variable assignment"). |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot` -- expected: all pass.
- `npm run test:corpus` -- expected: passes.

**Manual checks (hitl):**
- Dev host on 1.143.1 (Linux, GNOME Keyring / libsecret): set a secret, Run prints it via `env()`, the output channel and Run's terminal show no value; set again, remove, clear; reload the window: the secret is still there (after clear: gone). macOS / Windows / Remote-WSL when available.

Result (2026-10-28, after the review patches): stable 990 passing; multiroot 6 passing; corpus 156 passed. Manual checks (hitl): done by the user on Linux, 1.143.1 dev host (2026-10-28), no issues: set, mask, run, set again, reload, remove, clear, settings hold the name only. macOS, Windows and Remote / WSL not run (not available; Windows waits on story 1).
