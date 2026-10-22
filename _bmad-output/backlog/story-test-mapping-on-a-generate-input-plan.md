---
title: 'Test mapping on a generate input'
type: 'feature'
ticket: '16'
created: '2026-10-22'
status: done
baseline_revision: '23e8f65ea96ed157b541b1ceb39140067dbf9e11'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/backlog/story-test-mapping-on-a-generate-input.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A `generate` input's mapping, the Bloblang that builds test data, has no Test mapping. Story 22 made the finder know it (kind `generate`) but kept it out of the lens and the panel.

**Approach:**
- **Lens and panel:** a **▷ Test mapping** lens on the generate `mapping:` key opens an output-only test panel.
- **Running it:** it shows one generated message, content and metadata, or the binary's error. It re-runs when the mapping changes or on Run.
- **Run method (user decision, 2026-10-22):** the run feeds one **empty** message (content `""`, amended by the user 2026-10-22 after the review: `null` made `this`-reading mappings pass where the real input fails) through the mapping as a `mapping` processor. A failing generate *input* retries forever on the binary, so the input itself isn't run.
- **Hidden:** samples, From previous step and Add label are hidden for generate panels.

## Boundaries & Constraints

**Always:** the story's acceptance criteria 1-4 are the contract (`_bmad-output/backlog/story-test-mapping-on-a-generate-input.md`).
- **Lens and command:**
  - the lens and the Test mapping command (cursor and path) include `generate` entries;
  - the lens title is `▷ Test mapping` with no sample count;
  - the panel title is `Bloblang: <label ?? path>`, the kind pill shows `generate`.
- **Run:** `testConfig('generate', source, …)` builds:
  - a `generate` input with `mapping: root = ""`, count 1;
  - then `- mapping: <source>`;
  - then the result mapping.
  - Classification is unchanged, so parse errors, `failed assignment (line N)` with Go to line, deleted and error all work as for processors.
  - `${VAR}` in the source behaves as for processors.
- **Webview (`kind === 'generate'`):**
  - **Hidden:** the Input column; the sample picker, From previous step and the "no label" note; the "Changed:" footer and the change marks, since there's no input to compare.
  - **Runs:** with no content to type, Run is always enabled. Run on change re-runs on a source change. On open, the panel runs once.
  - **Output and states:** the Output column, the status pill and all error states work as today.
  - **Keyboard and screen reader:** 4.11's model holds, minus the missing controls. The announcer's ok text has no changes part.
- **Host (`kind === 'generate'`):** the panel never writes or reads the samples file, sends no `samplesFile`, `unlabelledPath` or `previousStep`, and refuses `sampleAdded` / `sampleFromPreviousRequested` / `addLabelRequested` if they arrive.
- **Tracking:** generate panels follow their generate entry (4.10's rules within the same side, story 22's `sameSide`).
- **Types:** the panel and run accept `generate` explicitly. `testConfig` and `labelInsertion` handle or reject it explicitly, with no implicit `- generate:` processor (story 22 review, finding 2).
- **Protocol:** no new message. The `kind` already allows `generate`. Add a fixture `snapshot-generate.json`.
- **Docs (AI-8):**
  - spec CAP-16 includes generate mappings (intent :84 and the scope lines); AD-21 states the generate run (the empty-message `mapping` run, and why);
  - EXPERIENCE gains a test-panel row for generate;
  - CHANGELOG.
- **AI-2:** suite 90 pinned to 2 CPUs, alone, 5 runs in a row.

**Never:**
- running the generate input itself;
- `count` > 1;
- samples for generate;
- other Bloblang fields;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LENS | config with `input.generate.mapping` (and in a broker) | `▷ Test mapping` on its key line, no count | none |
| OPEN_RUN | open the panel | one run; output content and metadata; no Input column, no samples, no Changed footer | none |
| RERUN | Run, or edit the mapping with Run on change | a new run, for example a fresh `uuid_v4()` | none |
| FAILED | `root.n = "x".number()` | "Failed on mapping line N", Go to line to the YAML line | none |
| PARSE | a syntax error | the parse-error card at the YAML position, as for processors | none |
| DELETED | `root = deleted()` | the deleted state | none |
| META | `meta k = "v"` | output Metadata tab shows `k` | none |
| NO_SAMPLES | generate panel | no `.samples.json` written; sample intents refused | none |
| PROCESSOR_UNCHANGED | processor panels | as today (samples, From previous step, Add label) | none |

