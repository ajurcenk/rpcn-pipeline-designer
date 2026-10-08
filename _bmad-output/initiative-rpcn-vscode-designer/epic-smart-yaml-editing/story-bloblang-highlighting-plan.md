---
title: 'Bloblang highlighting'
type: 'feature'
ticket: '9'
created: '2026-10-08'
status: 'built'
baseline_revision: 'e46568c08740da81858e2bc602a1c97c57e3c495'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bloblang in `mapping:` / `check:` values and in `${! }` interpolations is shown as a plain YAML string (CAP-4, E2 R6).

**Approach (AD-14):** two TextMate grammars, for highlighting only.
- `source.bloblang` covers the language: comments, plain and triple-quoted strings, numbers, keywords, `root` / `this`, `$variables`, `@metadata`, functions, methods and operators.
- `bloblang.injection` is injected into `source.yaml` and `source.yaml.1.0`–`1.3`. It highlights:
  - the values (block scalar, plain, single- or double-quoted) of Redpanda Connect Bloblang fields;
  - `${! }` interpolations in any YAML string.

**Decision (the agent's, from the 4.112.0 docs; reported to the user):** the key list holds the 26 field names that are Bloblang wherever they appear and are specific to Redpanda Connect. Injections apply to **every** YAML file, so generic Bloblang field names (`when`, `variables`, `history`, `context`, `image`, …, and the ambiguous `query`, `id`, `input`, `file`) are left out. `mutation` is included as a Bloblang processor.

## Boundaries & Constraints

**Always:**
- **Grammar shape:** VS Code's YAML grammar consumes indentation and a sequence dash with its own `while` rules before injections run. So a key is matched where it starts, and a block ends where the remaining text starts without extra indentation.
- **YAML comments** after a plain value stay YAML comments.

**Never:**
- Bloblang completion, diagnostics or a language server;
- a language id of our own;
- highlighting values of other keys.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| BLOCK | `- mapping: \|` block | every content line is Bloblang; the next item and a sibling key are YAML again | — |
| INLINE | plain, single- and double-quoted `check:` / `mapping:` | Bloblang tokens; a trailing `# yaml comment` stays YAML | — |
| INTERPOLATION | `key: ${! json("id") }`, inside a quoted path | `meta.interpolation.bloblang` | — |
| PLAIN_STRING | `message: root = this`, `topic: events` | no Bloblang scopes | — |
| OTHER_YAML | `when:`, `variables:`, `query:` | untouched | — |
| TRIPLE | a `"""` string holding YAML-looking text | one string until it closes | — |
| CORPUS | `deduplicate`, `eval`, `cdc_replication` | every mapping block line and every `${! }` outside Bloblang strings is highlighted | — |

</frozen-after-approval>

## Implementation Notes

- **Files and contribution:** `syntaxes/bloblang.tmLanguage.json` and `syntaxes/bloblang.injection.tmLanguage.json`, contributed in `package.json` `grammars` (no `language`; the injection has `injectTo` for the five YAML scopes). The `.vsix` contains both.
- **Test tokenizer:** `src/test/helpers/tokenize.ts` tokenizes with VS Code's own YAML grammars from the running test instance (`vscode.env.appRoot`) plus our injection, using `vscode-textmate` 9.3.2 and `vscode-oniguruma` 2.0.1. Both are MIT-licensed devDependencies, not bundled. `src/test/helpers/webassembly.d.ts` declares the two WebAssembly types their typings need.
- **First approach:** begin rules anchored at `^(\s*)key:` matched only at column 0, because the YAML grammar's `while` rules consume indentation. The fix uses `(?<![^\s-])key` to begin, and `(?:^|\G)(?=\S)` to end.
- **Guard test:** every grammar key is Bloblang everywhere it appears in the 4.112.0 docs (or is a Bloblang processor).
- **`eval.yaml`:** it embeds a full config in a triple-quoted Bloblang prompt, which is correctly one string.

## Review Triage Log

**Pass 1 (quick, inline by the parent, 2026-10-08):** I checked the grammar against VS Code 1.140's YAML grammar, the corpus, generic YAML keys and the `.vsix` contents. No findings.

**Re-verification:** `npm test` 475 passing; `npm run test:corpus` 65 passed.
