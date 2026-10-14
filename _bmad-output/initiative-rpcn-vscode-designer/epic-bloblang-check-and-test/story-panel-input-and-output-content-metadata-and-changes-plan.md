---
title: 'Panel input and output: content, metadata and changes'
type: 'feature'
ticket: '7'
created: '2026-10-14'
status: done
baseline_revision: 'da91681c068fd673175fe52f516254f05e3a8613'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/initiative-rpcn-vscode-designer/brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 4.2's test panel takes content only. It shows the raw output text and drops metadata both ways, so a developer can't test a mapping that reads or sets `@` metadata or see what the mapping changed (E4 R5, CAP-16).

**Approach:** Build the prototype's success layout:
- the input has Content and Metadata tabs;
- the output has Content and Metadata tabs, with added or changed fields and keys marked and listed;
- a status pill shows the duration and the binary;
- a toolbar has "Run on change" (on by default) and Run.

The metadata travels by AD-21's route: `generate` sets it, and the run's `{content, meta}` line returns it. 4.4's protocol already carries all of this.

## Boundaries & Constraints

**Always:**
- **Metadata in:**
  - The host passes `run.meta` to the test run, and `testConfig` adds one `meta "<key>" = "<value>"` per entry to the `generate` mapping. The key and value are Bloblang string literals, and `$` is escaped as for the content, so `${…}` in a value stays literal.
  - `parseRunOutput` gets the real input meta, so `changes.meta` is right.
  - The emitted form is checked on both pinned binaries (`.cache/redpanda-connect/4.100.0`, `4.112.0`) with a key holding a space, a quote and a non-ASCII character.
- **Input (webview):**
  - Content tab: the 4.2 textarea.
  - Metadata tab: a Key / Value table of text inputs, "+ Add metadata", and a "Remove" button per row. The tab label shows the count of rows with a non-empty key.
  - Rows with an empty key are not sent. If keys repeat, the last row wins.
  - Content, metadata rows, the selected tabs and "Run on change" are view state (`setState`) and survive a reload.
- **Run on change** (checkbox, on by default):
  - When on, a content or metadata edit, or a new snapshot whose source differs, runs the current input 300 ms after the last change.
  - When off, only Run runs.
  - An empty content still runs nothing (4.2). Run is enabled whenever content is non-empty.
- **Output (webview, `ok`):**
  - The Content tab shows the content pretty-printed with 2-space indent when it parses as JSON, otherwise verbatim. The lines of each added or changed top-level field get the marked style: a tint plus a 2px left bar, so meaning never rests on colour alone because the tag list repeats it.
  - The Metadata tab is a read-only Key / Value table, with string values shown raw and other values as JSON. Added and changed rows are marked. The tab shows the key count, or "–" with no result.
  - The footer reads "Changed:" followed by tags: `+name` for added, `~name` for changed, `−name` for removed, with metadata keys prefixed `@`. With no changes it reads "No changes". `changes.fields === null` gives no field tags.
