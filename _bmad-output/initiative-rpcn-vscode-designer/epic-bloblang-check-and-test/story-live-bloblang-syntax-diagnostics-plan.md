---
title: 'Live Bloblang syntax diagnostics'
type: 'feature'
ticket: '5'
created: '2026-10-13'
status: done
baseline_revision: '696b000fd5ffdd7e3b70569bf8532fd97dc76892'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/spike-4-1-findings/findings.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bloblang syntax errors in `mapping` / `mutation` processors show only after a save, as lint findings with a config-relative position and an unreliable column (CAP-15, E4 R2).

**Approach:** A live parse service:
- On each edit of a detected config, after a debounce, it parses every changed `mapping` / `mutation` on the developer's binary by AD-21's route: `blobl -f <temp file>`, stdin closed, the env file passed.
- It publishes parse errors in their own diagnostics collection, at 4.3's mapped positions.
- On save, lint's duplicate of the same Bloblang error is hidden.

**Decisions (user, 2026-10-13):**
- While the YAML itself does not parse, the Bloblang diagnostics are cleared.
- The live error wins over lint's duplicate.
- An unset `${VAR}` (`failed to replace env vars: …`) is not a syntax error, so it gives no live diagnostic.

## Boundaries & Constraints

**Always:**
- **Parse route:** AD-21. Only `blobl -f`'s `failed to parse mapping: line L char C: <message>` (with its caret excerpt) is a parse error. Exit 0 means the mapping parses. Any other non-zero result gives no diagnostic and one output-channel line per distinct message.
  - The command comes from a builder in `src/adapters/redpandaConnect/args.ts` next to `buildRunCommand`, with the same `NO_COLOR` and `--env-file` handling.
  - The child runs through `runProcess` with a timeout (5 s).
  - The temp file goes under the global storage and is removed on every path.
- **Debounce and single flight:**
  - The debounce is 300 ms per document after the last change.
  - Only processors whose decoded Bloblang changed since their last parse are re-parsed; the result is cached by text.
  - Each processor path runs one parse at a time, with the latest text pending.
  - A result is dropped unless the processor's current text still equals the parsed text.
- **Diagnostics:**
  - collection `redpanda-connect-bloblang`, source `Bloblang`, severity Error;
  - the message is the binary's, without the `failed to parse mapping: line L char C:` prefix;
  - the range is the one character at `positions.offsetAt(line, char)`, or zero-width at a line end.
- **Clearing:** a processor's diagnostic clears when it parses, when the processor is removed, when its file closes or stops being detected, and for the whole file while the YAML does not parse. Non-detected and untitled files get none.
- **No binary:** no binary (`binaryState` not `ok`) gives no parse and no diagnostics; they appear once the binary is found.
- **Lint dedupe:** on save, a lint finding whose line lies inside a mapping that currently has a live Bloblang error is hidden (live error wins). Lint is re-filtered when the Bloblang diagnostics change. Every other lint behaviour (AD-12) is unchanged.
- **AI-8:**
  - AD-14: Bloblang diagnostics exist for `mapping` / `mutation` processors only, from the binary, live.
  - AD-12: the Bloblang parse isn't lint; it has its own collection, which lint's clear-on-first-edit doesn't touch, and it wins over lint's duplicate.
  - EXPERIENCE State Patterns get a row.
  - README (the Bloblang section) and CHANGELOG are updated.

**Never:**
- diagnostics for other Bloblang fields or `${! }` interpolations (spec Non-goals);
- `blobl server`; lint while typing;
- graph markers (4.6);
- changing 4.2's panel;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ERROR_SHOWN | type `root.a = this.b +` in a block mapping | after the debounce, one `Bloblang` Error at the mapped line and column, message from the binary | none |
| FIXED | complete the expression | the diagnostic clears | none |
| NESTED | error in a `switch` case's `mutation` and in `processor_resources` | each shown at its own position | none |
| BURST | 10 keystrokes inside 300 ms in one mapping | one `blobl` run for that mapping | none |
| UNCHANGED | edit outside every mapping | no `blobl` run | none |
| STALE | a result arrives after the text changed again | dropped; the newer text's result is shown | none |
| YAML_BROKEN | a YAML error elsewhere in the file | all Bloblang diagnostics of the file cleared; back once it parses | none |
| ENV_VAR | `${UNSET}` in a mapping | no diagnostic; one log line | none |
| NO_BINARY | binary missing | no diagnostics, no spawn; after Set path they appear | none |
| LINT_DEDUPE | save a file whose mapping has a live error and lint reports it | only the `Bloblang` diagnostic on that mapping; other lint findings stay | none |
| LINT_KEPT | lint finding inside a mapping with no live error | shown as today | none |
| CLOSE | file closed or undetected | its Bloblang diagnostics cleared | none |

