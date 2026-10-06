---
title: 'Shared lint/run argument builder'
type: 'feature'
ticket: '5'
created: '2026-10-06'
status: 'built'
baseline_revision: '8c15f906cd23c1e2e207af4eecbe7f7879458495'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 2's lint (AD-12) and Run (AD-13) will both start Redpanda Connect with resource files, an env file and lint options; built separately, they would pass different flags and the diagnostics-parity measure would not hold.

**Approach:** One argument builder in the RedpandaConnect adapter turns the resolved `invocation` (from `binaryState`), the target file(s) and the `redpandaConnect.resourceFiles` / `redpandaConnect.envFile` settings into the exact argv and environment for lint and for run; the argv construction is a pure function in `src/core`.

**Decision (port 4195, user 2026-10-06):** the run builder always adds `--set http.enabled=false`, so per-file runs never collide; the local HTTP endpoints are off.

**Decision (file setting paths, user 2026-10-06):** `resourceFiles` and `envFile` use the `binaryPath` path rules — `~` expands, a relative path resolves against the first workspace folder, and with no workspace folder the value is reported as unusable (`relativePathWithoutWorkspace`).

## Boundaries & Constraints

**Always:** The argv starts with `binaryState.ok.invocation` (`[path]` or `[rpkPath, 'connect']`), then the subcommand. Lint: `lint --deprecated --skip-env-var-check` (AD-17 warnings come from `--deprecated`; skip-env-var-check per the spec assumption), then the resource and env flags, then at least one target path. Run: `run --set http.enabled=false`, the resource and env flags, then exactly one target path. Resource files from the setting first, then caller-supplied detected resource files (AD-18; detection itself is epic 2), with duplicates removed, each as `--resources <abs>`; the env file as `--env-file <abs>`. Long flag forms only. All paths passed absolute (lint echoes paths as given). The environment is the inherited `process.env` plus `NO_COLOR=1`. Builder never throws for user settings: an unusable setting value is reported in the result, not spawned.

