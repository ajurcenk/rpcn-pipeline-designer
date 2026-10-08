---
title: 'Completion for empty list items inside a component'
type: 'feature'
ticket: '18'
created: '2026-10-08'
status: 'built'
baseline_revision: 'e287d7ccf6767298f1331a7e54a69588b7262285'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-completion-where-red-hat-returns-none-plan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A new item in a processor list nested in a component (the user's `switch` case `processors:` then `- `, 2026-10-08) offered only VS Code's word suggestions. Neither Red Hat 1.24.0 nor the 2.16 gap provider answers there.

**Approach (user, 2026-10-08: "yes"; AD-11 amended to include list items):** the gap provider also answers on an empty or partly typed list item inside a component.
- For a list of components (nested `processors`, `outputs`, `inputs`, `batching.processors`), it offers the component names, with their summaries.
- For a list of objects (`switch` cases, `tls.client_certs`), it offers the item's fields.
- A component or object is inserted as `name:` plus a new line indented 4 columns past the dash's line; a list as `name:` plus `- `.
- It is silent where Red Hat answers (top-level `pipeline.processors: - `), and for lists of plain values (`topics`).

## Boundaries & Constraints

**Always:**
- **Where:** only inside a component (`insideComponent` on the item's path).
- **Fields:** deprecated fields are left out of item suggestions.
- **Snippets:** valid YAML at any depth.
- **Duplicate guard:** the 2.16 guard test covers the new positions.

**Never:**
- items where Red Hat answers;
- changes to the 2.16 / 2.17 behaviour.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| NESTED_PROCESSORS | `switch` case `processors:` then `- ` | all processor names; `log` inserts `log:` + an indented line | — |
| PARTIAL | `- lo` | the same list (VS Code filters to `log`) | — |
| BROKER | `broker.outputs:` then `- ` | output names | — |
| OBJECT_LIST | `switch:` then `- `; `tls.client_certs:` then `- ` | `check`, `continue`, `fallthrough`, `processors`; the cert fields | — |
| TOP | `pipeline.processors:` then `- ` | nothing (Red Hat) | — |
| SCALAR_LIST | `redpanda.topics:` then `- ` | nothing | — |

</frozen-after-approval>

## Implementation Notes

- **Core:**
  - `gapContext` recognises `^\s*-\s+<partial key>?$`. The item is found with `allItems` (list items with path and start), and the `yaml` library gives `- ` as a null scalar with a position.
  - `gapItems` handles the `item` kind after the inside-component guard.
  - `fieldSnippet(info, indent)` uses a child indent of 4 for items and 2 for blocks.
- **Red Hat server sweep** (the reviewer's LSP harness from 2.16, over 186 list positions: every array field of every input, output and processor, plus nested and top-level lists): 0 positions where both answer, 44 gaps that only we answer, 1 where only Red Hat answers (top-level `pipeline.processors`), 141 where neither answers (lists of plain values).
- **Tests:** core tests for every row; NO_DUPLICATES gains 3 list positions; SNIPPETS inserts `log` in a nested item.

## Review Triage Log

**Pass 1 (quick, inline by the parent, 2026-10-08):** I checked the diff, the sweep above (no overlap), and the snippet indentation in VS Code. No findings.

**Re-verification:** `npm test` 462 passing; `npm run test:corpus` 65 passed.
