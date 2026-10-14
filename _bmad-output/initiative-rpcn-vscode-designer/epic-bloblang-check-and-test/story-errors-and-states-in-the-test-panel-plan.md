---
title: 'Errors and states in the test panel'
type: 'feature'
ticket: '8'
created: '2026-10-14'
status: 'built'
baseline_revision: 'b539477f77e0a5699727062558c6ecae7bfe87d6'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/initiative-rpcn-vscode-designer/brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html', '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/spike-4-1-findings/findings.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every failure in the test panel shows as a raw "The test could not run" block. A parse error shows the run's config-relative lint lines with no position. A mapping error has no line. A deleted message and invalid input have no state of their own (E4 R6).

**Approach:** The host classifies each run into the protocol's result kinds, with file positions from 4.3's map. The webview renders the prototype's card for each kind, keeps the last successful output dimmed, and offers Go to line. A failed mapping is also flagged at the end of its line in the editor.

**Decision (user, 2026-10-14):** the no-binary state and its recovery (R7) are split off into a follow-up entry right after this one (`deferred-work.md`).

## Boundaries & Constraints

**Always:**
- **Classification (host, AD-21):**
  - **Parse error:** a run that exits 1 with `Config lint error` is parsed with `blobl` (`parseMapping`, 4.5). If that gives a parse error, the result is `parseError`:
    - `message` is the binary's text without the `failed to parse mapping: line L char C:` prefix;
    - `excerpt` is the caret lines;
    - `mappingLine` and `mappingChar` are the binary's;
    - `fileLine` and `fileChar` come from `positions.offsetAt` turned into the document position, 1-based.
    - Any other lint message (for example an unset env var) is `error`, with that message verbatim.
  - **Mapping error:** an `{error}` line is `failed`. `mappingLine` comes from `failed assignment (line N)`, and `fileLine` from `positions.lineStart(N)`. Without that prefix, both are absent.
  - **Invalid input:** an `{error}` whose message contains `unable to reference message as structured` is `invalidInput`, with the binary's message.
  - **Deleted:** exit 0 with no line is `deleted`, as before. Anything else is `error`.
  - **No binary:** when the binary is not `ok`, nothing is spawned and the result stays `error` (4.2's message), shown as the `error` card.
- **Cards (webview; prototype wording, VS Code theme colours, `role="alert"` on error cards):**
  - **`parseError`:** pill `✕ Syntax error · not run`. The card titled "Mapping doesn't parse" has the subtitle `mapping line L, char C · <file> line F`, a `<pre>` with the message and excerpt, and the button "Go to line F". The footer reads "Fix the mapping to run it again."
  - **`failed`:** pill `✕ Mapping failed on this input`. The card titled "Failed on mapping line N" has the subtitle `<file> line F`, the message, and "Go to line F". Without a line, the title is "The mapping failed on this input" with no button. The footer reads "Showing the last successful output, dimmed."
  - **`invalidInput`:** pill `✕ Input not valid for this mapping`. The card titled "This input can't be read by the mapping" shows the binary's message and the hint "The mapping reads the message as JSON (`this`); check the input's Content." It has no button.
  - **`deleted`:** pill `⊘ Message deleted · <N> ms`, in the warning tone. The info card has the dashed border and reads "The mapping deleted this message". The footer reads "No output and no metadata." Nothing is dimmed.
  - **`error`:** pill `✕ Not run`. The card titled "The test could not run" shows the message verbatim.
  - **Dimmed output:** after `failed`, `invalidInput`, `parseError` or `error`, the last `ok` output (content and metadata) shows below the card, dimmed. It has no change marks and is labelled "Last successful output". It is absent if there was no earlier `ok` since the panel opened.
- **Go to line:** the webview posts `goToLine {line}`. The host shows the panel's YAML document in its editor group with the cursor at the start of that line, revealed in the centre, and the YAML editor takes focus. A line past the end clamps.
- **End-of-line hint:**
  - While the panel's latest result is `failed` with a `fileLine`, that line of the YAML editor ends with ` ✕ fails on this input`: an `after` decoration in error foreground colour, italic.
  - It clears on any other result, when the panel closes, and when the line stops being inside the processor.
  - One decoration type is shared by every panel.
- **Combined sequences (AI-7):**
  - a 4.5 live parse error and the panel's `parseError` for the same mapping show the same line and column;
  - a 4.7 Run on change edit that fixes a parse error replaces the card with the output.
- **AI-8:** EXPERIENCE State Patterns gets the panel's states (parse error, mapping error, invalid input, deleted, dimmed output, end-of-line hint). README and CHANGELOG are updated.

**Never:**
- Copy error, the prototype's per-error explanations ("The bracket opened on…"), and the deleted card's matched line;
- the no-binary state, its buttons and recovery (the follow-up entry);
- samples and their names in the hint (4.9: the hint then names the sample);
- protocol changes;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PARSE | block mapping with `root.c = = 3` on mapping line 2 | `parseError` with blobl's line/char, file line/char mapped, excerpt; card + Go to line | none |
| PARSE_MATCH | same mapping, live diagnostic (4.5) | panel's fileLine/fileChar = the diagnostic's start + 1 | none |
| ENV_LINT | unset `${VAR}` in the mapping | `error` with the binary's env-var message | none |
| FAILED | `root.x = this.nope + 1` | `failed`, mappingLine N, fileLine; card, Go to line, hint at that line, last ok dimmed | none |
| FAILED_NO_LINE | `{error}` without `failed assignment` | `failed` without lines; no button, no hint | none |
| INVALID | content `not json`, mapping `root = this` | `invalidInput` card | none |
| DELETED | `root = deleted()` | deleted card, warning pill, nothing dimmed | none |
| GO_TO_LINE | click Go to line 14 | YAML editor active, cursor at line 14 col 1 | line past end clamps |
| HINT_CLEAR | failed, then fix the mapping | hint gone after the next `ok` | also on panel close |
| NO_OK_YET | first result is `failed` | card only, no dimmed block | none |

</frozen-after-approval>

## Code Map

- `src/core/bloblangRun.ts:98-137` -- `parseRunOutput`.
  - Classify `{error}` lines here (pure): `failed` with `mappingLine` from `/^failed assignment \(line (\d+)\)/`, or `invalidInput`.
  - Report a `Config lint error` exit as a distinct internal outcome (for example `kind: 'lint', message`) so the adapter can decide whether it is a parse error.
  - The file lines can't be computed in core without the positions, so the adapter fills them (next item).
- `src/adapters/redpandaConnect/bloblang.ts:54` -- `runMappingTest`. On the lint outcome, call `parseMapping(state, source, storageDir)` (:116). A `parseError` outcome gives `parseError`; otherwise the result is `error` with the lint message. Keep `MappingTestOutcome`.
- `src/core/bloblangParse.ts:13,31` -- `BloblParseOutcome` already gives line, char, message and excerpt.
- `src/adapters/bloblangPanel/panels.ts`:
  - `runTest` (~:332) adds `fileLine` / `fileChar` from `processor.positions` (`offsetAt` / `lineStart`) and `doc.positionAt`, for the document the run used.
  - `receive` handles `goToLine`.
  - The hint decoration lives here, or in a small `src/adapters/bloblangPanel/hint.ts`. It is recomputed on result, on dispose and on document change.
- `webview/src/bloblang/OutputView.tsx:36-52`, `TestPanel.tsx:44` (status pill) -- the cards, the dimmed block (keep the last `ok` result in state) and the pills. The `binary` and `samples` messages stay ignored (the follow-up entry, 4.9).
- Fixtures `src/test/fixtures/bloblang/*.json` (4.4) -- the parseError, failed, invalidInput, deleted, error and `binary` missing fixtures. The webview tests render each new card from them (the `binary` missing fixture stays unrendered).
- Tests:
  - `src/test/core/bloblangRun.test.ts` (FAILED, FAILED_NO_LINE, INVALID, the lint outcome) using the spike captures' texts (`spike-4-1-findings/captures/standalone-4.112.0/C/map-error.stdout`, `bad-input.stdout`, `parse-error.stderr`);
  - `src/test/adapters/redpandaConnect/bloblang.test.ts` (PARSE, ENV_LINT with a fake `run`/`blobl`);
  - `webview/src/bloblang/TestPanel.test.tsx` (each card, pill, dimmed / NO_OK_YET);
  - `src/test/integration/suites/90-bloblang-panel.ts` with `fakeBinary.ts` (whose `run` body must emit an `exit 1` `Config lint error` for a marker, and whose `blobl` body already reports `ERR@L:C`): PARSE, PARSE_MATCH against suite 91's collection, FAILED with the hint (`editor` decorations aren't readable, so expose the hint's current ranges as a test seam), GO_TO_LINE.
- Boundaries met (AI-7): 4.3's positions, 4.5's live parse (PARSE_MATCH), 4.7's Run on change and layout.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/bloblangRun.ts`, `src/adapters/redpandaConnect/bloblang.ts` + tests -- classification (PARSE, ENV_LINT, FAILED, FAILED_NO_LINE, INVALID).
- [x] `src/adapters/bloblangPanel/panels.ts` (+ `hint.ts`) -- file positions, Go to line, the hint.
- [x] `webview/src/bloblang/*` + webview tests -- the cards, the pills, the dimmed output.
- [x] `src/test/helpers/fakeBinary.ts`, `src/test/integration/suites/90-bloblang-panel.ts` -- the integration rows.
- [x] Docs -- EXPERIENCE, README, CHANGELOG.

**Acceptance Criteria:**
- Given the dev host with the real binary, when the user tests a mapping that has a syntax error, then one that fails on the input, then one that deletes the message, then the panel shows each card with the right file line, Go to line moves the cursor there, and the failing line shows the hint.
- Given the change, when `npm run compile`, `npm test` (stable), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- Core: `parseRunOutput` returns `RunOutcome` = `BloblangResult | { kind: 'lint', message }` (exit 1 with `Config lint error`). `{error}` lines: `invalidInput` when the message contains `unable to reference message as structured`, else `failed` with `mappingLine` from `failed assignment (line N)` (N >= 1). Messages are kept verbatim (the binary's `failed assignment (line N): ` prefix included).
- Adapter: `runMappingTest` classifies a lint stop with `parseMapping` (same `argsEnvironment`, `cwd`, `run`), and fills file positions through a new optional `deps.locate(line, char)` (default: the mapping's own position). `MappingTestOutcome` is unchanged.
- Panels: `runTest` takes the processor plus the document text it was read from and passes `locate` = `positionIn(text, positions.offsetAt(L, C))` (a pure `positionAt` on that text, so an edit during the run does not shift the result). `goToLine` picks the visible editor's group, else the group with a tab of the file, else column One. The hint (`hint.ts`, one `TextEditorDecorationType` in `BloblangPanels`) follows the mapping line through edits (`positions.lineStart(N)`), and is dropped for good when N is past the mapping's lines or outside the processor; test seam `bloblangPanels.hintRanges(uri)`.
- Webview: the file name for `<file> line F` reaches the page as `data-file` on `#root` (an optional `data` argument of `webviewHtml`), not through a protocol message; without it the cards say `YAML line F`.
- Fake binary: `run` body markers `ERR@` (a Bloblang `Config lint error`, exit 1), `FAIL_ON_<N>` and `NOT_STRUCTURED`; suite 90 now also passes `bloblParseBody`. Markers live in block scalars (a plain scalar's ` #` is a YAML comment).
- Suite 90's env-var mapping now uses `${NOT_SET}` instead of `${UNSET}`: with the blobl body in place, its live parse would otherwise log the exact output-channel line suite 91's ENV_VAR counts (deduped until the next reset), and 91 failed.

## Plan Change Log

- 2026-10-14: `<file>` in the card subtitles comes from a `data-file` attribute of the page (no protocol change); flagged for review.

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 1 medium, 2 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The hint follows the mapping line number, not the failing line: an insert above, or deleting that line, moves it onto another statement | medium | patch | Reproduced from the code: `hintLine` holds only N. The failing line's text is now recorded, and the hint clears for good once line N's text differs. Tests cover an insert above and a deletion. |
| 2 | `lastOk` isn't in the saved view state, so a recreated webview (hidden, then shown again) loses the dimmed output | low | patch | It is now saved and restored with the view state, with a webview test. |
| 3 | `offset <= range[1]` against an exclusive range | low | patch | Changed to `<`. |

Decision taken at review (Plan Change Log entry): the `data-file` page attribute for the file name is accepted. It is not a protocol message, and its staleness after a rename is 4.10's to handle.

## Verification

**Results (2026-10-14, after the review patches):** `npm run compile` exit 0; full stable suite 754 passing; `npm run test:webview` 195; `npm run test:corpus` 129. Floor not worked on (user decision). Manual check (the user, dev host, real rpk): the mapping error card with file line, hint and Go to line; the dimmed last output; the syntax error card matching the editor underline; invalid input; deleted; the hint clearing after an edit above. No issues.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- In the dev host, the user drives each card (syntax error, failure, invalid input, deleted), uses Go to line, and sees the end-of-line hint.
