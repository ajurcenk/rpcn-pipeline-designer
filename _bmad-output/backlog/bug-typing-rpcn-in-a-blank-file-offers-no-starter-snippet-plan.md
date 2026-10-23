---
title: 'Typing rpcn- in a blank file offers no starter snippet'
type: 'bugfix'
ticket: '11'
created: '2026-10-23'
status: 'built'
baseline_revision: '20c83d90fa504ee976fd753b268ed7837287ffff'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `SnippetCompletionProvider` (`src/adapters/vscode/snippets.ts`) offers the whole-pipeline starter and the section snippets in an undetected YAML file only while it is completely empty. Once the user types the first letter of `rpcn-pipeline`, the file is neither blank nor detected, so nothing is offered, although the README says to type `rpcn-`. Only Ctrl+Space in an empty file works.

**Approach:** An undetected file also counts as blank when its only content is the word being typed at the cursor (letters, digits and `-`), and that word starts one of the top-level snippets' prefixes (`rpcn-…`, any case). Then the top-level snippets are offered as in an empty file, and each item replaces the typed word: VS Code's default YAML word stops at `-`, so without it, accepting after `rpcn-pi` would leave `rpcn-` in front. Any other content (a different word, more than one word, a Kubernetes manifest) still gets no snippets. Detected files and the empty-file Ctrl+Space path stay as they are.

</frozen-after-approval>

## Implementation Notes

Oneshot: one provider method (about 15 lines) and one integration test.

- `src/adapters/vscode/snippets.ts`: `typedWordAt` finds the `[\w-]` run ending at the cursor; the file counts as blank when that run is its only content and a prefix of a root snippet's prefix (lowercased). The slot still comes from `slotAt` (root for a word at column 0, none for an indented one), no top-level keys are excluded, and each item's `range` is the typed word. Detected files keep the old path: `typed` only counts when the file is not detected.
- `src/test/integration/suites/40-snippets.ts`: BLANK_TYPED (`rpcn` and `RPCN-pi` with the replaced range, `kind`, `a rpcn`, `  rpcn`, and a detected file's root line still leaving out its sections). `vscode.executeCompletionItemProvider` fills in a default range for items with none, so a detected file's missing range can't be asserted that way. The suite runs with `--grep` only together with suite 00 (`Extension tracer path`), which activates the extension.
- `CHANGELOG.md`: a "Fixed" line.

## Review Triage Log

Quick review. Verdicts: 0 high, 0 medium, 4 low, 0 false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | In a detected blank file (for example `new.rpcn.yaml`) or any detected config, accepting after `rpcn-` still leaves `rpcn-` (VS Code's YAML word stops at `-`) | low | defer + patch | Real and pre-existing; the intent keeps detected files as they are, so deferred. The CHANGELOG line claimed it for every blank file: narrowed to files not yet detected. |
| 2 | The forced `root` slot offered the starter for an indented `  rpcn`, which would insert it at indent 2 (broken YAML); the plan's "scalar document" reason was wrong (`slotAt` gives root at column 0) | low | patch | Confirmed. The slot comes from `slotAt` again; test case `  rpcn` gets none. |
| 3 | `typedWordAt` is pure text logic with no unit test | low | reject | Rare edge cases (cursor mid-word, CRLF); the integration test covers both acceptance criteria. Moving it to core is more than a correction. |
| 4 | The range is checked only for `RPCN-pi`; nothing guards detected files | low | patch | Added the range check for `rpcn` and a detected file's root line (its sections left out). |

## Verification

**Commands:**
- `npm run compile`; `npm run test:corpus` -- expected: all pass.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|Pipeline snippets"` -- expected: all pass (suite 00 activates the extension).
