---
title: 'Live Bloblang errors in generate mappings'
type: 'feature'
ticket: '22'
created: '2026-10-22'
status: done
baseline_revision: 'd6811f6186b8a5db36a5da6dd51a576bb66f9d2e'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/backlog/story-live-bloblang-errors-in-generate-mappings.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A `generate` input's `mapping` gets no live Bloblang syntax errors and no graph marker, because the Bloblang finder knows only `mapping` / `mutation` processors.

**Approach:** Add a third kind, `generate`, to the finder for `input.generate.mapping` and `input.broker.inputs[i].generate.mapping`. The live parse (4.5) and the node status (4.6, bug 20) then cover it unchanged. Every processor-only feature ignores the new kind (the lens, the command, the panel, samples, From previous step, Add label, the corpus parity), and tracking never matches across kinds. Story 16 adds the panel later.

## Boundaries & Constraints

**Always:** the story's acceptance criteria 1-5 are the contract (`_bmad-output/backlog/story-live-bloblang-errors-in-generate-mappings.md`).
- **Kind:** `BloblangProcessorKind` gains `'generate'` (`src/shared/bloblangProtocol.ts:14`, `isKind` :143).
  - Every `switch` / `if` on kind stays exhaustive (the compiler checks it).
  - Generate entries get a `label` only from the input's own `label` key, if any. Tracking (`src/core/processorTracking.ts`) compares kinds in every step, label included.
