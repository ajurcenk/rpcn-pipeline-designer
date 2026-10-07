---
title: 'Lint on save shows diagnostics'
type: 'feature'
ticket: '4'
created: '2026-10-07'
status: 'built'
baseline_revision: '63e71f7002dc8327cb0461a727135ee88bc48161'
route: 'full'
route_source: 'auto'
review: 'full'
review_source: 'risk'
lenses_ran: ['adversarial', 'edge-case', 'verification-gap']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Red Hat YAML gives completion, hover and syntax errors, but the binary's schema barely validates components, so unknown fields, missing required fields and deprecated fields go unreported. Lint on save is the authoritative check (AD-12, amended 2026-10-06), and nothing runs it yet.

**Approach:**
- On save of a detected file, run `lint` through `buildLintCommand` and the one-shot spawn site (2.3), with the builder's env.
- Parse stderr in `src/core` and publish findings as whole-line diagnostics.
- Suppress a lint finding on a line Red Hat already flags, and clear the file's lint diagnostics on its first edit after save.
- Give epic 3 one deduped per-URI diagnostics accessor with a change event (AD-12, AD-17).

**Decisions (defaults to confirm at this checkpoint):**
- **File-level findings** (the ticket's open question). Lint reports YAML syntax errors at `(1,1)` as `yaml: line N: …`, and N is often where the enclosing block starts rather than the bad line (review). Renegotiated by the user on 2026-10-07: Red Hat owns syntax errors. Lint's `yaml: …` findings are hidden while Red Hat reports any `YAML`-source diagnostic for the file; otherwise they show on line N.
  - Other `(1,1)` findings stay on line 1 (missing env vars are already skipped by `--skip-env-var-check`).
- **What counts as Red Hat:** a diagnostic for the URI from another collection whose `source` is `YAML` or starts with `yaml-schema` (Red Hat 1.24.0 bundle). Any severity counts.
- **Concurrency:** one lint per URI at a time.
  - A save during a run queues one rerun.
  - A result is dropped if the file was edited, closed or undetected after that save.
  - Lint timeout: 30 s.
- **Failures:** a non-`ok` binary state means lint is skipped silently (1.4 already warned). Each of these logs one line to the "Redpanda Connect" channel and leaves no diagnostics:
  - a builder failure (for example a relative setting with no workspace);
  - a spawn failure or timeout;
  - an exit other than 0 or 1;
  - stderr lines that don't parse;
  - findings for another path.
- **Display:** diagnostic `source` is `Redpanda Connect`. Lint diagnostics are removed when the file stops being detected (this includes close).

## Boundaries & Constraints

**Always:**
- **When:** lint runs only on save of a document the DetectionRegistry reports as detected, and only for `file:` URIs. Its argv is exactly what `buildLintCommand` returns for `[fsPath]`, run via `runProcess([command], args, timeout, { env })`.
- **Parser (pure, in `src/core`):** reads lines `<path>(<line>,<col>) <message>`. It ignores the column (always 1, spike). Severity is Warning for `field <name> is deprecated` and Error for everything else.
- **Range:** a diagnostic covers its whole line (0 to the line's length), clamped to the last line.
- **Dedupe:** one function in `src/core` takes lint findings and the set of lines Red Hat flags. It is re-applied whenever Red Hat's diagnostics for that URI change, and our own publishes never trigger it again.
- **Clearing:** the first text change after a save clears the URI's lint findings, both the raw ones and the published ones.
- **Epic 3 accessor:** `diagnosticsFor(uri)` returns Red Hat's diagnostics plus the deduped lint diagnostics. `onDidChangeDiagnostics` fires with the URI whenever that set changes.

**Never:**
- lint while typing, lint via stdin, or lint of untitled files;
- a Red Hat schema change, or our own YAML validation;
- running Run, or Quick Fixes (2.5);
- Bloblang checks;
- showing a notification for lint failures (log lines only);
- re-serialising the document.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| UNKNOWN_FIELD | save a config with `nope:` under `generate` | Error on that line: `field nope not recognised` | — |
| DEPRECATED | save with a deprecated field (`codec`) | Warning on that line | — |
| CLEAN | lint exits 0 | no lint diagnostics; earlier ones gone | — |
| MULTI | two findings on two lines | two diagnostics, whole lines | — |
| YAML_SYNTAX | `(1,1) yaml: line 1: did not find expected key`, Red Hat flags line 4 | hidden while Red Hat reports a syntax error; shown on line 1 if it reports none | — |
| DEDUPE | Red Hat flags line 4; lint has lines 4 and 9 | only line 9 published; when Red Hat clears line 4, line 4 appears | — |
| LATE_REDHAT | Red Hat diagnostics arrive after lint | dedupe re-applied on `onDidChangeDiagnostics` | — |
| FIRST_EDIT | edit after save | lint diagnostics cleared; Red Hat's untouched | — |
| STALE_RESULT | edit during a running lint | result discarded | — |
| SAVE_BURST | three saves while linting | at most one queued rerun; final result matches the last save | — |
| NOT_DETECTED | save a non-Redpanda-Connect YAML | no lint process | — |
| NO_BINARY | binary state `missing` | no lint, no new log line or notification | — |
| BUILDER_FAIL | relative `resourceFiles` entry, no workspace | one log line with `describeArgsFailure`; no diagnostics | Never throws |
| CRASH | exit 2, timeout or spawn error | one log line; no diagnostics | Never throws |
| UNPARSED | stderr line without the `(line,col)` form | logged; parsed lines still published | — |
| UNDETECTED | file stops being detected or is closed | its lint diagnostics removed | — |
| ACCESSOR | Red Hat line 2, lint lines 2 and 5 | `diagnosticsFor` = Red Hat line 2 + lint line 5; one change event per change | — |

</frozen-after-approval>

## Code Map

- Spike captures `_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/captures/{standalone-4.100.0,standalone-4.112.0,rpk-4.112.0}/<scenario>.{stderr,exit}`: `lint-invalid-field`, `lint-nested-invalid-field`, `lint-missing-required`, `deprecated-flag`, `lint-yaml-syntax`, `lint-missing-file`, `env-plus-field-error`, `lint-clean`. Paths are relative in captures and absolute when we pass absolute paths. The parser is unit-tested on these captures.
- `src/adapters/redpandaConnect/args.ts`: `buildLintCommand(state, {targets}, env?)` returns an `ArgsResult` with a `CommandLine`, or a failure; `describeArgsFailure`.
- `src/adapters/redpandaConnect/process.ts`: `runProcess(invocation, args, timeoutMs, { env })` returns a `ProcessOutcome`.
- `src/adapters/redpandaConnect/binary.ts`: `RedpandaConnect.state`, which gives a `BinaryState`.
- `src/adapters/vscode/detection.ts`: `isDetected`, `onDidChangeDetection`.
- `src/extension.ts`: composition root and the `log` function. `ExtensionApi` is exposed for tests.
- New:
  - `src/core/lint.ts`: parser, severity, the `yaml: line N` remap, dedupe.
  - `src/adapters/redpandaConnect/lint.ts`: build, spawn and parse, returning findings or a failure line. It spawns nothing itself; `process.ts` does.
  - `src/adapters/vscode/diagnostics.ts`: save, edit and detection wiring, the `DiagnosticCollection`, Red Hat dedupe, and the accessor.
- Red Hat 1.24.0 (`dist/languageserver.js`): `YAML_SOURCE="YAML"`, and schema diagnostics carry `yaml-schema: <name>`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/lint.ts`: parser, severity, the syntax-line remap and `suppressFlaggedLines`. Pure.
- [x] `src/adapters/redpandaConnect/lint.ts`: `lintFile(state, fsPath)` returns findings, `skipped` or a failure message. Process boundary.
- [x] `src/adapters/vscode/diagnostics.ts`: save trigger, single-flight per URI, generations, clearing, dedupe on `onDidChangeDiagnostics`, `diagnosticsFor` / `onDidChangeDiagnostics`. Editor wiring.
- [x] `src/extension.ts`: wire it and expose it on `ExtensionApi`. Composition root.
- [x] `src/test/`: parser unit tests on the spike captures; diagnostics unit tests with fake sources for DEDUPE, LATE_REDHAT, STALE_RESULT, SAVE_BURST and ACCESSOR; integration tests (fake binary echoing lint lines for the saved path) for UNKNOWN_FIELD, DEPRECATED, FIRST_EDIT, NOT_DETECTED and BUILDER_FAIL. Matrix coverage.
- [x] `README.md`, `CHANGELOG.md`: lint on save. Docs.

**Acceptance Criteria:**
- Given a detected config with an unknown field, when it is saved, then an Error from Redpanda Connect lint covers that line. A deprecated field gives a Warning, and the first edit clears both.
- Given lint and Red Hat both flag line N, then only Red Hat's diagnostic shows on line N, and `diagnosticsFor` returns each line once.

## Implementation Notes

- **Three layers.**
  - `src/core/lint.ts` (`parseLintOutput(stderr, knownPaths)`, `suppressFlaggedLines(findings, lines, redHatHasSyntaxError)`) is pure.
  - `src/adapters/redpandaConnect/lint.ts` (`lintFile`) builds the command, spawns it and interprets the result. Log lines are capped at 20 plus a summary.
  - `src/adapters/vscode/diagnostics.ts` (`LintDiagnostics`) handles the editor side.
- **Per-URI state.** `generation`, `running`, `queued` and `raw`, plus a signature for the accessor event. States are never deleted, so a lint still running after undetect or close stays the only lint for that URI. Undetect, close (which covers session-marked files that stay detected) and edits all call `invalidate`. A `disposed` flag stops late results and queued reruns.
- **Red Hat lines.** These are the lines every Red Hat range touches; a range ending at column 0 does not touch its end line. A `YAML`-source diagnostic anywhere in the file hides lint's syntax findings.
- **Lint expands target paths as globs; `run` does not.** Checked with the 4.112.0 binary: `[x]/a.yaml` unescaped lints nothing and exits 0, while an escaped path fails in `run`. `buildLintArgs` therefore escapes `\ * ? [` in targets on non-win32 (`ArgvInput.platform`, which the adapter passes as `process.platform`). Lint echoes the unescaped path, so findings still match.
- **Column.** The column is not always 1: Bloblang errors report a real one, for example `(3,29)`. Findings still cover their whole line.
- **API.** `ExtensionApi.lintDiagnostics` is typed as `Pick<…, 'diagnosticsFor' | 'onDidChangeDiagnostics'>`.
- **Tests.** Fakes in the integration suite resolve `grep`, `cut` and `cat` before `PATH` is filtered (`/usr/bin` holds `rpk`). A mutation check confirmed that breaking Red Hat source detection fails 6 tests, including the real-Red-Hat syntax test.
- **Real binary.** Lint on `test/corpus/eval.yaml` parses to `line 108 field location is required`.

## Plan Change Log

- 2026-10-07 (review, human renegotiation): the YAML_SYNTAX decision and its matrix row are changed from "remap to line N and suppress only if Red Hat flags line N" to "Red Hat owns syntax errors", because go-yaml's line N is often the start of the enclosing block (adversarial #2, verified with the real binary).

## Review Triage Log

**Pass 1 (full: adversarial + edge-case, verification-gap; 2026-10-07):** 17 findings across two reviewers.
- **Patched:** high 1, medium 3 and low 11.
- **Decided by the human:** 1 intent_gap (A2).
- **Rejected:** low 1.
- No bad_plan.

The adversarial reviewer checked its claims against the real 4.112.0 binary.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| A1 | Lint expands the target as a glob: a file under `[client]/` is reported clean, and `g[1].yaml` lints `g1.yaml` | high | patch | Lint targets are escaped on POSIX in `buildLintArgs`; `run` is unchanged, since it does not glob (checked). Core, adapter and argv tests added. |
| A2 | `yaml: line N` names the wrong line, leaving a duplicate syntax error | medium | intent_gap → human | User chose "Red Hat owns them"; `syntax` flag and suppression; unit and real-Red-Hat integration tests. |
| A3 | A closed session-marked URI keeps `raw` and republishes it after reopen | medium | patch | `onDidCloseTextDocument` invalidates; test. |
| V1 / A7 | Undetect deleted the state, so a second concurrent lint could start | medium | patch | States are kept; test checks `calls === 1` across undetect and re-detect. |
| V2 | Dedupe was only tested against a fake Red Hat source | medium | patch | Integration test with the real Red Hat syntax diagnostic. |
| A4 | Dispose during a run touches the disposed collection; a queued rerun spawns | low | patch | `disposed` flag; test. |
| A5 | A path containing `(n,m) ` loses its findings | low | patch | `parseLintOutput(stderr, [fsPath])` splits at the known path; test. |
| A6 | The comment said the column is always 1 (Bloblang reports a real one) | low | patch | Comment and test. |
| A8 | Unbounded log lines | low | patch | Capped at 20 plus a summary; test. |
| V3 | The NOT_DETECTED integration test could pass without testing anything | low | patch | Asserts the file is undetected, plus a positive control (a detected save is linted). |
| V4 | BUILDER_FAIL did not check "exactly once" | low | patch | Counts the line. |
| V5 | Controller handling of a skipped lint untested | low | patch | Test: no log, no publish. |
| V6 | Whether a multi-line Red Hat range flags every line it covers | low | patch | Every line it covers is flagged (`linesOf`); "once" means once across sources. |
| V7 | The rejected-lint log used the full path | low | patch | Basename. |
| V8 | `ExtensionApi.lintDiagnostics` had no doc comment and exposed too much | low | patch | Comment added; narrowed to `Pick`. |
| A9 | The signature leaves out `code`, `tags` and `relatedInformation` | low | reject | Epic 3 node status uses severity and range only (AD-17). |

**Re-verification (parent):**
- `npm test`: 330 passing (compile, type-check and lint run in `pretest`).
- Mutation check: 6 tests fail when Red Hat detection is broken.
- `npm run test:corpus`: 34/34, with no record changes even though lint targets are now escaped (corpus paths have no glob characters).

## Verification

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass.
- `npm run test:corpus`: 34/34.

**Manual checks (if no CLI):**
- In the Extension Development Host with a real binary, save `test/corpus/eval.yaml`: an Error appears on line 108 (`field location is required`). Typing anything clears it.