**Never:** `--verbose`, `-v`, a bare `-`, or `--chilled` (spike: rpk consumes `-v`/`--verbose`/`-`; run must refuse lint errors); a call with no target path; spawning processes (lint and Run in epic 2 spawn through the adapter's spawn site); checking whether resource or env files exist (lint and run report missing files themselves); new settings or commands.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LINT_PLAIN | standalone invocation, one file, no settings | `[bin, lint, --deprecated, --skip-env-var-check, /abs/a.yaml]`, env has `NO_COLOR=1` | — |
| LINT_RPK | invocation `[rpk, connect]` | `[rpk, connect, lint, --deprecated, …]` | — |
| LINT_MULTI | two target files | both paths, in the given order, after all flags | — |
| RUN_PLAIN | standalone, one file | `[bin, run, --set, http.enabled=false, /abs/a.yaml]` | — |
| RESOURCES | `resourceFiles` `[r1.yaml]` + detected `[r2.yaml, r1.yaml]` | `--resources /abs/r1.yaml --resources /abs/r2.yaml` (setting first, deduped) for lint and run | — |
| TILDE_PATHS | `envFile` `~/rc.env`, `resourceFiles` `[~/r.yaml]` | expanded to `$HOME/…` | — |
| ENV_FILE | `envFile` `.env` (workspace open) | `--env-file /abs/.env` for lint and run | — |
| NO_TARGET | lint with zero files / run with ≠ 1 file | not built; result says why | Never throws |
| NOT_OK | `binaryState` not `ok` | not built; result says the binary is unavailable | Never throws |
| BAD_SETTING_PATH | `envFile` or a `resourceFiles` entry relative with no workspace folder | not built; result names the setting and the reason | Never throws |

</frozen-after-approval>

## Code Map

- `src/adapters/redpandaConnect/binary.ts` (1.3) — `BinaryState` (`ok{path, version, invocation}`), `RedpandaConnect.state`, `resolveSettingPath(setting, homeDir, workspaceFolder)` (bare name → command, `~` expansion, relative → first workspace folder, `relativePathWithoutWorkspace`), `ResolveEnvironment` (home dir, workspace folder, PATH, config reader) — reuse `resolveSettingPath` and the environment shape for the two file settings.
- `src/adapters/redpandaConnect/version.ts` (1.2/1.3) — the only spawn site (`readVersion`); do not add spawning here in this ticket.
- `src/core/` — pure layer (AD-15 lint forbids `vscode`, adapters, `child_process`); put the argv builder here.
- `package.json` — `redpandaConnect.resourceFiles` (`string[]`, default `[]`) and `redpandaConnect.envFile` (`string`, default `""`) already contributed; descriptions say "passed to lint and run with `-r`/`-e`" — update wording to the long forms.
- Spike (findings Q1–Q3, captures `help-lint`, `help-run`): `--resources/-r` and `--env-file/-e` are repeatable on both lint and run; rpk consumes `-v`, `--verbose`, `-`; `lint -e` and `--skip-env-var-check` behave identically under rpk; lint with no paths exits 0 silently; run binds `0.0.0.0:4195` and a second concurrent run logs a bind error but keeps running.
- Tests: mocha/tdd under `@vscode/test-cli`; pure-function tests need no fake binaries.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/args.ts` -- pure `buildLintArgs` / `buildRunArgs` from invocation, targets, resource paths, env path -- one place for flags
- [x] `src/adapters/redpandaConnect/args.ts` -- read the two settings, resolve their paths with the `binaryPath` rules (`resolveSettingPath`), take `binaryState`, merge detected resource files, return `{ command, args, env }` or a typed reason -- adapter entry point epic 2 calls
- [x] `package.json` -- setting descriptions use `--resources` / `--env-file` -- docs match behavior
- [x] `src/test/` -- unit tests for every matrix row asserting exact argv and env -- verify

**Acceptance Criteria:**
- Given resource and env settings, when lint and run args are built for the same file, then both carry identical `--resources` and `--env-file` arguments.
- Given any built lint or run argv, then it contains none of `--verbose`, `-v`, `-`, `--chilled`.

## Implementation Notes

- `src/core/args.ts`: `buildLintArgs` / `buildRunArgs` return `{kind:'ok', argv}` or a typed `targetCount` / `noInvocation`; resource dedupe (first occurrence wins) lives here; `FORBIDDEN_ARGS` exported for tests.
- `src/adapters/redpandaConnect/args.ts`: `buildLintCommand` / `buildRunCommand(binaryState, {targets, detectedResourceFiles?}, env?)` return `{kind:'ok', command, args, env}` or `binaryUnavailable` / `targetCount` / `unusableSetting` / `relativePath`; `describeArgsFailure` gives the log line. `resolveFileSettingPath` reuses `resolveSettingPath` but treats a bare name (`.env`) as relative to the workspace, never a PATH lookup. Malformed setting values (non-array, non-string entries, blanks) are ignored. Non-absolute targets or detected resources are reported as `relativePath` (caller bug), not resolved against the process cwd.
- `binary.ts`: extracted `firstWorkspaceFolderPath()` so both builders pick the same workspace folder.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-06):** 6 findings — low 4 patched, low 1 rejected, false 1. No intent_gap or bad_plan. Parent also smoke-tested the long-flag argv against `redpanda-connect` 4.100.0 and `rpk connect` 4.112.0: lint exit 0; run with `--set http.enabled=false` binds no port.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Dedupe misses an absolute setting entry spelled differently from a detected one | low | patch | `resolveSettingPath` returns absolute values raw; detected ones are normalized. Normalize absolute setting entries too; add a test. |
| 2 | Empty invocation reported as `binaryUnavailable (ok)` | low | patch | Self-contradicting message; use a distinct reason; add a test. |
| 3 | `--resources` treats `*?[` as a glob | low | reject | Literal file names with glob characters are rare, and glob setting entries are a supported feature; documented in the setting description instead (#6). |
| 4 | TILDE_PATHS tested on lint only | low | patch | Add the run assertion. |
| 5 | `unusableSetting` reported before `targetCount` | false | reject | The plan sets no precedence; deterministic, documented choice. |
| 6 | Setting descriptions omit the no-workspace rejection and glob support | low | patch | Update both descriptions. |

Patches 1, 2, 4, 6 applied by the re-engaged implementer. Re-verification (parent): clean `out/`, `npm run compile` exit 0, `npm test` all passing, `vsce package` ok.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0
- `npm test` -- expected: all tests pass, including every matrix row