- **Status pill** (header): `✓ Ran in <N> ms · <binary>` for `ok`. Other results keep 4.2's text until 4.8 replaces them.
- **Combined sequences (AI-7):**
  - a mapping edit runs through 4.2's single flight, so only the latest source's result shows;
  - a mapping with a live parse error (4.5) still produces a result (4.2's error text);
  - the 4.4 fixtures render in the new layout.
- **AI-8:** README (the panel section), CHANGELOG, and an EXPERIENCE State Patterns row for the panel's run states (running, result, Run on change off).

- **Decision (user, 2026-10-14):** the read-only Bloblang block from 4.2 is dropped. The panel is only Input and Output, as in the prototype, because the YAML editor beside it shows the mapping. The snapshot still carries `source`, which drives Run on change.

**Never:**
- samples, the Sample picker or "Saved in" (4.9);
- error and deleted cards, Go to line, the no-binary state (4.8);
- the breadcrumb and lifecycle (4.10);
- the full keyboard and screen-reader model (4.11). Native controls with labels are expected here;
- protocol changes;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| META_IN | meta `{k: "v"}`, mapping `root.k = @k` | the config has `meta "k" = "v"`; output content has `"k": "v"` | none |
| META_OUT | mapping `meta out = "x"` | `ok.meta.out = "x"`; `changes.meta.added = ["out"]`; Metadata tab row marked; tag `+@out` | none |
| FIELDS | `{"a":1,"b":2}` → `root.b = 3`, `root.c = 4` | the `b` and `c` lines marked; tags `~b`, `+c` | none |
| ODD_KEYS | meta key `a "b" é`, value `${HOME}` | the run sees the exact key and the literal `${HOME}` | none |
| EMPTY_KEY | a row with key `""` | not sent; the count excludes it | none |
| NOT_JSON | output `hello` | shown verbatim; no field tags | none |
| RUN_ON_CHANGE | on: edit the content, then the mapping | one run each, 300 ms after the last change | none |
| RUN_OFF | off: edit the content and the mapping | no run until Run | none |
| RESTORE | reload the panel | content, metadata rows, tabs and the toggle come back; with the toggle on, it runs once | none |

</frozen-after-approval>

## Code Map

- `src/core/bloblangRun.ts:25` -- `testConfig(kind, source, content)`. Add `meta: InputMeta`, emitting a `meta "<k>" = "<v>"` line per entry after `root = …` in the `generate` mapping (`bloblangString`, `yamlQuoted(…, true)`). `parseRunOutput` (:98) already takes `RunInput`.
- `src/adapters/redpandaConnect/bloblang.ts:54,95` -- `runMappingTest` takes `meta` and passes `{content, meta}` to `parseRunOutput`; remove the "4.7" comment.
- `src/adapters/bloblangPanel/panels.ts:104,139,322` -- `receive` passes `msg.meta`. The single-flight `pending` holds `{content, meta}`. `runTest` / `MappingTestRunner` take `meta`. Update the header comment.
- `src/shared/bloblangProtocol.ts` -- `run {content, meta}`, `ok {content, meta, changes}` and `KeyChanges` already exist. Don't change them.
- `webview/src/bloblang/TestPanel.tsx` -- the layout per the prototype: header with title, kind and status pill; toolbar with "Run on change" and Run; two columns with tabs; footers. Split it into small components (e.g. `MetadataTable.tsx`, `OutputView.tsx`) as the file grows. A pure helper (e.g. `webview/src/bloblang/changes.ts`) maps the pretty-printed JSON to the line spans of each top-level key, and builds the tags.
- `webview/src/bloblang/host.ts` -- view state grows from `{input}` to `{content, meta rows, tabs, runOnChange}`. Read an old `{input}` state as the content.
- `webview/src/bloblang/bloblang.css` -- tokens from the VS Code theme only (`--vscode-*`). For the marked style, a `testing-iconPassed` or `charts-green`-based tint with a fallback.
- Prototype (`context`) -- the success-state markup, labels and the status format. Follow its UI strings: "Input", "Output", "Content", "Metadata", "Key", "Value", "+ Add metadata", "Run on change", "Run", "Changed:".
- Tests:
  - `src/test/core/bloblangRun.test.ts` -- META_IN and ODD_KEYS (config text);
  - `src/test/adapters/redpandaConnect/bloblang.test.ts` -- meta passed through;
  - `webview/src/bloblang/TestPanel.test.tsx` and new helper tests -- FIELDS, NOT_JSON, EMPTY_KEY, RUN_ON_CHANGE, RUN_OFF, RESTORE with fake timers; the 4.4 fixtures render (`fixtures.test.ts`);
  - `src/test/integration/suites/90-bloblang-panel.ts` -- META_IN, META_OUT and FIELDS end to end, with the fake binary's `run` body (`mappingTestRunBody`) extended to echo the `meta` lines it finds in the config into its `{content, meta}` line; and a mapping edit while a run is in flight (AI-7).
- Boundaries met (AI-7): 4.2's single flight and snapshot-on-edit; 4.4's result shapes and fixtures; 4.5's live parse running beside a test run (suite 91's existing test stays green).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/bloblangRun.ts`, `src/adapters/redpandaConnect/bloblang.ts`, `src/adapters/bloblangPanel/panels.ts` + unit tests -- metadata in (META_IN, ODD_KEYS); check the emitted form on both pinned binaries and record the result in Implementation Notes.
- [x] `webview/src/bloblang/*` + webview tests -- the input and output tabs, metadata table, change marks and tags, status pill, Run on change, view state (the matrix's webview rows).
- [x] `src/test/helpers/fakeBinary.ts`, `src/test/integration/suites/90-bloblang-panel.ts` -- META_IN, META_OUT, FIELDS and the in-flight mapping edit.
- [x] Docs -- README, CHANGELOG, EXPERIENCE row.

**Acceptance Criteria:**
- Given the dev host with the real binary, when the user tests a mapping that reads `@k` and sets a field and a metadata key, then the output shows both, with the changes marked and listed, and the status shows the duration and the binary.
- Given the change, when `npm run compile`, `npm test` (stable), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- **Emitted form, checked on both pinned binaries (2026-10-14).** `testConfig(kind, source, content, meta)` writes the `generate` mapping as `root = "<content>"` then one `meta "<key>" = "<value>"` line per entry (`bloblangString` for both, the whole mapping through `yamlQuoted(…, true)`, so `$` is `\x24`). With key `a "b" é` and value `${HOME}`, plus `k: v`, and the processor `root = this` / `root.k = @k` / `root.odd = @"a \"b\" é"` / `meta out = "x"`, `redpanda-connect run` on `.cache/redpanda-connect/4.100.0` and `4.112.0` both printed `{"content":"{\"a\":1,\"k\":\"v\",\"odd\":\"${HOME}\"}","meta":{"a \"b\" é":"${HOME}","k":"v","out":"x"}}`: the exact key, the literal `${HOME}`, and a quoted `meta` key read back with `@"…"`. The real adapter (`runMappingTest`) on both binaries with `root.k = @k`, `root.b = 3`, `meta out = "x"` on `{"a":1,"b":2}` gave `changes.fields {added: [k], changed: [b]}`, `changes.meta {added: [out]}` (~0.65 s per run).
- `meta` is a required parameter of `testConfig`, `runMappingTest` and `MappingTestRunner` (no default), so no caller can drop it silently.
- The panel's single-flight `pending` holds `{content, meta}`; the protocol is unchanged.
- Webview split: `changes.ts` (pure: shown content and top-level key line spans, tags, `inputMeta`, counts), `MetadataTable.tsx` (input and output tables), `OutputView.tsx` (output body, 4.2's non-`ok` text, the "Changed:" footer), `TestPanel.tsx` (layout, Run on change, view state). `host.ts` acquires the VS Code API lazily, so `readViewState` is testable; an old `{input}` state reads as the content.
- Run on change: a new snapshot runs (debounced) only when its `source` differs from the previous snapshot's; the first snapshot after a load runs the restored input once, only with the toggle on. Turning the toggle off cancels a pending debounced run; turning it on runs nothing by itself.
- The status pill shows "Running…" while a run is in flight; for non-`ok` results it keeps 4.2's `<N> ms · <binary>` text, and the output body keeps 4.2's texts (4.8 replaces them).
- The fake binary's `run` body echoes `meta "<k>" = "<v>"` (input) and `meta <k> = "<v>"` (processor) lines for `[A-Za-z0-9_]` keys and values; `SLOW_RUN` sleeps 2 s for the in-flight test. In suite 90 the slow processor is a block scalar, since ` # SLOW_RUN` on a plain scalar is a YAML comment.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 1 medium, 3 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Pretty-printing by `JSON.parse` / `JSON.stringify` alters values: integers above 2^53, `1.0`, `1e2`, duplicate keys, `\u` escapes | medium | patch | Real: `12345678901234567890` showed as `12345678901234567000`. It now pretty-prints only when the compact round trip equals the content; otherwise the content is shown verbatim. |
| 2 | `focusRow` is never cleared, so a tab round trip refocuses the last added metadata key | low | patch | Cleared once the row has been focused; test added. |
| 3 | A snapshot that changes only the kind (`mapping` → `mutation`) does not re-run with Run on change, so the old kind's result stays | low | patch | A run is now scheduled when the kind or the source differs; test added. |
| 4 | The AI-7 integration test posts the second `run` itself | low | reject | Its two halves are covered separately: the host's single flight in suite 90, and the webview re-posting after a changed snapshot in the happy-dom tests. |

## Verification

**Results (2026-10-14, after the review patches):** `npm run compile` exit 0; full stable suite (VS Code 1.141.x) 742 passing; `npm run test:webview` 187; `npm run test:corpus` 129. Floor not worked on (user decision). Manual check (the user, dev host, real rpk): metadata in and out with the changes marked and listed, the status pill, Run on change on and off, plain-text output, restore after reload, removing a metadata row, and a mapping → mutation kind change. No issues.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- In the dev host, the user tests a mapping with metadata in and out, toggles Run on change, and reloads the panel.

