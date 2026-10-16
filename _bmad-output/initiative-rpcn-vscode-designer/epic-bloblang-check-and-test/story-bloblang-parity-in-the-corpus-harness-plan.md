---
title: 'Bloblang parity in the corpus harness'
type: 'feature'
ticket: '12'
created: '2026-10-16'
status: done
baseline_revision: '943aebbc410460bc308c792426260aad5c9fc9f3'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 1
context: ['{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/spike-4-1-findings/findings.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing checks the epic's success signal (Done when 2, R11, spec second-release signal): that for every corpus mapping the test panel's result equals the binary's own run of the AD-21 one-message pipeline, and that every parse error the editor underlines is one `blobl` reports, on v4.100.0 and v4.112.0.

**Approach:**
- **Samples:** every corpus `mapping`/`mutation` processor gets samples in a samples file beside its config (AD-22 format).
- **Records:** the harness records, per pinned version, the raw output of an independent reference copy of the AD-21 pipeline and of `blobl`.
- **Live check:** in compare mode it runs the extension's own run and parse code against the live binary and checks the result against what the records say.

**Decision (user, 2026-10-16, after review iteration 0):** the extension's processor finder misses `mapping`/`mutation` items directly in `try:`, `catch:` and `for_each:` lists (a pre-existing bug from 4.3; 5 of the 14 corpus processors). 4.12 fixes it: those lists count as processor lists, so the live parse, the lens and the panel cover them. All corpus processors get samples and records.

## Boundaries & Constraints

**Always:**
- **Samples:**
  - **Where:** `test/corpus/<config>.samples.json` in AD-22's format, linked by label, else by path. Each processor that `bloblangProcessors` finds in a corpus config has at least one sample.
  - **Meta:** a sample carries the metadata its mapping reads (`@…`).
  - **Inputs:** samples are chosen so the corpus covers, overall, an output, a `deleted()` from any corpus mapping on a suitable sample (the `batch_index()` one can't delete in a one-message run), and a mapping error on a bad input.
  - A layout test fails when a processor has no sample.
- **Broken variants (parse parity):** each processor also gets one generated syntax-broken variant: its source with ` +` appended on a new last line. This gives every mapping a parse error to compare, since the corpus mappings all parse.
- **Records:**
  - **Where:** `test/corpus/<config>.bloblang/<version>.json`, one entry per processor path and sample (and per broken variant).
  - **Run entries:** the raw exit code and stdout of the reference pipeline, plus stderr only when it says `Config lint error`.
  - **Parse entries:** the raw exit code and stderr of `blobl -f`, with stdin closed.
  - **Reference pipeline:** written in the harness from AD-21's text (the spike's route C), not by importing `testConfig`, so the comparison is independent of the extension's config builder.
  - **Recording:** written in record mode (`npm run test:corpus:record`) like the lint and graph records. Orphans are deleted. A missing record fails the layout test.
- **Checks (compare mode, live binary per version, as the lint records are checked today):**
  - **Run parity:** the extension's run path (`runMappingTest` classification, unchanged behaviour) on each sample gives a result that matches the record: ok content and meta equal the record's JSON line, deleted equals no line with exit 0, a mapping error's message equals the record's `{error}`.
  - **Parse parity:** for each original and broken variant, the extension's parse path (`parseMapping`, then 4.3's positions) gives either no diagnostic, when `blobl` exits 0, or one diagnostic. That diagnostic's message is `blobl`'s message without its prefix, and its file line and column are `blobl`'s mapping line and char mapped through the processor's position map.
  - **Strictness:** both checks fail on any difference.
    - When the reference run stops with a non-zero exit, the extension's message must equal the expected one: `blobl`'s parse message for a `Config lint error` that `blobl` reports as a parse error, else the recorded stderr's message.
    - When `blobl` fails with a non-parse error, the extension's error message must equal it.
    - A test proves strictness through the full comparison: a real loaded record, altered in memory (one value per kind: content, deleted, error text, parse message, parse char), is reported as a mismatch by the same function the compare mode uses.
- **Processor lists (the fix):**
  - `src/core/bloblangProcessors.ts` treats `try`, `catch` and `for_each` like `processors`, at any depth.
  - Unit tests cover each, nested and not.
  - The integration suites for the live parse and the panel (91, 90) gain one `try`/`catch` case each.
- **Runnable without VS Code:**
  - The run and parse orchestration in `src/adapters/redpandaConnect/bloblang.ts` (`runMappingTest`, `parseMapping`, `classify`) is moved into a module with no `vscode` import, so the corpus vitest calls the real code.
  - `bloblang.ts` keeps its exports and behaviour by delegating.
  - No `vscode` stub or alias is added to vitest.
  - Argument-failure messages are not duplicated: the runner reuses `describeArgsFailure` and the target checks from one place.
- **CI:** the existing "Corpus harness" step runs it with both binaries; a missing binary fails in CI as today.
- **Ticket and docs (AI-8):**
  - the 4.12 entry's wording is aligned with R11 and AD-21 (done at planning);
  - `test/corpus/SOURCES.md` or the harness header documents the samples and records;
  - CHANGELOG is updated.

