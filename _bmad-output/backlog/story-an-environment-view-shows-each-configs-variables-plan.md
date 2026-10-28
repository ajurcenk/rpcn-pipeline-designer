---
title: 'An Environment view shows each config''s variables, their sources and the missing ones'
type: 'feature'
ticket: '31'
created: '2026-10-28'
status: done
baseline_revision: '3e34f8f5d61efd082d3075b719443775a5a1cf61'
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

**Problem:** After tickets 29 and 30, a config's variables come from four places (the `env` setting, secrets, the env file, VS Code's environment) and nothing shows which value a config gets, which one is overridden, or which variable it uses that nothing sets.

**Approach:** A Redpanda Connect container in the Activity Bar holds an Environment tree view for the active detected config (the last one, when another editor is active). It groups the variables by source, marks the one each command gets and crosses out the overridden ones, masks secret and env-file values (shown in clear only on request, for that variable alone), and lists the variables the config uses that nothing sets, each with an action that sets it as a plain or a secret variable. Actions add, edit and remove variables through ticket 29's setting and ticket 30's secret commands, and open the env file. The view only reads; how variables reach the commands does not change. The test panel's set button is ticket 32, which reuses this set action.

**Decisions (user, 2026-10-28):** "used" is `${VAR}` in the YAML (`${VAR:default}` has a default, so never missing) plus Bloblang's `env("VAR")` with a literal name; the env file's names are listed with their values masked, read with the binary's strict `NAME=value` form, and a line the binary would reject is flagged (the binary then ignores the whole file). The test panel's set button is split off as ticket 32. Earlier (2026-10-27): split from ticket 30; option B (sidebar view) over the full editor panel.

## Boundaries & Constraints

**Always:**
- Precedence shown is the commands' own: `redpandaConnect.env` (the generated file, last) over the env file over secrets over VS Code's environment.
- No value in a log line or message; masked values everywhere in the view until "Show value" for that one row, hidden again on "Hide" and when the view refreshes.
- The env file is read for display only, with the strict form the binary accepts (probed 2026-10-28: `export NAME=`, `NAME: v` fail the file; spaces around `=` or leading spaces make it apply nothing).
- Refreshes on: active editor change, the config's edits (debounced like the live check), a change of `env`, `secretEnv`, `envFile`, a secret, or the env file on disk.
- Keyboard and screen-reader use: tree items have labels saying source, state (used / overridden / missing / secret) and value masked.

**Never:**
- Changing argv, process environment or precedence (tickets 29 and 30); a webview for the view; editing the env file's contents.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SOURCES | a config in folder b; `env` {TOPIC}, secret API_TOKEN, `.env` {API_TOKEN, BROKERS}, VS Code env HOME used | four groups; `.env` API_TOKEN marked used over the secret (overridden, crossed out); TOPIC, BROKERS, HOME used | none |
| MASK | a secret or env-file row | value shown as `••••••••`; "Show value" reveals that row only; refresh hides it | none |
| MISSING | config uses `${REGION}` and `env("ZONE")`, nothing sets them; `${PORT:8080}` | REGION and ZONE under Missing with a set action; PORT not missing | none |
| SET_MISSING | the set action on REGION | asks plain or secret; plain → value written to the folder's `redpandaConnect.env`; secret → ticket 30's set flow with the name prefilled; the view updates | input cancelled: nothing changes |
| ACTIONS | add / edit / remove on rows; open env file | plain rows through `redpandaConnect.env` at the level they came from; secret rows through ticket 30's commands; open shows the file | a settings write failure is shown (no value in it) |
| BAD_ENV_FILE | `.env` holds a line the binary rejects | the env file group says the binary will not use the file, naming the line number | none |
| NO_CONFIG | no detected config has been active | the view says to open a Redpanda Connect config | none |
| NO_CHANGE | view open or closed | lint, Run, live check and test panel argv and environment are as tickets 29 and 30 give | none |

</frozen-after-approval>

## Code Map

