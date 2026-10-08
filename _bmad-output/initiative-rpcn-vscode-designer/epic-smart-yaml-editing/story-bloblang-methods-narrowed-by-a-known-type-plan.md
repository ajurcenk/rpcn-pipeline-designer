---
title: 'Bloblang methods narrowed by a known type'
type: 'feature'
ticket: '21'
created: '2026-10-08'
status: done
baseline_revision: '161f32492aca1699ea3687a15ca765de223bb568'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-bloblang-completion-of-names-already-written-plan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** After `"test".` all 193 methods are offered. The user asked for the string methods only (2026-10-08).

**Approach:** the binary's docs give each method one or more categories, and those categories map to types:
- **string:** String Manipulation, Regular Expressions, Parsing, Encoding and Encryption, JSON Web Tokens, Timestamp Manipulation, GeoIP;
- **number:** Number Manipulation, Timestamp Manipulation;
- **array:** Object & Array Manipulation, Parsing, SQL;
- **object:** Object & Array Manipulation, Parsing;
- **boolean:** only the categories that apply to every type;
- **every type:** General and Type Coercion.

The type is known in two cases:
- **A literal before the dot:** `"…"`, `[…]`, `{…}` (not a block after `if` / `else` / `match`), `true` / `false`.
- **A field assigned a literal** above the cursor (`root.n = 5`, then `this.n.`).

Otherwise (indexes, method results, conditionals) all methods stay.

## Boundaries & Constraints

**Always:**
- **Unknown types** keep the full list; the extension never guesses.
- **Labelling:** the item detail says "for strings" (or the type) when narrowed.
- **Several categories:** methods with more than one category are kept if any of them applies (`contains`).

**Never:**
- runtime type inference;
- validation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| STRING | `"test".` | 122 methods incl. `uppercase`, `parse_json`, `re_match`; not `abs` / `append` | — |
| ARRAY / OBJECT | `[1,2].` / `{"a":1}.` | `append` / `keys`; not `uppercase` | — |
| FIELD | `root.n = 5`, then `this.n.` | number methods incl. `abs` | — |
| UNKNOWN | `this.items[0].`, `if … { } else { }.`, `"a".length().` | all 193 | — |

</frozen-after-approval>

## Implementation Notes

- **Code:**
  - `src/core/bloblang.ts`: `LiteralType`, `TYPE_CATEGORIES`, `methodsFor`, `literalTypeAtStart` and `literalBeforeDot` (spaces are skipped in the raw text, because a string is blank in the scanned code), plus `categories` on catalog entries.
  - `src/core/bloblangNames.ts`: a `type` on assignments and `typeOfPath`.
- **Transform:** version 6 (catalog entries now carry all their categories).
- **Counts in 4.112.0:** string 122, array 72, object 71, number 56, boolean 16.

## Review Triage Log

**Pass 1 (quick, inline by the parent, 2026-10-08):** I checked the cases above against the real catalog, the block / index / method-result exclusions, and the 2.19/2.20 tests (unchanged). No findings.

**Re-verification:** `npm test` 501 passing; `npm run test:corpus` 65 passed.