</frozen-after-approval>

## Code Map

- `src/core/bloblangRun.ts:29-53` (`testConfig`) and the runner (`src/adapters/redpandaConnect/bloblangRunner.ts:75,85`).
- `src/adapters/vscode/bloblangLens.ts:69-78` (story 22 filters generate out; include it, with no `sampleCount`).
- `src/adapters/bloblangPanel/panels.ts`:
  - the `processorsOnly` call sites (story 22) for the command, show and current: allow generate;
  - samples (`samples()` / `postSnapshot` ~500-523), `addLabel` ~654, `sampleFromPrevious` ~541, `previousStepOf` ~1559: skip for generate;
  - the "no mapping or mutation processor" messages (~1439).
- `src/core/bloblangProcessors.ts` (`processorsOnly`, `TestableProcessor`); `src/core/labelEdit.ts:81-100`.
- **Webview:**
  - `webview/src/bloblang/TestPanel.tsx`: the Input column at ~704; the empty-content gates at ~399, 544 and the Run button ~685; the samples at ~306 and 674; the announcer;
  - `OutputView.tsx:169-185` (Changed footer).
- **Tests:**
  - suite 90 (the matrix, with the fake binary: its run body keys off the mapping text);
  - `webview/src/bloblang/TestPanel.test.tsx` (the generate layout);
  - `src/test/core` (`testConfig` for generate);
  - the protocol fixture.
- **Docs:**
  - the spec at `_bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md` (CAP-16 :84, the scope lines);
  - the architecture's AD-21 (:204);
  - `ux-rpcn-vscode-designer/EXPERIENCE.md`;
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] Run config for generate + unit test.
- [x] Lens, command and panel host for generate (samples, Add label and previous skipped).
- [x] Webview output-only layout + tests.
- [x] Suite 90 matrix + pinned runs.
- [x] Spec, architecture, EXPERIENCE, CHANGELOG.

**Acceptance Criteria:**
- Given the dev host with the real binary, when the user clicks Test mapping on a generate mapping, then the panel shows one generated message. Run gives a fresh one, and a failing mapping shows its error with Go to line.
- Given the change, when `npm run compile`, `npm run test:webview`, `npm run test:corpus`, the full stable suite (alone, under xvfb) and 5 pinned runs of suite 90 run, then all pass.

## Implementation Notes

