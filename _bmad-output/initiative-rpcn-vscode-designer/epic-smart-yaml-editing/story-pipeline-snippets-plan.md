---
title: 'Pipeline snippets'
type: 'feature'
ticket: '10'
created: '2026-10-08'
status: done
baseline_revision: 'acb91aa7bdf50b527d2370b884007d9f0ecc2842'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/spec-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Newcomers have to recall the exact structure of a config and its common components (CAP-5, E2 R7; EXPERIENCE Flow 3).

**Approach (user, 2026-10-08: "buid 2.10"):** hand-written snippets, offered through our completion provider. A `package.json` snippet would appear in every YAML file (the ticket's open question). They are offered only where they fit:
- **top level:** a whole pipeline, or the `input` / `pipeline` / `output` sections the file lacks;
- **under `input:`:** `generate`, `redpanda`;
- **under `output:`:** `redpanda`, `stdout`;
- **on any `processors:` list item** (nested too): `mapping`, `switch`, `branch`, `log`.

**Decisions (the agent's, reported to the user):**
- **`redpanda` instead of `kafka_franz`:** lint with 4.112.0 marks the `kafka_franz` input deprecated, so it would not lint clean with `--deprecated`.
- **Blank files:** the whole-pipeline starter is also offered in a completely blank YAML file (not yet detected), where Flow 3 starts. Everything else is offered only in detected files.

## Boundaries & Constraints

**Always:**
- **Lint-clean:** every snippet, inserted with its placeholder defaults the way VS Code indents it, lints clean with both pinned binaries and `--deprecated` (corpus harness).
- **Labels:** items carry the "snippet" description, so they never share a label with Red Hat's component names.

**Never:**
- snippets in non-Redpanda Connect YAML (except the starter in a blank file);
- `package.json` snippets.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| BLANK | an empty YAML file | the whole-pipeline starter | — |
| ROOT | a file with `input` | pipeline and output sections only | — |
| INPUT / OUTPUT | an empty `input:` / `output:` | generate, redpanda / redpanda, stdout | — |
| PROCESSOR | a `- ` item in any `processors:` (switch case, batching, …) | mapping, switch, branch, log | — |
| OTHER_YAML | a Kubernetes manifest | none | — |
| LINT | each snippet in a full config, 4.100.0 and 4.112.0 | exit 0 with `--deprecated` | — |

</frozen-after-approval>

## Implementation Notes

- **Core:** `src/core/snippets.ts` holds `PIPELINE_SNIPPETS` (bodies relative to the cursor line), `snippetSlotOf`, `snippetsFor` and `renderSnippet`.
  - `src/core/gapCompletion.ts` gains `slotAt` (any depth, including the top level), and `gapContext` is now that slot filtered (2.16 behaviour unchanged).
  - `topLevelKeys` lives in `yamlPath.ts`. The AD-2 lint rule caught a first version that imported `yaml` in the adapter.
- **Provider:** `src/adapters/vscode/snippets.ts`. Items have kind Snippet, the label description "snippet", a filter text of prefix plus label, the rendered body as docs, and sort after the other items.
- **Harness:** `test/corpus/corpus.test.ts` lints all 12 snippets × 2 versions (24 tests, 89 in total).
- **Duplicate guard:** the 2.16 guard now leaves our snippet items out of the comparison, since they are ours and carry their own labels.

## Review Triage Log

**Pass 1 (quick, inline by the parent, 2026-10-08):** I checked the diff, the real-binary lint of every snippet, the insertion indentation in VS Code (nested `switch`), and the 2.16 guard adjustment. No findings.

**Re-verification:** `npm test` 508 passing; `npm run test:corpus` 89 passed.
