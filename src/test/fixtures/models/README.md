# Fixture models (ticket 3.2)

Hand-written Redpanda Connect configs, each with the `PipelineModel` the core is expected to
build from it (`src/shared/protocol.ts`). Data only (YAML and JSON): the mocha tests read them,
and the model builder (`src/core/graph.ts`, 3.3) must reproduce every model exactly with the
catalogue of the 4.100.0 and of the 4.112.0 schema; the vitest graph view tests (3.4) use them
later, without VS Code. Every YAML passes `redpanda-connect lint` except the deliberate duplicate
label in `labels.yaml`.

| Fixture | Covers |
| --- | --- |
| `flat` | The tracer's shape: input, two processors, output, chained by edges. |
| `labels` | `label:` ids for labelled input, processor and output; an unlabelled processor keeps its `path:` id; a repeated label gets its `path:` id and `duplicateLabel: true`. |
| `switch-processor` | A `switch` processor group with two case routes holding processor chains; captions are the `check` excerpt, or `case <i>` when a case has no `check`. |
| `switch-output` | A `switch` output group; each case route holds the case's `output` (`path:output.switch.cases[i].output`); a long `check` is cut to 32 characters ending in `…`. |
| `broker-output` | A `broker` output group with one route, its `outputs` list (caption: the `pattern`), holding the outputs; no edges between them. |
| `branch` | A `branch` processor group whose `processors` are its direct children, chained. |
| `try-catch` | `try` and `catch` groups, each with one uncaptioned body route (the `try:` / `catch:` pair) holding a processor chain. |
| `workflow` | A `workflow` group with one route per branch (caption: the branch name) and edges between branch routes from `order`. |
| `nested` | A `switch` group inside a `branch` group. |
| `resources` | `processor_resources` and `cache_resources` as top-level `resource` nodes (`res:processor:<label>`, `res:cache:<label>`), with no edges; a `resource:` processor in the chain. |
| `fallback` | A `fallback` output group with one uncaptioned route over its own value (the `fallback:` pair) holding the outputs; no edges between them. |
| `retry` | A `retry` processor group whose `processors` are direct children, chained, and a `retry` output group whose `output` is its direct child. |
| `while` | A `while` processor group whose `processors` are direct children, chained. |
| `parallel` | A `parallel` processor group whose `processors` are direct children, chained. |
| `shared-processors` | An input's and an output's own `processors` join the top-level chain where they run: input -> its processors -> `pipeline.processors` -> the output's processors -> output. |
| `batching` | An output whose `batching.processors` make it a group with those processors as direct children, chained. |

Conventions:

- **Ranges (AD-16):** UTF-16 `[start, end)` from the node's key, or its `- ` item indicator, to
  the end of its value (trailing whitespace excluded). A route over a list item (a `switch`
  case) starts at its `- `; a route over a keyed value (`outputs:`, `try:`, a workflow branch)
  starts at the key. A child's range lies inside its parent's.
- **Path ids (AD-7):** `path:` then dotted map keys with `[i]` for sequence items
  (`path:pipeline.processors[0].switch[1]`). A key segment that is not `[A-Za-z0-9_-]+` is
  written as `["<key>"]` with JSON string escaping, so distinct YAML paths never share an id
  (`path:pipeline.processors[0].workflow.branches["a.b"]`). No fixture has such a key (the graph
  core tests cover it).
- **Nodes** are in document pre-order: a group, then its routes and children in the order they
  appear in the YAML. A component is a group when at least one of its child slots (from the
  schema's catalogue) is present in the YAML.
- **Edges:** `id` is `<source>-><target>`. The top level chains input, the input's own
  `processors`, `pipeline.processors`, the output's own `processors` and output in order;
  inside a group or route, a processor list is chained in order. Inputs and outputs in a list
  (broker, switch, fallback) are not chained. Edges never cross into a group; the group node is
  the endpoint at its own level. The top-level chain comes first, then each nested list in the
  order it starts in the YAML.
- **Workflow edges:** a `workflow`'s `order` gives an edge from every branch route in stage k to
  every other branch route in stage k + 1. These edges are listed at the point where the
  `workflow` starts in the YAML (like a nested list), so after the chain it sits in and before
  its branches' own processor chains. A `workflow` with no
  `order` gets no edges between its branches: the order the runtime infers from the branches'
  `request_map` / `result_map` is not derived.
- **Optional fields** are absent rather than `undefined` or `false`.
