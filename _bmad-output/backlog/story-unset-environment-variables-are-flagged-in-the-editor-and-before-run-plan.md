---
title: 'Unset environment variables are flagged in the editor and before Run'
type: 'feature'
ticket: '46'
created: '2026-11-10'
status: 'done'
baseline_revision: '32b8dfb7e82aff5594733a116adf1d75f25a5fb1'
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

**Problem:** A config using `${NAME}` with no default, when no local source sets `NAME`, shows nothing in the editor; Run then fails with `required environment variables were not set: [NAME]` and exit 1 (lint skips the check on purpose, AD-9).

**Approach:** A Warning at each reference the binary would stop on, computed by the extension with the binary's rules (tested on 4.112.0, below), with a quick fix that sets the variable; Run refuses before starting the binary, naming every such variable and offering to set them. Deploy unchanged.

**Decisions (user, 2026-11-10):** Warning, not Error; Run refuses, with no "Run anyway". Lint keeps `--skip-env-var-check`. `${secrets.NAME}` with no default is warned and refused (no quick fix). Run's check includes the resource files' references; they are not shown on the config that uses them.

**The binary's rules (rpk connect 4.112.0, tested):** it stops on `${NAME}` with no default (`${NAME:}` and `${NAME:x}` are defaults), also inside YAML comments, also `$${NAME}` (not an escape), and in the files passed as resources; not on `env("NAME")`, `${! … }` or `${A:${B}}`. A name set to an empty value counts as set.

## Boundaries & Constraints

