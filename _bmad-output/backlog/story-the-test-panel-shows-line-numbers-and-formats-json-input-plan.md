---
title: 'The test panel shows line numbers and formats JSON input'
type: 'feature'
ticket: '40'
created: '2026-10-30'
status: done
baseline_revision: '4562cd1710d4425e8b18d0f3c9d31aa1a880986f'
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

**Problem:** The Bloblang test panel's input (a text box) and output (a text block) have no line numbers, and a JSON input pasted on one line is hard to read.

**Approach:** A line-number gutter beside the input and the output content (any text, JSON or not), and a **Format JSON** button for the input that re-indents valid JSON with 2 spaces as an edit (saved to the sample, re-run with Run on change); disabled, with the reason, when the input is not valid JSON.

**Decisions (user, 2026-10-30):** 2-space indent; disabled with a reason for invalid or empty input; line numbers always, input and output; formatting is an edit; `JSON.parse`/`JSON.stringify` as they are (a `1.0` becomes `1`, big integers may lose precision), said in the README; the generate panel gets the output gutter only.

## Boundaries & Constraints

**Always:**
- The gutter numbers are not part of the text: not in the input's value, not copied with the output, hidden from screen readers (`aria-hidden`), not selectable.
- The input gutter stays aligned with the text box's lines while typing, scrolling and resizing; the box does not wrap lines (`wrap="off"`, a horizontal scroll), so one gutter number is one line.
- The output keeps its lines, change marks and focusable `pre` as now.

**Never:**
- A new editor library; a host protocol change; a change to how the input is saved or run beyond Format JSON being an edit.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| IN_GUTTER | input `a\nb\n\nc` | gutter 1-4, one per line, empty lines counted | none |
| IN_SCROLL | an input taller than the box, scrolled | the gutter scrolls with it | none |
| IN_EDIT | lines added or removed while typing | the gutter follows at once | none |
| OUT_GUTTER | an ok output of N lines (pretty JSON or verbatim) | numbers 1-N beside the lines; change marks on the same lines | none |
| OUT_COPY | the output selected and copied | the text only, no numbers | none |
| FORMAT | input `{"a":1,"b":[1,2]}` | becomes the 2-space JSON; `inputEdited` posted (saved); with Run on change a `run` follows | none |
| FORMAT_SAME | input already formatted | nothing posted, nothing runs | none |
| NOT_JSON | input `not json`, or empty | button disabled, its title and accessible name say the input is not valid JSON | none |
| KEYBOARD | Tab to the button, Enter or Space | as a click; named for screen readers | none |
| GENERATE | a generate input's panel | output gutter only; no input, no button | none |
| UNCHANGED | samples, metadata, Run, error cards | as today | none |

</frozen-after-approval>

## Code Map

- `webview/src/bloblang/TestPanel.tsx` -- the input `textarea` (~:758, `value={content}`, `onChange={(e) => contentChanged(e.target.value)}`); `contentChanged` (~:577) is the edit path that saves the sample and schedules the run (use it for Format JSON so it behaves as typing); `lineCount` (~:257) and the input column's footer (~:782, `rpcn-bl-foot`) are where the button can sit. Wrap the textarea with a gutter element; sync its `scrollTop` from the textarea's `onScroll`.
- `webview/src/bloblang/OutputView.tsx` -- `OkContent` (~:45-58) renders each line as a span in a `pre`: add the number in a non-copyable span per line (e.g. a CSS counter or `::before` with `content: attr(data-line)`, so copy takes no number), keeping `rpcn-bl-mark`.
- `webview/src/bloblang/changes.ts` -- `shownContent` (~:32) decides the output's shown lines (pretty only for a lossless round trip); reuse its line splitting; the input's format does not use that lossless rule (user decision).
- `webview/src/bloblang/bloblang.css` -- `.rpcn-bl-input` (~:184), `.rpcn-bl-output` (~:204-222), `.rpcn-bl-foot` (~:283): the gutter styles (VS Code's `--vscode-editorLineNumber-foreground`), monospace line height shared by gutter and text.
- Tests: `webview/src/bloblang/TestPanel.test.tsx` (vitest + jsdom; helpers `render`, `send`, `posted`, `runs()`): every matrix row that jsdom can check (gutter counts and updates, the number spans not in `textContent` of the text, the button's disabled state and name, the posts on Format JSON, FORMAT_SAME, GENERATE). Scrolling and copy are checked as attributes (`aria-hidden`, `user-select`, the numbers outside the copied text nodes); the manual check covers them visually.
- Docs: `README.md` (the test panel section: the gutter, Format JSON and its number caveat), `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `TestPanel.tsx`, `bloblang.css` -- the input gutter and the Format JSON button.
- [x] `OutputView.tsx`, `bloblang.css` -- the output gutter.
- [x] `TestPanel.test.tsx` -- every matrix row jsdom can check.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when compile, webview, stable, multi-root and corpus runs execute, then all pass and the existing webview tests are unchanged (beyond the gutter's extra elements where a test reads the raw DOM).

## Implementation Notes

## Review Triage Log

Quick review. Verdicts: 0 high, 1 medium, 5 low, 0 false. Confirmed: the gutter's alignment rules, numbers never in the value or the copied output, hidden from screen readers, Format JSON through the typing path, the generate panel.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The README promises Ctrl+Z undoes Format JSON, but a value set through React's controlled `value` is not in the textarea's undo history | medium | patch | Real (Chromium). The format is inserted with `execCommand('insertText')` over the selected text, so it is undoable, with the old path as a fallback. |
| 2 | Format JSON shows and acts on the Metadata tab | low | patch | Shown only on the Content tab. |
| 3 | FORMAT_SAME compares raw strings (CRLF, a trailing newline); a lone `\r` leaves the gutter short | low | patch | Normalised comparison; lines split on `\r\n|\r|\n`. |
| 4 | A `disabled` button leaves the Tab order, so its reason is never reached by keyboard | low | patch | `aria-disabled`, focusable, with the same name and title. |
| 5 | The input is parsed and stringified twice per render | low | patch | Once per content. |
| 6 | TAB_WALK (an existing test) changed for the new button | low | noted | A new Tab stop; the only existing test changed. |

## Verification

**Commands:**
- `npm run compile` and `npm run test:webview` -- expected: pass.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass (the test panel suites load the real webview).
- `xvfb-run -a npx vscode-test --label multiroot`, `npm run test:corpus` -- expected: pass.

**Manual checks:**
- Dev host on 1.143.1: a one-line JSON input, Format JSON, the gutter while scrolling a long input and a long line; copy the output; a non-JSON input (button disabled); keyboard only; a generate input's panel; light and dark themes.

Result (2026-10-30, after the review patches): webview 331 passed (every matrix row jsdom can check); stable 1085 passing; multiroot 10 passing; corpus 156 passed. The undoable `execCommand` path runs only in a real webview (happy-dom takes the fallback): covered by the manual check. Manual check: done by the user on the 1.143.1 dev host, `.vscode-test/manual-panel` (2026-10-30): line numbers, Format JSON, Ctrl+Z undo, already formatted, scrolling and a long line, not JSON, copy, the Metadata tab, light and dark themes; no issues.
