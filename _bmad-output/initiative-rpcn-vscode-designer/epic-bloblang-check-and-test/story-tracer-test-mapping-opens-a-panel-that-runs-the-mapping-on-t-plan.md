---
title: 'Tracer: Test mapping opens a panel that runs the mapping on typed JSON'
type: 'feature'
ticket: '2'
created: '2026-10-13'
status: 'built'
baseline_revision: '59c31aa0eb4e28582a59c0dd01459f72129e56c4'
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

**Problem:** Epic 4 has no path yet from a `mapping` / `mutation` processor in the YAML to a run on the developer's binary and back to a panel. Every later entry (4.3–4.12) builds on that path.

**Approach:** The thinnest working path through every layer:
- a "▷ Test mapping" CodeLens and a command;
- a core function that finds the processors and their Bloblang;
- a pure builder for AD-21's one-message `run` config, and an adapter that runs it through the existing spawn site;
- a second webview bundle and a minimal protocol;
- one panel per mapping where typed JSON input shows the output.

Content only: metadata, the sample file, the error cards and the live parse come later (4.5, 4.7–4.9).

## Boundaries & Constraints

**Always:**
- **AD-21 test run:** `run` on a temporary config that the adapter writes under the extension's global storage and deletes after the child exits. It goes through `buildRunCommand` (env file and resources as Run uses them) and `runProcess` with a timeout.
  - The config: `http.enabled: false`; logger at warn; a `generate` input with `count: 1` and `interval: ""` that sets the content as a string literal; the code under test as the original kind (`mapping` or `mutation`); then `root = if errored() { {"error": error()} } else { {"content": content().string(), "meta": @} }`; then `stdout` with `codec: lines`.
  - No stdin option is needed (AD-21 supersedes the entry's "stdin option").
- **Results:** exit 0 with one JSON line gives `ok {content}` or `failed {message}`; exit 0 with no line gives `deleted`; any other exit gives `error {message}` (first stderr lines, verbatim).
- **Detected configs only:** only processors in a `processors` list (any depth, `processor_resources` included) whose component is `mapping` or `mutation`. The CodeLens is on that key's line; the command uses the processor at the cursor and shows "Put the cursor in a mapping or mutation processor." otherwise.
- **One panel per mapping,** keyed `uri` plus processor path, titled `Bloblang: {label, else path}`. A second Test mapping on the same processor reveals it. It opens `ViewColumn.Beside` without taking focus from the YAML; entry 10 settles the group.
- **Layering:** the webview imports only `src/shared` (AD-15, eslint). The new protocol lives in `src/shared` with hand-written validators, as `protocol.ts` does. Same CSP as the graph.
- **Docs (AI-8):** AD-1 and AD-5 each get one line for the second panel and protocol. README gets a short "Bloblang test panel (preview)" section. CHANGELOG gets an entry.

**Never:**
- metadata, samples, live parse, error-to-line mapping, Go to line, or graph changes;
- `blobl server`, or a change to `process.ts` stdio;
- running on untitled files;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LENS | detected config with a `mapping` and a nested `mutation` | one lens per processor on its key line; none in non-detected YAML | none |
| OPEN | Test mapping on a lens or at the cursor | panel `Bloblang: <label or path>` beside, focus stays in YAML; second call reveals the same panel | none |
| NO_MAPPING_AT_CURSOR | command with the cursor outside such a processor | message "Put the cursor in a mapping or mutation processor."; no panel | none |
| RUN_OK | input `{"a":1}`, mapping `root.b = this.a + 1` | result `ok`, content `{"a":1,"b":2}` for mutation / `{"b":2}` for mapping | none |
| RUN_FAILED | mapping error on the input | result `failed` with the binary's message | none |
| DELETED | `root = deleted()` | result `deleted` | none |
| RUN_ERROR | non-zero exit (e.g. unparseable mapping, unset `${VAR}`) | result `error` with the stderr text | temp file still removed |
| NO_BINARY | binary not ok | result `error` "No Redpanda Connect binary." (4.8 adds the real state) | no spawn |
| CONTENT_ESCAPE | input with quotes, backslashes, newlines, non-ASCII | the mapping sees the same text | encoded as a valid Bloblang string literal |

</frozen-after-approval>

## Code Map

- `src/core/bloblang.ts:17,109` -- `BLOBLANG_FIELDS` and `bloblangRegions` (raw slices, field-keyed). Don't change them. The new `src/core/bloblangProcessors.ts` walks the parsed YAML for processor maps with a `mapping` / `mutation` key and returns `{path, kind, label?, keyRange, source}` (decoded `Scalar.value`). It's pure; entry 4.3 adds the position map.
- `src/core/bloblangRun.ts` (new, pure) -- `testConfig(kind, source, content)` returns the YAML text, and `parseRunOutput(exit, stdout, stderr)` returns the result.
- `src/adapters/redpandaConnect/args.ts:154-175` -- `buildRunCommand(state, {targets})` gives `{command, args, env}` with `NO_COLOR`, `--resources` and `--env-file`. Reuse it.
- `src/adapters/redpandaConnect/process.ts:97` -- `runProcess(invocation, args, timeoutMs, {env, cwd})`. The only spawn site; don't change stdio.
- `src/adapters/redpandaConnect/bloblang.ts` (new) -- `runMappingTest(state, kind, source, content, storageDir)`.
- `src/adapters/graphPanel/html.ts:25` -- `graphHtml` hard-codes `dist/webview.js` / `.css`. Parameterise the bundle name, and keep `graphHtml` as a wrapper.
- `esbuild.js:58-77` -- the webview context. Add a third context: `webview/src/bloblang/main.tsx` builds `dist/bloblang.js` / `.css`, and the `.vsix` carries it (check `.vscodeignore`).
- `webview/src/bloblang/` (new) -- `main.tsx`, `TestPanel.tsx`, `bloblang.css`. VS Code theme variables only, as `graph.css` does.
- `src/shared/bloblangProtocol.ts` (new):
  - host → webview: `snapshot {title, kind, source}`, `result {result, durationMs, binary}`;
  - webview → host: `ready`, `run {input}`;
  - validators like `parseHostMessage` / `parseWebviewMessage` in `protocol.ts:250,259`.
- `src/adapters/bloblangPanel/panels.ts` (new) -- the `BloblangPanels` registry: `show(uri, path)`, `panelFor(uri, path)` (test seam), and `receive` as on `GraphPanel`.
- `src/adapters/vscode/bloblangLens.ts` (new) -- CodeLens for detected YAML (`DetectionRegistry.isDetected`, `detection.ts:108`), using `parsedDocument` (`parseCache.ts:11`).
- `src/extension.ts:164-179` -- wire it like `RunController` / `GraphPanels`, and expose `bloblangPanels` on `ExtensionApi`.
- `package.json` -- `redpandaConnect.testMapping` "Test mapping", Command Palette only when `editorLangId == yaml`.
- `src/test/helpers/fakeBinary.ts:99` -- `connectScript({run})`. The `run` body prints a JSON line from the config's `$last`. No `blobl` branch is needed (AD-21).
- Tests:
  - unit: `src/test/core/bloblangProcessors.test.ts`, `bloblangRun.test.ts`;
  - integration: `src/test/integration/suites/90-bloblang-panel.ts`, registered in `index.test.ts`;
  - webview: `webview/src/bloblang/TestPanel.test.tsx` (happy-dom).
- Boundaries met (AI-7):
  - 3.1's `html.ts` (the graph still loads);
  - 3.10's locked graph group (with a graph open, Test mapping opens a panel and the graph group stays graph-only);
  - 2.7's `buildRunCommand` (env file reaches the test run).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/bloblangProcessors.ts`, `src/core/bloblangRun.ts` + unit tests -- the processor list (LENS), the config, and output parsing (RUN_OK, RUN_FAILED, DELETED, RUN_ERROR, CONTENT_ESCAPE).
- [x] `src/adapters/redpandaConnect/bloblang.ts` -- temp config, `buildRunCommand` plus `runProcess` (timeout 10 s), cleanup, NO_BINARY.
- [x] `src/shared/bloblangProtocol.ts` + validator tests.
- [x] `src/adapters/bloblangPanel/panels.ts`, `src/adapters/graphPanel/html.ts`, `esbuild.js`, `webview/src/bloblang/*` -- the panel and bundle (OPEN).
- [x] `src/adapters/vscode/bloblangLens.ts`, `src/extension.ts`, `package.json` -- lens, command, NO_MAPPING_AT_CURSOR.
- [x] `src/test/integration/suites/90-bloblang-panel.ts` -- the matrix end to end with a fake `run`, plus the three boundary tests.
- [x] Docs: AD-1 and AD-5 lines, README section, CHANGELOG.

**Acceptance Criteria:**
- Given a detected config in the dev host with the real binary, when the user clicks ▷ Test mapping and types JSON input, then the panel shows the mapping's real output.
- Given the change, when `npm run compile`, `npm test` (stable and floor), `npm run test:webview` and `npm run test:corpus` run, then all pass, and the `.vsix` lists `dist/bloblang.js`.

## Implementation Notes

- Every string in the test config is a YAML double-quoted scalar with everything except printable ASCII escaped (`\xXX` / `\uXXXX` / `\UXXXXXXXX`). The content is a JSON-escaped Bloblang literal, and its `$` is written as `\x24`, so the binary's `${VAR}` substitution never touches it. The code under test keeps its `${VAR}`s. CONTENT_ESCAPE was checked by hand against the real `redpanda-connect` (quotes, backslashes, newlines, tabs, C0/C1 controls, U+2028, CJK, emoji, `${HOME}`): the input came back unchanged. The mapping/mutation, failed, deleted and unset-`${VAR}` cases matched AD-21 on the real binary.
- Untitled files: no lens, and the command shows "Save the file to test its mappings." with no panel.
- Each `run` re-reads the processor at its path from the open document, so unsaved edits are tested. An edit that changes the processor's kind or Bloblang sends the panel a new `snapshot` (no new message type), so the shown code always matches what the next run uses.
- Runs are single flight per panel: while one runs, only the latest input waits and starts when it ends, and only the latest input's result is posted. A run that throws posts an `error` result with the message (a failed post is only logged), so "Running…" always ends.
- An empty input runs nothing, returns the output area to the empty state and disables Run; a result that arrives after the input was cleared is dropped.
- A CodeLens path that no longer resolves (edited away, document closed or no longer detected) shows "That mapping or mutation processor is no longer there."; the cursor message is only for the Command Palette path.
- The webview keeps the typed input with `setState` and runs it again once when a recreated panel gets its snapshot.
- With the graph's group locked, `ViewColumn.Beside` + `preserveFocus` never opened the panel in the graph group (boundary test, stable and floor).

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 3 medium, 3 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The panel shows the snapshot's Bloblang while runs use the edited text | medium | patch | Source was posted only on `ready`. The registry now posts a snapshot when the processor's kind or Bloblang changes; integration and webview tests added. |
| 2 | Position keys: after a reorder a panel runs another processor under the old title | medium | reject | The frozen intent keys panels by `uri` + path; following a processor through edits is entry 4.10 (R8). Recorded for 4.10. |
| 3 | The cursor message appears for lens/API calls | low | patch | `show(uri, path)` now says "That mapping or mutation processor is no longer there."; NO_LONGER_THERE test. |
| 4 | Debounced runs overlap with no limit | medium | patch | Single flight per panel, latest pending input runs next; SINGLE_FLIGHT test. |
| 5 | Clearing the input still runs it | low | patch | Empty input posts nothing and shows the empty state; webview test. |
| 6 | "Running…" can stay when run handling throws | low | patch | An `error` result is posted on failure; no test (no failing-runner seam in the integration suite). |

## Verification

**Results (2026-10-13):** `npm run compile` exit 0; `npm test` 685 passing on stable and on floor; `npm run test:webview` 154; `npm run test:corpus` 123; `vsce ls` lists `dist/bloblang.js` and `dist/bloblang.css`. Manual check (user, 2026-10-13, dev host on VS Code 1.141.0 with the user's `rpk connect`, `bloblang-demo.yaml`): lenses on the mapping, the mutation and the nested switch mapping; panel opens beside with focus kept; output for a mapping and a mutation; the binary's error; deleted; the shown Bloblang follows an edit; the cursor message. Result: "tested, no issues".

**Commands:**
- `npm run compile` -- expected: exit 0 (types, layering lint, three bundles).
- `npm test` -- expected: all pass on stable and floor.
- `npm run test:webview`, `npm run test:corpus` -- expected: all pass.
- `npx vsce ls --no-dependencies | grep dist/bloblang` -- expected: `dist/bloblang.js` and `dist/bloblang.css` listed.

**Manual checks:**
- The user opens a config in the dev host, clicks ▷ Test mapping, types input, and sees the real output.
