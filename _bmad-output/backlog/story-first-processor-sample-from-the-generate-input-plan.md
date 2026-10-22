---
title: "First processor's sample from the generate input"
type: 'feature'
ticket: '23'
created: '2026-10-22'
status: 'built'
baseline_revision: '3a3a4cec9cae179f044d8684a344939349d18711'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/backlog/story-first-processor-sample-from-the-generate-input.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The first processor of `pipeline.processors` has no previous step, so its sample is typed by hand, even when a `generate` input produces exactly the message it receives.

**Approach:**
- **Where:** when the document's only input is a top-level `input.generate` with a mapping, the generate input is the previous step of `pipeline.processors[0]`, and so the end of the chain for later processors.
- **Running it:** From previous step runs the generate mapping with story 16's empty-message run, then the processors after it as in 4.18.
- **Scope:** this is the one exception to "never crosses a list boundary". Everything else stays 4.18.

## Boundaries & Constraints

**Always:** the story's acceptance criteria 1-7 are the contract (`_bmad-output/backlog/story-first-processor-sample-from-the-generate-input.md`).
- **`previousSteps(processors, path)`** (`src/core/bloblangProcessors.ts:117`):
  - gets the unfiltered list (processors and generate entries);
  - walks back as today;
  - when the walk reaches index 0 of the document's `pipeline.processors` (same `documents[i].` prefix), appends that document's `input.generate` entry, if one exists and the input is not a broker.
  - The generate step is always last, and it needs no sample: it starts the chain.
- **Callers:**
  - `seed()` (`panels.ts:567`) and `previousStepOf` (`panels.ts:1604`) pass the unfiltered list;
  - the chain runs each step with its own kind (`testConfig('generate', …)` for the generate step, ignoring the input content);
  - a processor step's selected sample still starts the chain at that step (4.18).
- **Naming:** the generate step's title is `label ?? 'input.generate'` (`stepTitle`). Sample name and messages follow 4.18.
- **Generate panels themselves:** unchanged (story 16). They never get a previous step.
- **Docs (AI-8):** AD-21's From previous step line (the exception); EXPERIENCE's samples row; CHANGELOG.
- **AI-2:** suite 90 pinned to 2 CPUs, alone, 5 runs in a row.