**Never:**
- changing the panel's or the live parse's behaviour or messages, other than the processor-list fix;
- comparing the run against `blobl`;
- the deprecated `bloblang:` processor;
- recording timings;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PARITY_OK | every corpus processor, its samples, both versions | extension result = record | none |
| DELETED | the `deleted()` mapping on its sample | `deleted` = no line, exit 0 | none |
| MAPPING_ERROR | a sample that fails the mapping | `failed` with the record's error text | none |
| PARSE_OK | original sources | no diagnostic, `blobl` exit 0 | none |
| PARSE_BROKEN | broken variants | one diagnostic: `blobl`'s message and its mapped file position | none |
| NESTED | processors in branch, workflow, try, catch, `processor_resources` (the corpus has no mapping under `switch`) | covered like the rest | none |
| TRY_CATCH_FIX | a `mapping` directly in `try:`, `catch:`, `for_each:` | found by `bloblangProcessors`; live diagnostics and the lens appear | none |
| MISSING_SAMPLE | a processor with no sample | layout test fails | none |
| WRONG_RECORD | a real record altered in memory, per kind | the full comparison reports each mismatch | none |
| STOP_MESSAGE | a reference stop or a `blobl` non-parse failure | the extension's message must equal it | none |
| NO_BINARY_LOCAL | binary missing locally | that version skipped (fails in CI and record mode) | none |

</frozen-after-approval>

## Code Map

- Rework (review iteration 0): the first attempt's diff, records included, is at `/tmp/claude-1000/-home-aleksejjurcenko-projects-clients-personal-rpcn-vscode-byoc-plugin/268853b3-1dfc-4afe-b271-cc6ebd368b10/scratchpad/diff-4-12-iter0-full.patch`. Reuse it: the runner extraction (`bloblangRunner.ts`, the `args.ts` exports), the reference pipeline, the samples files, the harness block and layout tests, docs, `.gitattributes`. Then apply the decision and the stricter checks above, add samples for the 5 newly found processors, and re-record.
- `src/core/bloblangProcessors.ts:21` -- `PROCESSOR_LISTS` (`processors`, `processor_resources`): add `try`, `catch`, `for_each`.

- `test/corpus/corpus.test.ts`:
  - fits the existing structure (header 1-44, `VERSIONS` 68, `CACHE` 80/88, `RECORD`/`IN_CI` 83-84, skip/fail 630-645, version check 648-655, record/compare loop 657-675, layout tests 570-628);
  - "Bloblang positions and ids (4.3)" (495-523, `withBloblang` list) is where the processor set comes from;
  - add a "Bloblang parity (4.12)" block;
  - the reference pipeline goes in the test (or `test/corpus/bloblangReference.ts`).
- `vitest.config.mts` -- node env, `testTimeout` 60 s. Keep the per-test work within it (about 16 processors, 2 versions, roughly 0.2 s per launch).
- New vscode-free module, for example `src/adapters/redpandaConnect/bloblangRunner.ts`:
  - **What moves:** `runMappingTest`, `parseMapping` and `classify` from `bloblang.ts` (69, 124, 170), taking `invocation`, `envFile` and the `run` function as plain inputs.
  - **Dependencies:** it uses `src/core/args.ts` (`buildRunArgs` 56, `buildBloblArgs` 77), `src/core/bloblangRun.ts` (`testConfig`, `parseRunOutput` 126), `src/core/bloblangParse.ts` (`parseBloblParseOutput` 31), and `runProcess` from `src/adapters/redpandaConnect/process.ts`.
  - **What stays:** the timeouts (`bloblang.ts:24,26`) move along. `bloblang.ts` keeps the vscode-bound parts: `BinaryState` and the env file setting.
- `src/core/bloblangProcessors.ts:51`, `src/core/bloblangPositions.ts:35` -- the processors and their position maps.
- Files under `test/corpus/`:
  - `*.samples.json` (new, for `eval`, `track_benthos_downloads`, `stateful_polling`, `cdc_replication` and any others found);
  - `*.bloblang/<ver>.json` (recorded).
- `.github/workflows/ci.yml:31-46` -- no change expected.
- Integration suite 90 must stay green, since the refactor of `bloblang.ts` is covered there.

## Tasks & Acceptance

**Execution:**
- [x] Extract the vscode-free runner; `bloblang.ts` delegates; integration suite stays green.
- [x] Corpus samples files.
- [x] Harness block: reference pipeline, record mode, compare checks, layout test, wrong-record test.
- [x] Record on both versions; docs and CHANGELOG.