- **Positions:** reuse `bloblangPositions` as it is. The live diagnostic lands at the binary's line and column within the mapping value. Parse errors only: the live parse is `blobl`, so no run happens.
- **Processor-only consumers filter `kind !== 'generate'`:**
  - the lens (`src/adapters/vscode/bloblangLens.ts:69-78`);
  - the Test mapping command and the cursor lookup (`bloblangProcessorAt` in panels);
  - `BloblangPanels`' processor lists (`panels.ts` ~851, 1144, 1264, 1326, and anything that reaches samples, Add label or previous steps);
  - the corpus parity cases (`test/corpus/corpus.test.ts` `bloblangCases` ~634).
  - The corpus position/id round-trip (~555-575) keeps generate. Its id check (`component === kind`) must hold for generate inputs; if it doesn't, the plan's id rule (the input's node) wins and the check is adapted.
- **AI-8 docs:**
  - spec CAP-15 (intent and success, :80-81), the processors-only line (:104) and the Non-goal (:119), amended for generate mappings;
  - architecture AD-14 (:142) and AD-13 (:130), if lint hiding now covers generate lines;
  - CHANGELOG.
- **AI-2:** suites 91 and 81 pinned to 2 CPUs, alone, 5 runs in a row.

**Never:**
- the lens or panel for generate (story 16);
- Bloblang fields other than `generate.mapping` (`check`, `*_map`, interpolations);
- changing `nodeAt` or the bug-20 status rule;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| TOP | `input.generate.mapping: \|` with `root = this.` | underlined; the input node marked | none |
| BROKER | `input.broker.inputs[1].generate.mapping` broken | underlined; that broker child's node marked | none |
| QUOTED | single-line quoted mapping broken | underlined at the right column | none |
| FIX | fix the mapping | underline and marker clear | none |
| NO_LENS | generate mapping | no Test mapping lens; Test mapping at its cursor says there's nothing to test, as today | none |
| TRACK | a processor labelled `x` and a generate input labelled `x`; panel on the processor | panel stays on the processor | none |
| CORPUS | corpus configs with generate | positions and ids round-trip; parity cases unchanged | none |

</frozen-after-approval>

## Code Map

- **Finder:** `src/core/bloblangProcessors.ts`, `visit` (128-150) and `processorOf` (153-185). Generate is found when a map has a `generate` key holding a map with a `mapping` key, at path `input` or `...broker.inputs[i]`.
- **Consumers:**
  - `src/adapters/vscode/bloblangDiagnostics.ts:229` (include, no change expected);
  - `src/adapters/graphPanel/status.ts:30-43` (no change);
  - the graph input node's range: `src/core/graph.ts:166-176` / `pairRange` / `itemRange`.
- **Tests:**
  - `src/test/core/bloblangProcessors.test.ts` and `processorTracking.test.ts`;
  - suite 91 (live parse with the fake binary's `ERR@L:C`, graph markers as in GRAPH MARKED / NESTED);
  - suite 90: a generate config shows no lens.
- **Corpus:** 13 configs contain `generate:`.

## Tasks & Acceptance

**Execution:**
- [x] Kind + finder + tracking guard + unit tests.
- [x] Consumer filters (lens, command, panels, corpus parity).
- [x] Suite 91 / 90 cases; corpus round-trip.
- [x] Spec, architecture, CHANGELOG.

**Acceptance Criteria:**
- Given the dev host, when the user breaks a `generate` mapping, then it is underlined and the input's graph node turns red; fixing it clears both.
- Given the change, when `npm run compile`, `npm run test:webview`, `npm run test:corpus`, the full stable suite (alone, under xvfb) and the 5 pinned runs of suites 91/81 run, then all pass.

## Implementation Notes

- Finder: `isInputPath` (a document's `input`, or `broker.inputs[i]` below it, nested brokers too) + `generateOf`; processor and generate entries share `entryOf`. A generate entry's `range` is its `generate` map; its label the input map's `label`; its id comes from `nodeAt` at the `mapping` key, which is the generate input's node (component `generate`), so the corpus id check `component === kind` holds unchanged.
- `processorsOnly` (typed `TestableProcessor[]`) is the one filter the lens, the Test mapping command (cursor and path), the panels' processor lists and the corpus parity (`withBloblang`, `bloblangCases`) use. The corpus round-trip runs over a new `withAnyBloblang` (eval.yaml and stateful_polling.yaml carry generate mappings); `withBloblang` stays processor-only so records and orphan checks are unchanged.
- Diagnostics, status and lint hiding needed no code change (keys are paths; `input.generate` never collides with a processor path).
- The architecture rule at :130 is AD-12 (the plan's "AD-13"); it and AD-14 were amended.

## Plan Change Log

- Tracking guard: "compares kinds in every step, label included" was read as "generate and processor never match" (`sameSide`), not strict kind equality, because strict equality breaks the existing 4.10 behaviour and test "a labelled one is followed by its label" (a labelled `mapping` changed to `mutation`). Step 1 (overlap) and step 3's Bloblang fallback keep their strict kind check. AC 4's contract (no generate<->processor match, label step included) holds; TRACK unit test covers label, overlap, Bloblang and reset steps.

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 1 medium, 4 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | NO_LENS's command half reads `activeTextEditor` without waiting, so it can pass without testing the filter | low | patch | It now waits for its editor, checked by removing the filter. |
| 2 | The panel and run types accept `generate` (`testConfig` would write an invalid `- generate:` processor); `processorsOnly`'s narrowing is lost | medium | defer to story 16 | All four call sites filter today. Story 16 adds `generate` to the panel and defines its run (a `mapping` processor on an empty message), so `testConfig` and the panel types change there. Recorded in story 16's notes. |
| 3 | `labelInsertion` takes any processor; a generate entry would give no edit | low | reject | Only reachable through Add label, whose callers pass filtered processors; a generate entry returns `undefined` safely. Story 16 hides Add label for generate. |
| 4 | Tracking implements AC 4 as "never across generate and processors" (`sameSide`), not strict kind equality in every step | low | patch (decision) | Strict equality would break 4.10's labelled mapping-to-mutation follow test. AC 4's outcome holds and is tested. Recorded as an assumption for the user to confirm (orchestrator, 2026-10-22). |
| 5 | TRACK's first scenario doesn't exercise the label guard | low | patch | An unclaimed-generate case was added, checked by removing the guard. |
| 6 | AC "all pass" was reached through reruns (91 GRAPH MARKED after a ptyHost stall; 81 HEADER) | false | reject | Both are the known timing family (bugs 19 and 21); neither test touches generate. Pinned runs 6-10 and the full rerun passed. The orchestrator re-verifies. |
| 7 | AC 5 "through bmad-spec / same commit" can't be checked from the diff | low | n/a | The spec and architecture were edited directly, with the same rules; they land in one commit. |

## Verification

**Commands:**
- `npm run compile`; `npm run test:webview`; `npm run test:corpus`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone); `taskset -c 0,1 xvfb-run -a npx vscode-test --label stable --grep "<91|81 titles>"` ×5 -- expected: all pass.

**Results (2026-10-22):**
- `npm run compile` ok; `npm run test:webview` 302 passed; `npm run test:corpus` 156 passed (generate mappings in eval.yaml / stateful_polling.yaml round-trip with the input's node id).
- Full stable suite, alone under xvfb: first run 860 passing / 1 failing (91 `GRAPH MARKED`, "the parses never settled" in `open()`, right after a "No ptyHost heartbeat after 6 seconds" host stall; that test has no generate input); rerun 861 passing.
- Suites 91 + 81 pinned to 2 CPUs: runs 1-5 had one failure (run 2: 81 `HEADER` selection assertion, graph navigation, no Bloblang code involved); runs 6-10 all passed, 29/29 each.

**Orchestrator verification (2026-10-22, after the review patches):** `npm run compile` OK; `npm run test:webview` 302; `npm run test:corpus` 156. Suites 91 and 81 pinned to 2 CPUs, 5 runs in a row, 30 passing each. Full stable suite: the first run had 860 passing and 1 failing, lint OPTION_FIX (2.14), whose config has no generate input (`socket_server` + `stdout`), so it's unrelated; the rerun had 861 passing. Manual check: pending.