- `package.json` -- `viewsContainers.activitybar` (id `redpandaConnect`, an icon file, e.g. `media/redpanda-connect.svg`; check whether 1.100 accepts a `$(codicon)` for a container, else ship the SVG), `views.redpandaConnect` (`redpandaConnect.environment`, tree), commands for add / edit / remove / show value / hide value / open env file / set missing, `view/title` and `view/item/context` menus by `contextValue`.
- New `src/core/envUsage.ts` (pure): names used by a config text: `${NAME}` and `${NAME:default}` (default = never missing), `env("NAME")` / `env('NAME')` with literal names; unit-tested.
- New `src/core/envFileRead.ts` (pure): strict `NAME=value` parse matching the binary (quoted values with the escapes ticket 29 writes; comment and blank lines), with the first rejected line; unit-tested against the probe's cases.
- New `src/adapters/vscode/environmentView.ts` -- `TreeDataProvider`: sources from `vscode.workspace.getConfiguration('redpandaConnect', uri)` (`env` with `inspect` for the level, `secretEnv`, `envFile` through `args.ts`'s resolution), secret values from ticket 30's `SecretValues` (`src/adapters/redpandaConnect/secretEnv.ts`), the env file through `envFileRead`, VS Code's environment (`process.env`, used names only); precedence and states computed in a pure function beside it; reveal state per row in memory.
- `src/adapters/vscode/secrets.ts` -- reuse `set` / `remove` / `setAndTell` (~:181–:313); add a name-prefilled entry for SET_MISSING. Make SET_MISSING one command taking a name (ticket 32's panel button will call it).
- Plain variable writes: a small helper writing one key into `redpandaConnect.env` at a `ConfigurationTarget` (object setting: read the level's value with `inspect`, change one key, update that level).
- `src/extension.ts` -- register the view and commands; a test seam on `ExtensionApi` (the provider's items, test mode only, as ticket 30's).
- Tests: unit for `envUsage`, `envFileRead`, the precedence function; integration (a new suite or in suite 60's area) for SOURCES, MASK, MISSING, SET_MISSING, ACTIONS, BAD_ENV_FILE, NO_CONFIG through the seam; the multi-root run for a folder's sources.
- Docs: `README.md` (the view in the env section), `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- container, view, commands, menus, icon.
- [x] `src/core/envUsage.ts`, `src/core/envFileRead.ts` -- pure readers with unit tests.
- [x] `environmentView.ts`, `secrets.ts`, `extension.ts` -- the view, actions, refresh, seam.
- [x] Tests for every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when compile, the unit, stable, multi-root and corpus runs execute, then all pass and tickets 29 and 30's tests are unchanged.

## Implementation Notes

- Env file rules re-probed 2026-10-28 on 4.100.0 (`redpanda-connect`) and 4.112.0 (`rpk connect`), `run` and `blobl` alike: spaces around `=` are accepted (`A = 1` sets A); a line starting with a space makes the binary stop there (that line and every later line apply nothing); trailing text after a value (`A=1 2`, `A="x" y`) keeps the value and stops after that line; `export A=1`, `A: 1`, a bare `A`, an unclosed quote or a Go-invalid escape (`\$`) reject the whole file; a key that is not a valid name (`1A`, `A.b`, a tab) is skipped. `envFileRead.ts` follows these (`rejected` / `stops` problems), so "spaces around `=` apply nothing" from the earlier probe does not hold; ticket 30's `envFileNames` (`^NAME=`) is unchanged.
- `${NAME}` usage follows the binary's own regex; `$${NAME}` is not an escape and comments count (both probed).
- VS Code environment values are masked too (with show/hide), beyond the plan's "secret and env-file": the process environment can hold tokens.
- `SecretVariables.setCommand(prefill?, input?)` now takes the folder and a name to prefill (ticket 32 reuses `redpandaConnect.setMissingVariable`, `(name | item, configUri?)`).
- Review fixes: `NO_COLOR=1` (every command's, `commandLine.ts`) is an `extension` source between the env file and the secrets; a new plain variable's level is chosen by the number of workspace folders; the view watches the env file from construction; ticket 30's `envFileNames` now uses `envFileRead.ts` (spaced `=` applied; a rejected file sets no name), so its old one-input test was split per rejected form.
- `args.ts` exports `envFileFor(resource)` (the commands' own `envFile` resolution); nothing else in `args.ts` changes.
- Strikethrough is a combining U+0336 after each label character (the tree API has none); the screen-reader label is the plain name with source, state and "value masked".

## Plan Change Log

- 2026-10-28, during implementation: the Always rule's probe note ("spaces around `=` or leading spaces make it apply nothing") is wrong. Re-probed on 4.100.0 and 4.112.0: `A = 1` sets A; a line starting with a space makes the binary stop reading there (the earlier probe's spaced line was first, so nothing applied). The reader follows the binaries; the frozen wording is left as approved.

## Review Triage Log

Quick review. Verdicts: 0 high, 1 medium, 6 low. No value reaches a label, tooltip, accessibility label, log line, message or the test seam outside test mode; the shown precedence matches the argv and environment, except NO_COLOR.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The config active at activation is never refreshed, so its env file is not watched until something else refreshes the view | medium | patch | Refresh on register; a test with an on-disk env file change and no settings write. |
| 2 | Commands always get `NO_COLOR=1`; the view shows VS Code's value or lists it missing | low | patch | NO_COLOR modelled as `1` from the extension, in the real order. |
| 3 | The leading-space note says only the following variables are unset; that line is unset too | low | patch | Note says line N and after. |
| 4 | No test for Add variable | low | patch | Plain and secret add tests. |
| 5 | NO_CHANGE compares only lint's command line across a reveal | low | patch | Lint, run, blobl and test run, view unused against used. |
| 6 | A single folder opened through a `.code-workspace` writes at folder level, unlike the README | low | patch | The level by the number of folders. |
| 7 | Ticket 30's clash scan (`^NAME=`) disagrees with the new reader for `NAME = v` | low | patch | `envFileNames` reads with `envFileRead`; the deferred-work entry of 2026-10-28 is resolved here. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot` -- expected: all pass.
- `npm run test:corpus` -- expected: passes.

**Manual checks:**
- Dev host on 1.143.1: the view on a config with all four sources; reveal/hide; a missing `${REGION}` set as plain and as secret; a bad `.env` line flagged; keyboard only and with a screen reader (Orca), the items read their state.

Result (2026-10-28, after the review patches): stable 1030 passing; multiroot 7 passing; corpus 156 passed; webview 311 passed. Manual checks: done by the user on the 1.143.1 dev host (2026-10-28), example folder .vscode-test/manual-env-view, no issues.
