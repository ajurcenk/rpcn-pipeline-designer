---
title: 'Diagnostics parity in the corpus harness'
type: 'feature'
ticket: '6'
created: '2026-10-07'
status: done
baseline_revision: '990a6dce5c51112a01fa0656854ec6815079d778'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/test/corpus/SOURCES.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The corpus harness (1.7) checks that `lint` output matches its records, but nothing checks that the extension turns that output into the same diagnostics. A parser change that drops a line, takes the wrong line number or changes a message would pass CI (CAP-14, E2 R10).

**Approach:**
- For every corpus config and pinned version, the harness feeds the recorded stderr through the extension's own pure pipeline. Steps 1–3 move into `src/core/lint.ts` and are shared with the adapter, so the harness and the extension cannot diverge:
  1. `parseLintOutput`;
  2. keep the findings for the target and set aside the rest;
  3. map each finding's line to a document line, clamped (today's `toDiagnostic` rule);
  4. map the severity.
- It then asserts the result equals the recorded lines, one for one: line, message and severity.

**Decisions (defaults to confirm at this checkpoint):**
- **Recorded input:** parity runs on the recorded stderr, so it needs no binary and also runs locally when the binaries are missing. The existing live-versus-record comparison still ties the records to the real binaries.
- **Independent expected values:** the expected side is read from each record line with its own simple pattern, `<path>(<line>,<col>) <message>`. The expected severity is Warning for messages ending in ` is deprecated`, Error otherwise. The check is not the parser compared with itself.
- **Templates:** the three corpus templates are checked too, even though the extension never lints them (not detected). This tests the parser on the most findings the corpus has.
- **Resource references:** lint not checking them is expected, and there is no run-time check (decision 2026-10-06).
- **Self-test:** a small test of the parity checker shows that a dropped, mis-lined or re-worded finding is reported.

## Boundaries & Constraints

**Always:**
- **Shared core:** `findingsForTarget(stderr, target)` and `documentLine(line, lineCount)` live in `src/core/lint.ts`, and `src/adapters/redpandaConnect/lint.ts` and `src/adapters/vscode/diagnostics.ts` use them. Behaviour stays the same; the 2.4 tests pass unchanged.
- **Equality:** parity fails if any recorded line gives no finding, there are extra findings, any line is unparsed or set aside as another file's, a line maps to a different document line (it must equal `line - 1` within the file, so clamping never happens), or a message or severity differs.
- **Failure output:** a failure names the config, the version and the differing lines.
- **Type checks:** the harness stays type-checked and linted (`test/corpus/tsconfig.json`).

**Never:**
- running the binary for parity;
- editing corpus YAML or records;
- Red Hat dedupe or the Quick Fix in the harness (these need VS Code);
- new corpus files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CLEAN | record with exit 0 and no lines | no findings, parity passes | — |
| FINDING | `eval.yaml` record `(108,1) field location is required` | one Error on document line 107 with that message | — |
| TEMPLATE | `processor_log_and_drop.yaml` (10 lines) | 10 Errors on their lines | — |
| DROPPED | checker given findings missing one record line | reports that line as recorded, not produced | — |
| MISLINED | a finding on another line | reported | — |
| REWORDED | a message changed | reported | — |
| OUT_OF_FILE | a recorded line past the file's end | reported (clamping would hide it) | — |
| NO_BINARY | binaries missing locally | parity still runs; the live suites skip as today | — |

</frozen-after-approval>

## Code Map

- `test/corpus/corpus.test.ts`:
  - `configs`, `VERSIONS`, `recordOf`, `parse(text) → {header, lines}` (sorted lines, `<CORPUS>/` placeholder), `normalize`, `minus`;
  - per-version suites that skip without a binary;
  - records `test/corpus/<name>.lint/<ver>.txt`.
