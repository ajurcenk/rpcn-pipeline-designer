---
title: 'Full test-panel protocol and result types with fixtures'
type: 'feature'
ticket: '4'
created: '2026-10-13'
status: done
baseline_revision: '7ac8f9a0a59cf32d34a596445f317a30a1ecb9b5'
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

**Problem:** 4.2's panel protocol (`src/shared/bloblangProtocol.ts`) carries only content in and out. The panel lane (4.7 metadata, 4.8 errors and states, 4.9 samples) and the webview need one agreed contract and sample data before the host sends any of it. Otherwise each entry invents its own message shape.

**Approach:** contracts early, as epic 3's entry 3.2 did:
- complete the panel protocol in `src/shared` with every message and result the epic needs, each with a hand-written validator;
- add JSON fixtures that the webview tests render;
- update 4.2's producers and consumers to the new shapes, behaviour unchanged, with no metadata, samples or error positions sent yet.

## Boundaries & Constraints

**Always:**
- **Results** (`BloblangResult`):
  - `ok {content, meta, changes}`. `meta` maps keys to JSON values. `changes` is `{fields: {added, changed, removed} | null, meta: {added, changed, removed}}`, top-level keys only; `fields` is `null` when the input or output is not a JSON object.
  - `failed {message, mappingLine?, fileLine?}`.
  - `parseError {message, excerpt, mappingLine, mappingChar, fileLine, fileChar}`.
  - `invalidInput {message}`.
  - `deleted`.
  - `error {message}`: any other failure, verbatim.
  - Lines and chars are 1-based. File positions are document line and character, as `vscode.Position` would show them plus 1.
- **Host → webview:**
  - `snapshot {title, kind, source, binary, samples, selected}`: the whole state, on `ready`.
  - `result {result, durationMs, binary}`.
  - `samples {samples, selected}`.
  - `binary {status}`.
  - `binary` / `status` reuse the graph's `BinaryStatus` (`protocol.ts:93`).
  - A sample is `{name, content, meta}`, with `meta` mapping keys to strings, which is what the generate input sets.
