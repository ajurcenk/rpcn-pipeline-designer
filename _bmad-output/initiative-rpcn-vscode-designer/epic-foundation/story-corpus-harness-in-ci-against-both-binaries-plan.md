---
title: 'Corpus harness in CI against both binaries'
type: 'feature'
ticket: '7'
created: '2026-10-06'
status: done
baseline_revision: '16815556809904a70429128c1ef9917936b14605'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md'
  - '{project-root}/test/corpus/SOURCES.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Graph accuracy (epic 3) and diagnostics parity (epic 2) are measured against the reference corpus, but nothing runs the corpus against the supported binaries; a change in Redpanda Connect's lint output, or in our argument builder, would go unnoticed.

**Approach:** A harness lints every `test/corpus/*.yaml` with standalone Redpanda Connect v4.100.0 and v4.112.0, using the same argv the extension builds (the 1.5 builder) and the adapter's spawn site, and asserts each result matches its recorded output; CI installs both binaries and runs it on every push.

**Decision (test runner, user 2026-10-06):** the harness runs under vitest 5.0.3 (architecture pin) in plain Node, as `npm run test:corpus` (compare) and `npm run test:corpus:record` (record), in its own CI step; the existing mocha/VS Code suite is unchanged.

## Boundaries & Constraints

**Always:** Binaries come from `scripts/spike/fetch-binaries.sh` (pinned, sha256-verified) into `.cache/redpanda-connect/<ver>/`; CI provides `GH_TOKEN` and caches `.cache/redpanda-connect` keyed on the pinned versions. The argv is `buildLintArgs` from `src/core/args.ts` (`lint --deprecated --skip-env-var-check …`, absolute paths); resource files for a config are passed only where `SOURCES.md` marks a dependency (e.g. `set_grab_cache.yaml` ← `resources.yaml`). Recorded output lives in `test/corpus/<name>.lint/<ver>.txt`: a header with the argv (corpus dir written as `<CORPUS>`), the exit code, then stderr lines with the corpus path replaced by `<CORPUS>/`; stderr lines are compared as a sorted set (lint runs files concurrently). The harness owns these files: a record mode rewrites them, the default mode only compares. In CI a missing binary fails the run; locally it skips with a message naming `fetch-binaries.sh`.

**Never:** Editor-diagnostics parity assertions (epic 2) or graph-accuracy assertions (epic 3); modifying corpus YAML files; network access from the harness itself; `rpk connect` (CI is standalone-only, spike decision).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MATCH | every corpus config, both versions, outputs unchanged | harness passes | — |
| DRIFT | one config's lint output differs from its record | harness fails naming the file, version and the differing lines | — |
| NEW_CONFIG | a `.yaml` without a record | harness fails asking for record mode | — |
| STALE_RECORD | a record without its `.yaml` | harness fails naming the orphan | — |
| RESOURCE_DEP | `set_grab_cache.yaml` | linted with `--resources <CORPUS>/resources.yaml` | — |
| TEMPLATE | `processor_log_and_drop.yaml` (template) | recorded non-zero exit and its errors match | — |
| REAL_ERROR | `eval.yaml` | `eval.yaml(108,1) field location is required` matched on both versions | — |
| NO_BINARY_LOCAL | binary missing, not CI | suite skipped with a message | — |
| NO_BINARY_CI | binary missing, `CI=true` | suite fails | — |
| RECORD | record mode | records rewritten; a second compare run passes | — |

</frozen-after-approval>

## Code Map

- `scripts/spike/fetch-binaries.sh` (1.1) — idempotent, sha256-verified download of 4.100.0 and 4.112.0 via `gh release download`; host OS/arch detection.
- `scripts/spike/run-matrix.sh` (1.1) — currently also writes `test/corpus/<name>.lint/<ver>.txt` with the spike argv (`lint --skip-env-var-check <name>.yaml`, relative, no `--deprecated`). The harness takes ownership: remove the corpus-writing loop from this script so there is one producer.
- `src/core/args.ts` (1.5) — pure `buildLintArgs(invocation, targets, resourcePaths, envPath)`; no `vscode` import.
- `src/adapters/redpandaConnect/version.ts` — the only `child_process` import, no `vscode` import; ticket 1.6 extends it with a helper that runs a subcommand and returns stdout/stderr/exit — reuse that helper (re-read the file at implementation time).
- `src/adapters/redpandaConnect/args.ts` (1.5) imports `vscode` (settings) — not usable from a plain-Node harness; call the core builder directly with explicit inputs.
- `test/corpus/SOURCES.md` — 15 files, kind (config / resource file / template), constructs, upstream blob SHAs; dependency note for `set_grab_cache.yaml` → `resources.yaml`.
- `.github/workflows/ci.yml` — Node 24, `npm ci`, `npm run compile`, `xvfb-run -a npm test`, `vsce package`, upload `.vsix`.
- Spike facts: lint stderr `<path>(<line>,1) <msg>`, exit 1 on findings; per-file order varies; outputs identical between 4.100.0 and 4.112.0 for the corpus.