- `src/core/lint.ts`: `parseLintOutput(stderr, knownPaths)` and `LintFinding {path, line, message, severity, syntax}`.
- `src/adapters/redpandaConnect/lint.ts` `interpret`: the target filter by `path.resolve` equality, plus other-file and unparsed log lines (capped).
- `src/adapters/vscode/diagnostics.ts` `toDiagnostic`: `Math.min(Math.max(line - 1, 0), Math.max(lineCount - 1, 0))`.
- `vitest.config.mts`, `test/corpus/tsconfig.json`: the harness runs in plain Node, so it imports only `src/core` and `process.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/lint.ts`: `findingsForTarget`, `documentLine`; the two adapters use them. Shared pipeline.
- [x] `test/corpus/corpus.test.ts`: a `diagnostics parity` suite over every config × version record, and the checker self-test. The check itself.
- [x] `test/corpus/SOURCES.md`, `README.md` (Development), `CHANGELOG.md`: describe parity. Docs.

**Acceptance Criteria:**
- Given the current corpus and records, when `npm run test:corpus` runs, then the parity tests pass for all 15 configs × 2 versions, including with no binaries present.
- Given a parser change that drops or mis-maps a recorded line (tried by temporarily breaking `parseLintOutput`), when the harness runs, then it fails naming the config, the version and the line.

## Implementation Notes

- **Core.** `findingsForTarget(stderr, target)` returns `{findings, otherFiles, unparsed}`, and `documentLine(line, lineCount)` gives the clamped 0-based line. Both are in `src/core/lint.ts`, which now imports `path` (allowed by AD-15). The adapters use them, with no change in behaviour: the 2.4 tests pass unchanged and the reviewer compared the old and new code.
- **Harness.** The `diagnostics parity` suite has 30 cases (15 configs × 2 versions) plus a checker self-test. It compares rows of the form `L<line> <severity> <message>` one for one with `minus`. Unparsed lines and other-file findings are reported. `lineCountOf` matches VS Code's `lineCount` (CRLF, trailing newline).
- **Without binaries.** With `.cache/redpanda-connect` hidden, 35 tests pass and 2 suites skip, so parity runs without the binaries.
- **Mutation checks.**
  - The parser moving `mapping` lines by +1 failed 5 parity cases, naming the config, version and lines (parent).
  - A line +1 failed all 9 configs with findings; a sliced message also failed 9 (reviewer).
  - A target filter that kept everything was caught by the expected-side path check (see the triage log).

## Plan Change Log

- 2026-10-07 (review, clarification; the agent's call, reported to the user): the expected side follows the rules settled in 2.4 instead of looser ones.
  - Warning only for `field <name> is deprecated`; the plan said "ending in ` is deprecated`".
  - A `(1,1) yaml: line N: …` syntax error is expected on line N; the Equality rule's "`line - 1`" applies to the reported or remapped line.
  - Neither case occurs in the current corpus, and the self-test pins both.

## Review Triage Log

**Pass 1 (quick, 2026-10-07):** 5 low findings. 3 were patched and 2 intent_gaps were resolved as clarifications toward the settled 2.4 rules. None was rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The expected side ignored the record line's path, so a broken target filter was invisible in the corpus cases | low | patch | `expectedRow(line, config)` checks the `<CORPUS>/<config>(` prefix; a self-test with a keep-everything filter is now caught. |
| 2 | The expected side used line 1 for `yaml: line N` syntax errors (a false failure) | low | intent_gap → clarification | The expected side moves them to N; self-test. |
| 3 | The expected side warned for anything ending in ` is deprecated`; the parser only for `field <name> is deprecated` | low | intent_gap → clarification | Exact rule; self-test (`component foo is deprecated` is an Error). |
| 4 | The greedy expected regex split on the last `(n,m) ` (a false failure) | low | patch | Split after the known path prefix; self-test. |
| 5 | The REWORDED and MISLINED self-tests were weak | low | patch | Full arrays asserted. |

**Re-verification (parent):** `npm run test:corpus` 65 passed; `npm test` 373 passing (compile, type-check and lint run in `pretest`).

## Verification

**Commands:**
- `npm run test:corpus`: 34 + 30 parity + self-test passing.
- `npm test`: all pass (adapters unchanged in behaviour).
- `npm run compile`: exit 0 (harness type-check and lint).
