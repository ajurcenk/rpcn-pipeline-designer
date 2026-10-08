# Fixture models (ticket 3.2)

Hand-written Redpanda Connect configs, each with the `PipelineModel` the core is expected to
build from it (`src/shared/protocol.ts`). Data only (YAML and JSON): the mocha tests read them
now, the model builder (3.3) and the vitest graph view tests (3.4) later, without VS Code. Every
YAML passes `redpanda-connect lint` except the deliberate duplicate label in `labels.yaml`.

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

Conventions:

- **Ranges (AD-16):** UTF-16 `[start, end)` from the node's key, or its `- ` item indicator, to
  the end of its value (trailing whitespace excluded). A route over a list item (a `switch`
  case) starts at its `- `; a route over a keyed value (`outputs:`, `try:`, a workflow branch)
  starts at the key. A child's range lies inside its parent's.
- **Path ids (AD-7):** `path:` then dotted map keys with `[i]` for sequence items
  (`path:pipeline.processors[0].switch[1]`). A key segment that is not `[A-Za-z0-9_-]+` is
  written as `["<key>"]` with JSON string escaping, so distinct YAML paths never share an id
  (`path:pipeline.processors[0].workflow.branches["a.b"]`). No fixture has such a key.
- **Edges:** `id` is `<source>-><target>`. The top level chains input, `pipeline.processors` and
  output in order; inside a group or route, a processor list is chained in order. Outputs in a
  broker or switch are not chained. Edges never cross into a group; the group node is the
  endpoint at its own level.
- **Optional fields** are absent rather than `undefined` or `false`.