</frozen-after-approval>

## Code Map

- `src/core/bloblangProcessors.ts:51` -- `bloblangProcessors(parsed, model?)`. Use it without a model; it has `path`, `source`, `positions`.
- `src/core/bloblangPositions.ts:18,35` -- `BloblangPositions.offsetAt(line, char)`, with code-point columns and clamping (4.3).
- `src/core/bloblangRun.ts` -- 4.2's pure run helpers. Add a pure `parseBloblParseOutput(exitCode, stderr)` here or in a sibling: it returns `{kind:'ok'} | {kind:'parseError', message, line, char, excerpt} | {kind:'other', message}`. Unit-test it with the spike's captured stderr (`spike-4-1-findings/captures/standalone-4.112.0/B/parse-error.parse-only.stderr`).
- `src/adapters/redpandaConnect/args.ts:61-66` -- `buildLintCommand` / `buildRunCommand`. Add `buildBloblCommand(state, mappingFile)` that reuses the env-file resolution and never passes a bare `-` or `-v`.
- `src/adapters/redpandaConnect/bloblang.ts` -- 4.2's `runMappingTest`. Add `parseMapping(state, source, storageDir)` beside it, with the same temp-file handling.
- `src/adapters/redpandaConnect/process.ts:97` -- `runProcess`. Don't change its stdio (`'ignore'` = closed stdin = parse only).
- `src/adapters/vscode/parseCache.ts:11` -- `parsedDocument(doc)`. Its errors decide YAML_BROKEN.
- `src/adapters/vscode/diagnostics.ts` -- `LintDiagnostics`: `refresh` (around l.190) dedupes through `suppressFlaggedLines` (`src/core/lint.ts:107`). Add an injected "lines covered by a live Bloblang error" source and re-run `refresh` when it changes. Lint's collection and clear-on-first-edit stay.
- `src/adapters/vscode/bloblangDiagnostics.ts` (new) -- the service: detection (`DetectionRegistry`), document events, debounce, cache, single flight and the collection.
- `src/extension.ts` -- wire it after `LintDiagnostics` (`:161`). Expose it on `ExtensionApi` as a test seam: its collection, plus a counter or event of parses run.
- `src/test/helpers/fakeBinary.ts:99` -- `connectScript`: add a `blobl` option. Its body sees the `-f` file as `$last`, and the counter file records `blobl`.
- Tests:
  - unit: the stderr parser and `buildBloblCommand`;
  - integration: `src/test/integration/suites/91-bloblang-diagnostics.ts`, registered after `90-…`, covering the matrix with a fake `blobl` that reports an error when the mapping contains a marker.
- Boundaries met (AI-7):
  - 2.4 lint on save (LINT_DEDUPE, LINT_KEPT, and the first edit after a save clears lint but not Bloblang);
  - 4.3's positions (exact line and column on a block, a quoted and an emoji line);
  - 4.2's panel (a test run still works while a parse is in flight).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/bloblangRun.ts` (or sibling) + tests -- `parseBloblParseOutput`.
- [x] `src/adapters/redpandaConnect/args.ts`, `bloblang.ts` + tests -- `buildBloblCommand`, `parseMapping`.
- [x] `src/adapters/vscode/bloblangDiagnostics.ts`, `src/extension.ts` -- the service per the matrix.
- [x] `src/adapters/vscode/diagnostics.ts` -- LINT_DEDUPE.
- [x] `src/test/helpers/fakeBinary.ts`, `src/test/integration/suites/91-bloblang-diagnostics.ts` -- the matrix and the boundary tests.
- [x] Docs -- AD-14, AD-12, EXPERIENCE State Patterns row, README, CHANGELOG.