- `testConfig` switches on the kind: `generate` builds `root = ""` (`GENERATE_RUN_INPUT`; was `root = null` until the user's amendment of 2026-10-22: an empty message) as the generate input and `- mapping: <source>`; `labelInsertion` returns `undefined` for `generate`.
- Host: the panel's `generate` getter (the kind never changes, `sameSide`) gives no `ref`, no samples watch (`NO_WATCH`), no `samples()` read and no `samples` post, no `samplesFile` / `unlabelledPath` / `previousStep`, no page `data-samples`; `receive` refuses every sample intent and Add label (logged); `relinkOnSave` skips it; `runTest` passes an empty input for it. `processorsOnly` stays only for 4.18's previous steps (and the corpus parity).
- Messages reworded: `NO_MAPPING_AT_CURSOR` ("…, or a generate input's mapping."), `NO_LONGER_THERE` ("That mapping is no longer there."); README's quote follows.
- Webview: `generateNow` ref from the snapshot's kind; the first snapshot runs once whatever Run on change says; `OutputBody` `marks` and `ResultFooter` `changes` props; `announcement(result, changes)`; `.rpcn-bl-io-single`; the output's empty text is `GENERATE_EMPTY_TEXT`.
- Verified 2026-10-22: `npm run compile`, `npm run test:webview` (308), `npm run test:corpus` (156), the full stable suite alone under xvfb (866 passing), and suite 90 pinned to 2 CPUs ×5 (76 passing each). The dev-host check with the real binary (AC 1) was not run.
- Review fixes (2026-10-22): the page carries `data-kind` so a generate panel's first paint is output only; the announcer's key for a generate ok result includes its content and meta, and a new key remounts the announcer's text, so a new message is said even in the same time; the removed notice says "This mapping was removed …" for generate; Go to line assertions in suite 90 wait for the editor.
- Real-binary comparison (2026-10-22, `rpk connect` 4.112.0 and `.cache/redpanda-connect/4.100.0/redpanda-connect`, identical on both): a real `input.generate` (count 1, `interval: ""`, the same result mapping, 6 s timeout) vs the panel's `testConfig('generate', …)`.

  | Mapping | Real `generate` input | Panel |
  |---|---|---|
  | `meta k = "v"` | ok `""`, meta `{k: v}` | ok `""`, meta `{k: v}` |
  | `root = content()` | ok `""` | ok `""` |
  | `root = this` | logs and retries `failed assignment (line 1): unable to reference message as structured (with 'this'): message is empty` (timeout) | invalidInput, same message |
  | `root.x = this.y` | retries, same error (with 'this.y') | invalidInput, same message |
  | `root.n = this.nope + 1` | retries, same error (with 'this.nope') | invalidInput, same message |
  | `root.id = uuid_v4()` | ok `{"id": <uuid>}` | ok `{"id": <another uuid>}` |
  | `root.c = count("a")` | ok `{"c":1}` | ok `{"c":1}` |
  | `root = deleted()` | no output, never ends (timeout) | deleted |

  All match but `deleted()` (documented in AD-21, EXPERIENCE, CHANGELOG and README). The `this` cases show as invalidInput, whose card hint ("check the input's Content") does not fit a panel with no input.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 2 medium, 5 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The `null`-message run doesn't match a real generate input: `this` is null where the real input fails ("message is empty"); meta-only and `content()` give `null` where the real input gives `""` | medium | intent amended (user) + patch | Reproduced on v4.100.0. The user chose an empty message (`""`); verified against the real binary. `deleted()` keeps "Message deleted" (the real input hangs), documented. |
| 2 | First paint shows the Input column before the snapshot says `generate` | low | patch | The page data carries the kind. |
| 3 | The 4.11 focus moves (leaving no-binary or removed) are untested for generate, and so is the Tab order | low | patch | Webview tests added; EXPERIENCE says focus goes to Run. |
| 4 | The announcer is silent on later successful generate Runs | medium | patch | For generate, the ok key includes the content, so a new message is announced. |
| 5 | The removed notice says "processor" for a generate panel | low | patch | It says "mapping". |
| 6 | README paragraph order: the two-column description reads as the generate panel | low | patch | Reordered. |
| 7 | FAILED (16) reads `activeTextEditor` right after `goToLine` without waiting | low | patch | It waits for it, and so does the 4.8 test. |
| 8 | AC 1 (real-binary dev-host check) not done | false | reject | It's the user's check, after the review. The real-binary comparison is now part of finding 1's fix. |

## Verification

**Commands:**
- `npm run compile`; `npm run test:webview`; `npm run test:corpus`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone); `taskset -c 0,1 xvfb-run -a npx vscode-test --label stable --grep "Bloblang test panel \(integration"` ×5 -- expected: all pass.

**Orchestrator verification (2026-10-22, after the review patches):** `npm run compile` OK; `npm run test:webview` 311; `npm run test:corpus` 156. Suite 90 pinned to 2 CPUs, 5 runs in a row, 76 passing each. Full stable suite: the first run took 59 minutes (normally about 5) with 865 passing and 1 failing, 91 GENERATE TOP / FIX, during a machine stall (local Redpanda brokers running). The rerun had 866 passing in 4m42s. Manual check (the user, dev host, 2026-10-22): steps 1-5 passed (lens with no count; output-only panel running once with content and metadata; Run gives a fresh message; a failing mapping shows "Failed on mapping line N" with Go to line; a `this` read shows the empty-message hint). Step 6 was a wrong expectation in the checklist: `pipeline.processors[0]` has no previous step, so no From previous step button, as designed in 4.18.