**Acceptance Criteria:**
- Given both pinned binaries in `.cache`, when `npm run test:corpus` runs, then every parity check passes on v4.100.0 and v4.112.0, and the wrong-record test shows a mismatch is caught.
- Given the change, when `npm run compile`, the stable suite under `xvfb-run -a`, `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- Iteration 1: the iteration-0 patch was reapplied, then: `PROCESSOR_LISTS` gains `try`, `catch`, `for_each` (unit test, plus a `TRY_CATCH_FIX` case in suites 90 and 91); `ArgsFailure`, `describeArgsFailure` and the target check (`relativeTarget`) moved to the vscode-free `src/adapters/redpandaConnect/argsFailure.ts`, re-exported by `args.ts` and used by `bloblangRunner.ts` (no duplicated messages); samples for the 5 newly found processors (`stateful_polling` catch, `track_benthos_downloads` try[1] x3 and try[4]); stricter stop / non-parse-failure checks in `runProblems` / `parseProblems`; per version, five `WRONG_RECORD` tests alter a real record (content, deleted, error text, parse message, parse char) and require exactly one problem at that entry from `bloblangParityProblems`. Re-recorded on both versions (runs identical across 4.100.0 and 4.112.0).

## Plan Change Log

- Iteration 0 → 1 (intent_gap, user decision 2026-10-16). Added the processor-list fix (`try`, `catch`, `for_each`), stricter stop and failure-message checks, and the full-path wrong-record test. The deleted() source was reworded; the NESTED row corrected (no mapping under `switch`). Known-bad states avoided: 5 of 14 corpus processors unchecked and invisible to the editor; parity passing on wrong stop messages. KEEP: the runner extraction, the reference pipeline, the record format, the layout tests and the samples written so far.

## Review Triage Log

Iteration 0 (quick). Verdicts: 1 high, 3 medium, 6 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `bloblangProcessors` misses `mapping`/`mutation` items directly in `try`/`catch`/`for_each`: 5 of 14 corpus processors unchecked, and no live diagnostics or lens for them in the extension | high | intent_gap | Reproduced with the real function. Pre-existing (4.3), but it blocks the NESTED row and the deleted() source. The user chose to fix it in 4.12. |
| 2 | The intent's deleted() source (`batch_index() != 0`) can never delete in a one-message run | medium | intent_gap | `batch_index()` is always 0 there. The row was reworded per the user's decision. |
| 3 | Run parity accepts any stop when the reference exits non-zero, and the message is never compared | medium | intent_gap → frozen rule | Added to the strictness rules. |
| 4 | Parse parity skips the message on a `blobl` non-parse failure | medium | intent_gap → frozen rule | Added to the strictness rules. |
| 5 | The wrong-record self-test uses synthetic entries, not the full comparison | low | intent_gap → frozen rule | It now uses the full path on a real record. |
| 6 | Parse file positions are computed by the same harness function on both sides, so they can't fail on their own | low | reject | The mapping line and char are compared raw, and 4.3's round-trip test covers the position map. The extension's clamp is `Math.min` over the same map. |
| 7 | The runner duplicates `describeArgsFailure`'s messages and the target check | low | intent_gap → frozen rule | No duplication now. |
| 8 | CHANGELOG says every corpus processor has samples | low | moot | True after the fix. |
| 9 | Later YAML documents are handled inconsistently by `bloblangCases` and `withBloblang` | low | reject | No multi-document Bloblang config in the corpus; rare. |
| 10 | `<TMP>` masking only covers the reference's paths | low | reject | Not hit; no recorded message contains a path. |

## Verification

**Results (2026-10-16, after the iteration 1 patches):** `npm run compile` exit 0; `npm run test:corpus` 156 on both versions (re-recorded); full stable suite under `xvfb-run -a` 832 passing; `npm run test:webview` 283. Floor not targeted (user decision). Manual check of the try/catch fix (the user, dev host, real rpk): lenses on mappings in try, catch and for_each, a live syntax error underlined and cleared, and a test run giving the expected output: no issues.

**Commands:**
- `npm run test:corpus:record`, then `npm run test:corpus` -- expected: records written; then all pass on both versions.
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable`; `npm run test:webview` -- expected: all pass.

Iteration 1 (quick). Verdicts: 0 high, 3 medium, 2 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The STOP_MESSAGE check can't pass for a non-parse lint stop on a real binary: the recorded stderr has a wall-clock `time=` and the reference config's path and position | medium | patch | Reproduced on 4.112.0 with an unset `${VAR}`. Now only the lint finding's message is recorded and compared (no timestamp), and one live case with an unset `${VAR}` runs against both binaries. |
| 2 | The harness keeps only `blobl`'s first stderr line and needs `: `; the extension keeps continuation lines up to the caret | low | patch | Now read the same documented way, written independently. |
| 3 | A throw while reading the settings now gives the bare error, not "Could not parse the mapping: <err>" | medium | patch | It broke the frozen rule (live parse messages unchanged). Prefix restored, with unit tests on both paths. |
| 4 | `buildBloblCommand` is dead in production, and the runner reimplements the command line (target check, settings, argv, `NO_COLOR`) | medium | patch | AD-9's single builder could drift. Now one vscode-free implementation, used by `args.ts` and the runner. |
| 5 | Two doc comments in `bloblangReference.ts` lost the escape they name | low | patch | Fixed. |
