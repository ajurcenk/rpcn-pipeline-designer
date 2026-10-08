---
title: 'Bloblang function and method completion and hover'
type: 'feature'
ticket: '19'
created: '2026-10-08'
status: done
baseline_revision: '23b9119e4fcf4acab6450b69048cb2e40ea916cc'
route: 'full'
route_source: 'auto'
review: 'full'
review_source: 'risk'
lenses_ran: ['adversarial', 'edge-case', 'verification-gap']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Inside Bloblang there is no help for the language's functions and methods. The user pointed at the docs' function list (2026-10-08).

**Approach (user: "Yes" to amending AD-14):**
- **Catalog:** the binary's `json-full` docs (`bloblang-functions`, `bloblang-methods`; the same 41 functions as the docs page, of which 2 are hidden) are carried in the served schema under `x-rpcn-bloblang`.
- **Completion inside Bloblang** (the 2.9 fields and `${! }`):
  - functions at expression positions; methods after a `.` (also a trigger character);
  - each with its description, parameters, an example and a snippet;
  - deprecated entries tagged and sorted last; hidden ones left out.
- **Hover:** on a function or method name followed by `(`, the same docs.
- **Not included:** Bloblang diagnostics and a language server.

## Boundaries & Constraints

**Always:**
- **Where:** only inside detected files and inside Bloblang regions. Never inside a Bloblang string, a comment, a `@metadata` or `$variable` name, or after a decimal point.
- **Snippets:**
  - placeholders for required parameters only;
  - `name($0)` for optional or variadic parameters;
  - just the name when `(` already follows;
  - the whole word under the cursor is replaced.

**Never:**
- type-aware method filtering, which would need a Bloblang parser;
- web requests for the docs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FUNCTIONS | `root.id = ` in a mapping block | `uuid_v4`, `now`, `random_int`, … | — |
| METHODS | `this.name.` (or the `.` trigger) | `uppercase`, `replace_all`, … | — |
| INTERPOLATION | `path: "${! no }"`, `"id ${! this.id. }"` | functions / methods | — |
| OUTSIDE | `message: root = `, strings, comments, `@x`, `$x`, `1.` | nothing | — |
| HOVER | `now()`, `.uppercase()` | docs with parameters and an example | — |
| DEPRECATED / HIDDEN | `meta` / `nothing`, `var` | tagged and last / absent | — |

</frozen-after-approval>

## Implementation Notes

- **Core** (`src/core/bloblang.ts`): the catalog builder (AsciiDoc cross-references become plain text; variadic is flagged), `regions`, the `codeOf` scanner, `bloblangContext`, `bloblangItems`, `bloblangSnippet`, `bloblangMarkdown` and `bloblangHoverAt`.
  - **Regions:** Bloblang field values (a block region starts after its header line; a quoted one inside its quotes, with YAML `\\"` read as `"`), plus `${! }` by brace depth, never past its line.
  - **The scanner** runs from the region start, so triple-quoted strings can span lines.
  - **`BLOBLANG_FIELDS`** equals the injection grammar's key list (guarded by a test).
- **Provider** (`src/adapters/vscode/bloblang.ts`): completion with `.` as a trigger and an `{inserting, replacing}` range, plus hover.
- **Transform:** version 5; the catalog is about 106 KB in a 2.18 MB served schema, and is added only when the docs contain entries.
- **Recorded limits:**
  - methods are offered on an assignment target (`root.`); this is valid Bloblang in some positions, so it is left as is;
  - the whole document is parsed per request (about 13 ms on a 1,253-line config).

## Review Triage Log

**Pass 1 (combined adversarial, edge-case and verification-gap reviewer, 2026-10-08):** 12 findings.
- **Patched:** 1 high, 2 medium, 6 low.
- **Recorded:** 2 limits.
- **Rejected:** 1.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Double-quoted interpolations and values got nothing (the YAML `"` was read as a Bloblang string) | high | patch | The scan starts at the region start; YAML `\\"` escapes are read as `"`; tests. |
| 2 | An unterminated `${!` swallowed the document | medium | patch | Brace depth, stopping at the end of the line; test. |
| 12 | Verification gaps: deprecated tag, the `.` trigger, the range, double quotes, unterminated | medium | patch | Integration and core tests. |
| 3 | Nested braces ended the interpolation early | low | patch | Brace depth; test. |
| 4 | Multi-line triple-quoted strings were treated as code | low | patch | Region-start scan; test. |
| 5 | Methods offered after a decimal point (and on the left of `=`) | low | patch (decimal) / recorded (left of `=`) | Decimals suppressed; the left of `=` is noted as a limit. |
| 6 | Accepting before an existing `(` gave `()()`; the word end was not replaced | low | patch | `parenFollows`; replacing range; test. |
| 7 | Variadic methods had no placeholder | low | patch | `variadic` gives `name($0)`; test. |
| 8 | AsciiDoc cross-references showed raw in hover | low | patch | `plainText`; a test checks that none is left. |
| 9 | A full parse per request | low | recorded | Acceptable at about 13 ms. |
| 10 | The catalog adds about 5% to the schema | — | none | Fine. |
| 11 | Our hover shows next to Red Hat's | low | reject | Expected merge. |

**Re-verification (parent):** `npm test` 489 passing; `npm run test:corpus` 65 passed.