- **Webview → host:**
  - `ready`;
  - `run {content, meta}` (replaces 4.2's `run {input}`);
  - `inputEdited {content, meta}`;
  - `sampleAdded {name}`, `sampleRenamed {from, to}`, `sampleDeleted {name}`, `sampleSwitched {name}`;
  - `goToLine {line}`, a positive integer;
  - `installGuideRequested`, `setPathRequested`, `retryRequested`.
- **Validators** follow `protocol.ts`:
  - host messages are checked, then returned unchanged;
  - webview messages come back as fresh copies with only their own fields;
  - malformed input gives `undefined` and never throws;
  - sample names are non-empty strings of at most 100 characters; metadata keys are non-empty.
- **4.2 keeps working:**
  - the host's run sends `{content, meta: {}}`;
  - `parseRunOutput` fills `ok.meta` from the run's `meta` and computes `changes`;
  - the snapshot sends `samples: []`, `selected: null` and the binary status;
  - the webview posts `run {content, meta: {}}`.
- **AI-8:** AD-5's Bloblang panel line names the full union.

**Never:**
- sending metadata from the panel UI, rendering errors or states, storing samples, Go to line, or the CodeLens count (4.7–4.9);
- changing the graph protocol (`protocol.ts`), except importing its `BinaryStatus` type;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| VALID_HOST | each host message and each result kind | validator returns it unchanged | none |
| VALID_WEBVIEW | each webview message, with extra fields | fresh copy with only its own fields | none |
| MALFORMED | wrong `type`, missing field, wrong field type, `NaN` line, `0` line, empty sample name, 101-char name, non-object meta, non-string meta value from webview | `undefined` | never throws (getter that throws, cyclic object) |
| CHANGES | input `{a:1,b:2}` → output `{a:1,b:3,c:4}`, meta `{k:x}` → `{k:x,j:y}` | fields added `[c]`, changed `[b]`, removed `[]`; meta added `[j]` | non-JSON content: `fields: null` |
| FIXTURES | every file in `src/test/fixtures/bloblang/` | passes `parseBloblangHostMessage` and covers every result kind and the `samples` / `binary` messages | none |
| COMPAT_42 | 4.2's integration suite | passes unchanged in behaviour (assertions updated only for the new shapes) | none |

</frozen-after-approval>

## Code Map

- `src/shared/bloblangProtocol.ts` -- 4.2's union and validators (`parseBloblangHostMessage`, `parseBloblangWebviewMessage`). Extend them per the Boundaries.
- `src/shared/protocol.ts:93` -- `HostStatus`, `BinaryStatus`. Import the type and don't change it.
- `src/core/bloblangRun.ts:89` -- `parseRunOutput`. Read the run line's `meta` into `ok.meta`, and add a pure `changesOf(input, outputContent, inputMeta, outputMeta)` (exported, unit-tested). Classifying `invalidInput` and `parseError` is 4.8's job; this entry only defines them.
- `src/adapters/bloblangPanel/panels.ts` -- the snapshot fields; `run` now carries `{content, meta}`.
- `webview/src/bloblang/TestPanel.tsx`, `host.ts` -- post `run {content, meta: {}}`; render `ok.content` as today and ignore the other new fields for now.
- `src/test/fixtures/bloblang/*.json` (new) -- one host message per result kind (`ok` with changes, `failed` with lines, `parseError`, `invalidInput`, `deleted`, `error`), `samples` with three samples, `binary` missing, and a `snapshot`. Webview tests read them as `webview/src/layout.test.ts:14` reads `fixtures/models`.
- Tests:
  - `src/test/shared/bloblangProtocol.test.ts` (extend: the matrix);
  - `src/test/core/bloblangRun.test.ts` (CHANGES);
  - a webview test that every fixture validates;
  - `src/test/integration/suites/90-bloblang-panel.ts` (COMPAT_42, shapes only).
- Architecture: AD-5's Bloblang line.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/bloblangProtocol.ts` + its tests -- the full union and validators (VALID_*, MALFORMED).
- [x] `src/core/bloblangRun.ts` + tests -- `ok.meta`, `changesOf` (CHANGES).
- [x] `src/adapters/bloblangPanel/panels.ts`, `webview/src/bloblang/*` -- the 4.2 producers and consumers on the new shapes (COMPAT_42).
- [x] `src/test/fixtures/bloblang/` + a webview fixture test (FIXTURES).
- [x] Architecture -- the AD-5 line.

**Acceptance Criteria:**
- Given the change, when `npm run compile`, `npm test`, `npm run test:webview` and `npm run test:corpus` run, then all pass, and the 4.2 panel still runs a mapping in the dev host as before.

## Implementation Notes

- `parseRunOutput` takes a 4th argument, the run's input `{content, meta}`; `runMappingTest` passes `{content, meta: {}}` (the panel host ignores `run.meta` until 4.7). Empty metadata keys in the run's output are dropped, so `ok.meta` always validates.
- `changesOf`: `added`/`changed` follow the output's key order, `removed` the input's; values compare deeply (object key order ignored, `"1"` vs `1` is changed).
- The host validator also requires sample names to be distinct and `selected` to be `null` or one of them (snapshot and `samples`). JSON values reject non-finite numbers and cycles.
- Webview `run`/`inputEdited` meta is copied with `Object.fromEntries`, so a `__proto__` key stays data.
- Until 4.8, the webview shows `parseError` and `invalidInput` with the existing "could not run" block; `samples` and `binary` messages are ignored.
- `BinaryStatus` is re-exported from `bloblangProtocol.ts` (type only); `protocol.ts` is unchanged.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 1 medium, 2 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | No test covers the interim webview handling of `parseError`, `invalidInput`, `samples`, `binary` | low | patch | Test added in `TestPanel.test.tsx`. |
| 2 | Fixtures validated but never rendered (Intent says the webview tests render them) | medium | patch | `it.each` renders all 9 fixtures in `TestPanel` and checks today's output per kind. |
| 3 | AD-15 still says `src/shared` imports nothing internal | low | patch | AD-15 now allows type-only imports between `src/shared` modules (4.4). |

## Verification

**Results (2026-10-13):** `npm run compile` exit 0; `npm test` 697 passing on stable (1.141.0); floor 696 + 1 failing in the bug 15 test LATE_DISPOSED during a 9-minute floor run (4.4 does not touch the graph; 1.100 is not worked on, user decision); `npm run test:webview` 174; `npm run test:corpus` 129.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.