**Always:** names only in every Warning, fix and message, never a value; the flagged names for a config and its sources equal the names the binary lists; the four local sources and their precedence as the Environment view reads them (setting, env file, secret, VS Code's environment); the Warnings follow edits, the settings, the secrets and the env file without save or reopen.

**Never:** a change to lint's flags or findings, the live Bloblang errors, the Environment view, the hover, the test panel or Deploy; the Warnings on graph nodes (AD-17 unchanged); a new dependency; a floor (1.100.0) run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| UNSET | `${A}`, A in no source | a Warning at each `${A}` naming A: a local Run stops on it; Deploy reads it from the cluster's secrets | none |
| SET | A in any source, including an empty value | no Warning | none |
| DEFAULT | `${A:x}`, `${A:}` | no Warning | none |
| NOT_REF | `env("A")`, `${! A }`, `${A:${B}}` | no Warning | none |
| COMMENT_ESCAPED | `# ${A}`, `$${A}`, A unset | a Warning, as the binary stops on them | none |
| SECRETS_REF | `${secrets.A}` with no default | a Warning naming `secrets.A`: a local Run cannot set it, only the Cloud does; no quick fix; Run refuses naming it | none |
| FOLLOWS | A set or removed in any source, or the text edited | the Warning appears or goes, without save or reopen | none |
| FIX | the quick fix on a Warning | sets A (plain or secret) for the config's folder through the existing command; the Warning goes | Escape: nothing changes |
| RUN_REFUSED | Run with unset variables | no process starts; one message names every one and offers to set them; once set, Run starts as today | none |
| RESOURCES | an unset reference in a resource file | Run's check names it too; the resource file, when open as a detected config, gets its own Warnings | none |
| MATCHES_BINARY | each case above, both pinned binaries | the computed names equal the binary's `not set` list | none |

</frozen-after-approval>

## Code Map

- `src/core/envUsage.ts` -- `REFERENCE` :15 (the binary's pattern), `envUsage` :27 (counts `env("NAME")` as required :37 — exclude it here), name filter :18 (drops `secrets.X`, `1A`), `envReferenceAt` :79 (one use with offsets; add an "every reference with its range" variant).
- `src/adapters/vscode/environmentModel.ts` -- `environmentModel()` :93 (precedence; empty counts as set), `missing` :147. Do not use `environmentView.ts` `localValues` :466 (drops empty values, for Deploy).
- `src/adapters/vscode/environmentView.ts` -- `inputsFor` :808 (settings per folder, secrets, env file, process env), `modelFor` :457, events :346-370, env file `watch` :877 (current config only), `SET_MISSING_COMMAND` :65 (`(name, uri)`, asks plain or secret; used by the hover) — the quick fix's command.
- `src/adapters/vscode/cloudView.ts` :534 / `cloudDeploy.ts` :50 -- a standalone diagnostic collection off the graph, the precedent. Graph reads only `diagnostics.ts` `diagnosticsFor` :163 (leave it).
- `src/adapters/vscode/quickFix.ts` :25, registered `extension.ts`:169 -- code action pattern; the new action sets `command`.
- `src/adapters/vscode/run.ts` -- `run` :246, `start` :325 (save :327, binary check :331-339, argv :340, refusal style :344, info refusals :254-265, mask :192, stop previous :348 — the check goes before it); `RunHost` :88 (add a prompt with a button); built at `extension.ts`:250 (pass a `missing(uri)`).
- `src/core/bloblangRun.ts` `missingVariablesOf` :141 -- reads the not-set list; drops `secrets.A`, `1A`.
- Tests: `src/test/core/envUsage.test.ts`, `src/test/adapters/vscode/environmentModel.test.ts`, `run.test.ts`; `test/corpus/corpus.test.ts` (real pinned binaries 4.100.0 and 4.112.0, no VS Code — MATCHES_BINARY); integration `95-environment-view.ts`, `60-run.ts` (fake binary), `82-graph-markers.ts` (no new markers), multi-root `integration-multiroot/suites/environment.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/envUsage.ts` -- every reference the binary stops on, with its range, by the rules above.
- [x] a new `src/adapters/vscode/unsetVariables.ts` -- the Warning collection for detected configs, updated on the events above (an env file watcher per open config), and its code action running `SET_MISSING_COMMAND` with `[name, uri]`; registered in `extension.ts`.
- [x] `src/adapters/vscode/run.ts`, `extension.ts` -- the pre-start check and the refusal with "Set…".
- [x] tests per matrix row: unit (core, model, run), corpus (MATCHES_BINARY on both binaries), integration (UNSET, FOLLOWS, FIX, RUN_REFUSED, no graph marker), multi-root (per folder).
- [x] `README.md`, `CHANGELOG.md` -- the Warning and the Run check.

**Acceptance Criteria:**
- Given a config whose every variable is set, when it is open and run, then no Warning shows and Run starts as today.
- Given the existing Environment view, hover, lint, run and graph marker tests, when the suites run, then they pass unchanged.

## Implementation Notes

- Recorded by the orchestrator from the implementer's report (2026-11-10). `envUsage.ts` `requiredReferences(text)`: every reference the binary stops on, with its range (comments and `$${}` included; `${A:x}`, `${A:}`, `${A:${B}}`, `${! }` and `env()` skipped); `envUsage` untouched. `environmentModel.ts` `unsetNames(inputs, names)`: the model's precedence (empty counts as set, the extension's `NO_COLOR` counts); a `secrets.*` name is always unset. `environmentView.ts`: one read-only `inputsAt(uri)`. New `unsetVariables.ts`: its own collection (source "Redpanda Connect environment", Warning), open detected `file:` and `untitled:` configs only (Cloud pipelines skipped), updated on edits (300 ms debounce), the three settings, the secrets, folder changes and a watcher per open config's env file; quick fix "Set NAME…" runs `SET_MISSING_COMMAND` with `[name, uri]` (none for `secrets.*` or names a setting cannot hold, such as `1A`); `forRun(uri)` adds the resource files' names. `run.ts`: the check after the argv, before a running pipeline is stopped; one message naming every name with Set… (each in turn; Escape stops), no button when only `secrets.*` names; Run does not start by itself after setting. New corpus test `test/corpus/unsetVariables.test.ts` (MATCHES_BINARY on both pinned binaries, per file and in order).
- Known differences from the binary, documented in the corpus test: a `${secrets.X}` that VS Code's environment sets is still warned (the user's decision); with an env file the binary rejects, its variables are reported unset, while the binary fails on the file first.
- Warnings stay on a closed editor until VS Code releases the document, as lint's do.
- Implementer's runs: compile 0; corpus 176; webview 378; stable 1392 passing, 1 pending; multi-root 11.

## Plan Change Log

- `60-run.ts`: ticket 30's secret test used `"${SECRET_30}"` and expected Run to start with it unset. Run now refuses that by design, so the test uses `env("SECRET_30")`, which keeps what it checks (the secret reaching the process). Every other existing test is unchanged.

## Review Triage Log

Quick review (2026-11-10): 0 high, 2 medium, 3 low patched, 1 rejected.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | A glob entry in `resourceFiles` is read as one file; its references are skipped silently and Run starts, then the binary stops | medium | package.json and README allow globs; `forRun` reads `Uri.file(entry)`, `textOf` returns '' on the throw; no glob test | patch (expand entries as Go `filepath.Glob`, no dependency; tests). Routed as a patch, not a plan loopback: one private helper, no public surface |
| 2 | Run's check reads unsaved resource files; the binary reads the disk | low | `textOf` prefers the open document; `start` saves only the config | patch (resources read from disk) |
| 3 | A file detected only through Show graph's mark shows no Warnings when reopened | medium | no `onDidOpenTextDocument`; `markDetected` keeps the URI detected, so reopening fires no detection change | patch (update on open) |
| 4 | "Existing run tests pass unchanged" not met: ticket 30's test changed | low | the change is recorded in the Plan Change Log; Run refusing `${SECRET_30}` unset is the intended behavior | reject (the fix edits this plan) |
| 5 | Set… goes on after a different name was set (the secret path lets the name be edited) | low | `refuseUnset` treats any non-undefined result as success | patch (recheck the name; stop the chain if still unset) |
| 6 | A second Run during the refusal stacks a second refusal and Set… chain | low | `void this.refuseUnset(...)`; `busy` cleared before the prompt is answered | patch (one refusal per file at a time; a test) |
| 7 | (orchestrator, after patch 6) A refusal moved to the notification center keeps its promise open, so later Runs of that file show nothing | low | the guard only logged while a refusal was open | patch (a plain message with no buttons naming the variables; the unit test) |
| 8 | (orchestrator's full run) FOLLOWS failed once: an env file written right after `envFile` was set left its Warning | medium | a new file watcher goes live later in the main process, longer for a folder outside the workspace; a write in that gap fires no event | patch (a new env file watcher's configs read again at 0.5, 2 and 5 s; cleared on dispose); the test unchanged; the next full run passed |

## Verification

**Commands:**
- `npm run compile` -- expected: 0, lint included.
- `npm run test:corpus`; `npm run test:webview` -- expected: pass.
- `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); then `--label multiroot` -- expected: all pass. No floor run.

**Result (2026-11-10, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182 (MATCHES_BINARY on both pinned binaries, glob entries included), webview 378, stable 1397 passing, 1 pending, 0 failing, multi-root 11; the test settings clean; no floor run. The run before the watcher fix had 1 failing (FOLLOWS, triage row 8).

**Manual checks:**
- Dev host 1.143.1: `mask44.yaml` with `MASK44_KEY` unset shows the Warning; its quick fix sets it and the Warning goes; Run with it unset is refused with Set…