**Never:**
- broker inputs or other input kinds;
- crossing any other list boundary;
- running the generate input itself (always story 16's empty-message run);
- a new protocol message;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FIRST | generate + `processors[0]` mapping | button "New sample from input.generate"; the saved sample is the generate output (content + meta) | none |
| CHAIN | `processors[1]`, no samples before it | generate runs, then `processors[0]`; its output is saved | none |
| OWN_SAMPLE | `processors[0]` has a selected sample, panel on `processors[1]` | chain starts at `processors[0]` (4.18), no generate run | none |
| LABEL | `input: {label: gen, generate: …}` | named "from gen" | none |
| FAILS | generate mapping fails / reads `this` / deletes | nothing saved; error names the step | none |
| BROKER | broker with generate children | no generate step (4.18 behaviour) | none |
| OTHER_INPUT | `stdin` / no input | 4.18 behaviour | none |
| DOCS | multi-document YAML | only the same document's input counts | none |

</frozen-after-approval>

## Code Map

- `src/core/bloblangProcessors.ts`:
  - `previousSteps` (117-135), `bloblangProcessorByPath`, `stepTitle`, `processorsOnly`;
  - generate entries have path `input.generate` / `documents[i].input.generate` (story 22).
- `src/adapters/bloblangPanel/panels.ts`:
  - `seed()` (567+) builds the chain and runs each step through `runTest` with the step's kind;
  - `previousStepOf` (1604) feeds the snapshot's `previousStep`.
- `src/core/bloblangRun.ts` -- `testConfig('generate', …)` (story 16).
- Tests:
  - `src/test/core/bloblangProcessors.test.ts` (`previousSteps` cases from the matrix);
  - suite 90 (the From previous step tests from 4.18, fake binary);
  - the webview needs no change (the button name comes from `previousStep`).
- Docs:
  - `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` (AD-21, the From previous step line ~222);
  - `ux-rpcn-vscode-designer/EXPERIENCE.md`;
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `previousSteps` exception + unit tests.
- [x] `seed` / `previousStepOf` with the unfiltered list and the generate run.
- [x] Suite 90 matrix + pinned runs.
- [x] AD-21, EXPERIENCE, CHANGELOG.

**Acceptance Criteria:**
- Given the dev host with the real binary and a generate input feeding `processors[0]`, when the user presses From previous step in `processors[0]`'s panel, then a sample holding the generate output is saved, selected and run.
- Given the change, when `npm run compile`, `npm run test:webview`, `npm run test:corpus`, the full stable suite (alone) and 5 pinned runs of suite 90 run, then all pass.

## Implementation Notes

- `previousSteps` walks as before (a `generate` entry never sits at a list path, and one would end the walk); when the walk reaches index -1 of `[documents[i].]pipeline.processors`, `generateBefore` appends that document's `input.generate` entry if its mapping is non-empty and the entry has `feedsPipeline` (review iteration 0: set where the entry is built, from the parsed YAML, when the document's `input` map has no `broker` key and no non-empty `processors` of any kind).
- `seed()`: a `generate` step found while looking for the chain's start starts it with an empty input; `runTest` already ignores the input for a generate kind (story 16), so the run is `testConfig('generate', …)`. Failures reuse `previousDeleted` / `previousFailed` with `stepTitle` (label, else `input.generate`; `documents[i].input.generate` past the first document).
- `processorsOnly` is no longer imported by the panel (still used by the corpus parity and tests).
- AC1 (dev host with the real binary) is a manual check not run by the agent.

## Plan Change Log

## Review Triage Log

- Iteration 0, quick review: 1 medium, 5 low.
  - MEDIUM (patched): an input-level `processors` (any kind, e.g. `log`, which is not in the Bloblang list) runs between the generate input and `pipeline.processors[0]`; the generate step is no longer offered then. Detected from the parsed YAML (`feedsPipeline` on the generate entry).
  - LOW (patched): the broker check now reads the input map's `broker` key from the parsed YAML (a `generate` beside a broker with only `stdin` children is not offered); the unit case uses a `stdin` child.
  - LOW (patched): unit cases for `input.processors` with a Bloblang processor, with `log: {}`, an empty list, and generate beside a broker with `stdin`.
  - LOW (patched): suite 90 FAILS and BROKER assert one new message before reading `shown.at(-1)`; CHAIN asserts from the fake binary's captured config that `processors[0]`'s run got the generate output (content and metadata).
  - LOW (patched): AD-21, EXPERIENCE, CHANGELOG add "and no input-level `processors`"; EXPERIENCE says "not for the first item of a list, except below".
  - Accepted as is: a comment-only generate mapping is still offered.

## Verification

**Commands:**
- `npm run compile`; `npm run test:webview`; `npm run test:corpus`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone); `taskset -c 0,1 xvfb-run -a npx vscode-test --label stable --grep "Bloblang test panel \(integration"` ×5 -- expected: all pass.

**Results (2026-10-22, after review iteration 0):**
- `npm run compile`: clean. `npm run test:webview`: 311 passed. `npm run test:corpus`: 156 passed.
- Full stable suite, alone under `xvfb-run -a`: 874 passing, 0 failing.
- Suite 90 pinned to CPUs 0,1, alone, 5 runs in a row: 79 passing, 0 failing each.
- AC1 (dev host with the real binary, the user, 2026-10-22): From previous step on `processors[0]` saves the generate output as "from demo_gen" with `source = demo` metadata; the chain on `processors[1]`; a broken generate mapping saves nothing and names the step; input-level `processors` offer no step: no issues.
