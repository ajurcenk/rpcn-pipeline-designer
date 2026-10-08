---
title: 'Bloblang completion of names already written'
type: 'feature'
ticket: '20'
created: '2026-10-08'
status: done
baseline_revision: '623ebf98ddf72274501a75ca56cea366f2f0e2f3'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-bloblang-function-and-method-completion-and-hover-plan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** After `this.` only Bloblang methods are offered. The user's screenshot (2026-10-08) shows `this.test = content().string()` with `let h = this.test` on the next line; they asked for `test` to be offered.

**Approach (user: "yes, build 2.20"):** a static read of the Bloblang above the cursor. Lint with 4.112.0 accepts `this.x = …`, and a later step's `this.x` reads an earlier step's `root.x`.
- **Where names come from:** the current mapping up to the cursor's line, and earlier Bloblang regions in document order (the input's `generate` mapping, earlier processors, earlier `switch` cases).
- **What counts as a name:**
  - fields: assigned with `root.a =`, `this.a =` or a bare `a =`, or read as `this.a` / `root.a`; object-literal keys become nested fields;
  - `let` variables, after `$`;
  - metadata keys (`meta k =`, `@k`), after `@`.
- **How they are offered:** each item says where it came from ("assigned on line N", "set by an earlier step, line N", "read on line N"). Fields come before the methods.

## Boundaries & Constraints

**Always:**
- **Not counted:** names inside Bloblang strings and comments, the line being typed, later steps, and a method name at the end of a path.

**Never:**
- input-data inference;
- type inference;
- items outside Bloblang.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| USER_CASE | `this.test = …` then `let h = this.` | `test` first, "assigned on line 4" | — |
| EARLIER_STEP | `root.id` in the input's `generate` mapping | `id`, "set by an earlier step" | — |
| NESTED | `root.user = {"name": …, "age": …}` then `this.user.` | `age`, `name` | — |
| VARIABLES / METADATA | `let h`; `meta source =`, `@kafka_key` | after `$`: `h`; after `@`: `source`, `kafka_key` | — |
| EXCLUDED | strings, comments, the current line, later steps, method names | not offered | — |

</frozen-after-approval>

## Implementation Notes

- **Core:**
  - `src/core/bloblangNames.ts` holds `knownNames` (a statement regex per line start over the code with strings and comments blanked, plus a read regex, an object-key scan, `$` and `@` scans), `fieldSuggestions`, `nameSuggestions` and `originText`.
  - `bloblangContext` gains the `variable` and `metadata` kinds, a `receiver` (`this`/`root` plus a path) and `regionStart`.
- **Provider:** field and variable items come first (`sortText` 0…), then catalog items (1…). The `.` trigger from 2.19 applies.
- **Correction to what I told the user:** I had said clicking an item "jumps there". Completion items cannot navigate, so the line number is shown in the item's detail and docs instead.

## Review Triage Log

**Pass 1 (quick, inline by the parent, 2026-10-08):** I checked the diff, the user's case end to end through VS Code, the exclusions (strings, comments, the current line, later steps) and the updated 2.19 expectations (`$` and `@` now give contexts). No findings.

**Re-verification:** `npm test` 497 passing; `npm run test:corpus` 65 passed.