**Acceptance Criteria:**
- Given the dev host with the real binary, when the user types a Bloblang syntax error in a mapping, then within about a second the binary's message is underlined at the right line and column, and it clears when fixed.
- Given the change, when `npm run compile`, `npm test` (stable is the target), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- `parseBloblParseOutput` lives in a sibling, `src/core/bloblangParse.ts`; `buildBloblArgs` in `src/core/args.ts` gives `blobl [--env-file <f>] --file <mapping>` (long forms, checked on 4.100.0's `blobl --help`; `blobl` has no `--resources`).
- The service also parses on detection (open) and after a binary or `redpandaConnect.envFile` change (cache cleared), not only on edits: otherwise NO_BINARY's "after Set path they appear" and an error already in an opened file would wait for an edit.
- The cache is global by text (1000 entries) and holds only deterministic outcomes (a parse, a parse error, an unset env var); a timeout or spawn failure is logged once and parsed again on the next trigger. The once-per-message log resets with the cache on a binary or env file change. A processor whose new text is being parsed keeps its last diagnostic until the result; at most 4 parses run at once over all files. The collection is always rebuilt from the document's current processors plus the cache, which is what drops stale results; nothing publishes while a document's debounce is pending.
- Lint dedupe is by message (see the Plan Change Log): a lint finding is hidden only when its line lies in a live error's span (the mapping key's line through the line after the value's last character, computed when the error is published; real lint puts a one-line mapping's error on that next line, spike 4.1 Q1, re-checked on 4.100.0: `(5,34)` for a one-line mapping on line 5) and its message starts with the live error's (lint appends `, got: …`).
- CLOSE is unit-tested with a fake close event: the extension host fires `onDidCloseTextDocument` long after the tab closes, so the integration suite covers the undetected path instead.
- The graph's markers read `LintDiagnostics.diagnosticsFor`, so a mapping's lint duplicate hidden by a live error no longer marks its node until 4.6 adds Bloblang markers.

## Plan Change Log

- 2026-10-13 (review): LINT_DEDUPE hides lint's duplicate by message, not by line range. "A lint finding whose line lies inside a mapping that has a live error" became: its line is in the live error's span (key line through the line after the value) AND its message starts with the live error's message. The processor-map line range (which reached the next key's line and `label:` lines, and could be stale) hid unrelated findings.

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 4 medium, 3 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Transient failures (timeout, spawn, thrown) are cached for good | medium | patch | Only `ok`, `parseError` and env-var failures are cached now; transient ones are parsed again. |
| 2 | The squiggle blinks off until the new parse returns | medium | patch | The last diagnostic is kept while the processor's new text is parsing. |
| 3 | The dedupe hides lint findings on the next key's line and on `label:` lines | medium | patch | Dedupe by message: a lint finding is hidden only inside the live error's span and when its message starts with the live message; LINT_KEPT for a different message on the next line. |
| 4 | Dedupe ranges can be from before the latest edit | medium | patch | Spans are computed when publishing (same fix as 3). |
| 5 | `logged` never reset after an envFile/binary change | low | patch | Cleared in `reset()`. |
| 6 | A → B pending → C cached still parses B | low | patch | Pending text dropped when the current text is cached. |
| 7 | ERROR_SHOWN's 2 s bound is loose | low | reject | The test runs against an instant fake; the user's dev-host check covers the real timing. |
| 8 | Acceptance criteria not verified | false | reject | Verification below. |

Follow-up from the full run: 4.2's BOUNDARY 2.7 read the last argv, which can now be a live `blobl` parse; it now selects the last `run` argv.

## Verification

**Results (2026-10-13):** `npm run compile` exit 0; full stable suite (VS Code 1.141.1, newly downloaded) 728 passing twice, baseline 696b000 697 twice on the same version; one earlier full run had two one-off failures (QUICK_FIX 2.5 "Canceled", HEADER 3.7) that did not recur in four full runs; floor not worked on (user decision); `npm run test:webview` 174; `npm run test:corpus` 129. Manual check (the user, dev host, real rpk): an error typed into the block mapping and the one-line mutation is underlined at the right place and clears when fixed, with no blink while typing; saving shows no duplicate from lint; a YAML syntax error clears the Bloblang errors and they return once it is fixed. No issues.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target; floor runs too), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- In the dev host, the user types an error into a mapping and sees it underlined at the right place, then fixed; and saves a file to see that lint does not repeat it.