## Tasks & Acceptance

**Execution:**
- [x] `test/corpus/corpus.test.ts` + `vitest.config.mts` (vitest 5.0.3 devDependency, excluded from the mocha `tsc` build) -- discover corpus, build argv with `buildLintArgs`, spawn via the adapter helper, normalize, compare or record -- the check
- [x] `test/corpus/<name>.lint/<ver>.txt` -- re-record all files in the new format -- expected outputs match the builder's argv
- [x] `scripts/spike/run-matrix.sh` -- drop the corpus-writing loop -- single producer
- [x] `package.json` -- scripts to run the harness and to record -- entry points
- [x] `.github/workflows/ci.yml` -- cache + `fetch-binaries.sh` with `GH_TOKEN`, run the harness with `CI=true` -- delivery
- [x] `test/corpus/SOURCES.md` -- describe the new record format and commands -- docs

**Acceptance Criteria:**
- Given CI on a push, when the harness runs, then both binaries are installed and every corpus config is linted with both versions.
- Given a corpus config whose lint output is changed on purpose, when the harness runs, then it fails and names that config and version.

## Implementation Notes

- Spawn helper: `version.ts` had no public "run a subcommand" helper, only the private `runProcess`; it is now exported (still the single spawn site) and the harness calls it with the `buildLintArgs` argv.
- vitest 5.0.3 declares an optional peer `@types/node ^22 || >=24`, conflicting with the pinned `@types/node 20.19.43` (VS Code 1.100 runtime); resolved with `overrides.vitest["@types/node"] = "$@types/node"` instead of bumping the types.
- Record mode is `vitest run --mode record` (config maps it to `CORPUS_RECORD=1`), so no cross-env dependency. Record mode also deletes orphaned records and requires both binaries.
- Resource dependencies are a `RESOURCE_DEPS` map in the harness mirroring `SOURCES.md`; versions are hardcoded and a test asserts they equal `VERSIONS` in `fetch-binaries.sh`.
- Reporter is `verbose` so the local skip message (in the skipped suite's title) is visible.
- `vitest.config.*` added to `.vscodeignore`.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-06):** 3 findings — medium 2, low 1, all patched. No intent_gap or bad_plan. The reviewer re-ran DRIFT, NO_BINARY_LOCAL and NO_BINARY_CI and confirmed them.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Record mode writes a crash exit (≥ 2) as the expected record | medium | patch | The removed `run-matrix.sh` loop died on exit > 1; the harness only rejects non-`exited`. Fail on any exit other than 0 or 1, in both modes. |
| 2 | Nothing type-checks or lints the harness | medium | patch | `tsconfig` `include: ["src"]`, `eslint src`; vitest strips types. Add a `test/corpus` tsconfig (ESM, `noEmit`) and run it and eslint on the harness in `npm run compile`. |
| 3 | Recorded version never checked against the binary | low | patch | The harness trusts the directory name; a stale cached binary would be recorded as `<ver>`. Run `--version` through `readVersion` and fail on mismatch. |

Patches 1–3 applied by the re-engaged implementer. Re-verification (parent): `npm ci` clean, `npm run compile` exit 0 (now type-checks and lints the harness), `npm run test:corpus` 34/34, deliberate record drift detected, mocha suite all passing, `vsce package` ok. CI on GitHub (GH_TOKEN release download, `npm ci` with the override) confirmed after push.

## Verification

**Commands:**
- `scripts/spike/fetch-binaries.sh` -- expected: both binaries cached
- `npm run test:corpus` -- expected: passes on both versions
- harness after editing one record by hand -- expected: fails naming that file and version
