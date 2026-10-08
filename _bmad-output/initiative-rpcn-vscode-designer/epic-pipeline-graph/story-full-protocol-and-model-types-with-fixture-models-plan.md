---
title: 'Full protocol and model types with fixture models'
type: 'feature'
ticket: '2'
created: '2026-10-08'
status: 'built'
baseline_revision: '616ab491267267a8b772a7a1167517c7114a956d'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The tracer's protocol has three messages and a flat model with simplified ids. The graph view (3.4), the model builder (3.3) and the host features (3.6–3.10) all need the full contract first, and the view lane needs real models to render before the builder exists.

**Approach:** Complete `src/shared/protocol.ts` with the whole AD-5 message union and the full `PipelineModel` (nested groups, routes, resources, edges with labels, AD-7 ids, AD-16 ranges), with pure validators for each direction. Add hand-written fixture models (YAML plus the expected model) in `src/test/fixtures/models/`. Move the tracer to the new types and AD-7 ids with no visible change.

**Decisions (agent defaults, reported at the checkpoint):**
- **Model shape:** one flat list of nodes with `parent` pointers, plus edges. This is ELK-friendly, and `nodeAt` is just a walk.
  - `PipelineNode` = `{ id, role, component?, label?, caption?, range, parent?, group?, duplicateLabel? }`.
  - `role` is one of `input`, `processor`, `output`, `resource`, `route`.
  - A group is a component node with `group: true` whose children name it as `parent`, for example a `switch` processor, a broker output, a `branch`.
  - A `route` is a group-internal container with no component: a `switch` case, a broker's output list, a `try` or `catch` body. Its `caption` is shown, for example `case 0` or an excerpt of the case's `check`.
  - `PipelineEdge` = `{ id, source, target, label? }`.
  - `PipelineModel` = `{ nodes, edges }`. Groups are nodes, which satisfies AD-4's "nodes, edges, groups" without a second list.
- **Ids (AD-7):** `label:<label>` for a labelled component; `res:<kind>:<label>` for a resource; `path:<yamlPath>` otherwise (`path:pipeline.processors[2]`, `path:output.switch.cases[0].output`). A duplicate label keeps the label id for its first occurrence; later occurrences get their path id and `duplicateLabel: true`.
- **Messages:**
  - **Host to webview:**
    - `snapshot` = the complete current state `{ model | null, parseError?, nodeStatus, selection, hostStatus }`, answering `ready`;
    - `model {model}`;
    - `parseError {message, range}`;
    - `nodeStatus {byId: Record<id, {severity: 'error' | 'warning', messages: string[]}>}`;
    - `selection {nodeId | null}`;
    - `hostStatus {binary: 'ok' | 'missing' | 'invalid' | 'unresolved', schema: 'ok' | 'loading' | 'none'}`.
  - **Webview to host:** `ready`; `nodeActivated {nodeId, via: 'click' | 'keyboard'}`; `bannerClicked`; `installGuideRequested`; `setPathRequested`; `retryRequested` (the epic's Retry decision).
- **Validation:** `parseWebviewMessage(unknown)` and `parseHostMessage(unknown)` live in `protocol.ts`. They are pure: they return the typed message, or `undefined` for anything malformed. The host and the webview both use them, and the host's own validator goes away.
- **Fixtures:**
  - **Files:** `src/test/fixtures/models/<name>.yaml` plus `<name>.model.json`, the expected model.
  - **Ranges:** worked out by hand from AD-16 and checked by a test: each range's text starts with the node's key, or with `- ` for an item, and ends at the value's end.
  - **Set:**
    - `flat` (the tracer's shape);
    - `labels` (labelled components and a duplicate label);
    - `switch-processor` (cases with processor chains);
    - `switch-output` (cases with outputs, `check` captions);
    - `broker-output`;
    - `branch`;
    - `try-catch`;
    - `workflow`;
    - `nested` (a `switch` inside a `branch`);
    - `resources` (`processor_resources`, `cache_resources`).

## Boundaries & Constraints

**Always:**
- **Protocol (AD-5, AD-15):** `protocol.ts` imports nothing and is the only place a message or model type is defined. Both the host and `webview/` import it.
- **Model (AD-4, AD-16):** no coordinates or sizes in the model; ranges are UTF-16 `[start, end)`.
- **The tracer keeps working:**
  - `src/core/graph.ts` emits the new node shape with AD-7 ids for its flat chain;
  - the panel, the view and the tests move to the new types;
  - what the user sees is unchanged;
  - `npm test` (stable and 1.100.0), `npm run test:corpus` and CI stay green.
- **Fixtures:** they are data only (YAML and JSON), readable both by the mocha tests and later by vitest (3.4) without VS Code.

**Never:**
- building the nested model from YAML (3.3);
- rendering groups (3.4);
- sending `model`, `parseError`, `nodeStatus`, `selection` or `hostStatus` from the host (3.6–3.9);
- a component catalogue;
- new dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HOST_SHAPES | each host message, built from a typed object | `parseHostMessage` returns it unchanged | — |
| WEBVIEW_SHAPES | each webview message, including `via: 'keyboard'` and `retryRequested` | `parseWebviewMessage` returns it | — |
| MALFORMED | missing fields, wrong types, an unknown `type`, `null`, a string | `undefined` | never throws |
| FIXTURES_TYPED | every `*.model.json` | type-checks as `PipelineModel` (a typed import), and every `parent` and edge endpoint names an existing node | — |
| FIXTURE_RANGES | every node in every fixture | `yaml.slice(range)` starts with its key, or with `- `, and ends at its value's end | — |
| AD7_IDS | `labels` fixture | the labelled components get `label:` ids; the duplicate gets a `path:` id and `duplicateLabel: true` | — |
| TRACER | `stateful_polling.yaml` through `buildPipelineModel` | the same chain as before, now with `path:` ids and the new shape; Show graph and click still work | — |

</frozen-after-approval>

## Code Map

- **`src/shared/protocol.ts`** (41 lines): the flat `PipelineNode {id, kind, name, range}`, `PipelineEdge`, `PipelineModel`, three messages, `EMPTY_MODEL`; `src/shared/index.ts` re-exports it.
- **Importers to move to the new shape:**
  - `src/core/graph.ts` (ids `input:<name>` / `processor:<i>:<name>` / `output:<name>`; `componentName`, `pairRange`, `itemStart`, `valueEnd`; it already produces AD-16 ranges);
  - `src/adapters/graphPanel/panels.ts`: `asWebviewMessage` gives way to `parseWebviewMessage`; it posts `snapshot {model}`, so it becomes the full snapshot with null or empty fields;
  - `webview/src/main.tsx` and `webview/src/Graph.tsx`: they use `node.kind` / `node.name` and accept only `snapshot`;
  - `webview/src/host.ts`;
  - `src/test/core/graph.test.ts`;
  - `src/test/integration/suites/80-graph.ts`: it asserts the ids and the snapshot.
- **AD-7 path form:** dotted keys with `[i]` for sequence items, for example `pipeline.processors[2]` or `output.switch.cases[0].output`. A labelled component is `label:<label>`; a resource is `res:<kind>:<label>`, where `<kind>` is the resource category such as `processor` or `cache`.
- **Corpus YAML to adapt for the fixtures:** `test/corpus/*.yaml` (for example `stateful_polling.yaml`, `joining_streams.yaml`, `resources.yaml`). The fixtures themselves are small and hand-written.
- **Unit tests:** mocha suites under `src/test/{core,adapters,shared}`. `src/shared` has no tests yet; add `src/test/shared/protocol.test.ts`.
- **Lint:** the AD-15 rule forbids imports in `src/shared` that climb out of it (`eslint.config.mjs` `sharedBlocks`). The webview may import only `src/shared`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/protocol.ts`: the full model, the message unions, the snapshot, `parseHostMessage` and `parseWebviewMessage`. AD-5 is the contract.
- [x] `src/test/fixtures/models/`: the 10 YAML plus `*.model.json` pairs, with a README listing each fixture and what it covers. Shared input for 3.3 and 3.4.
- [x] `src/test/shared/protocol.test.ts`: HOST_SHAPES, WEBVIEW_SHAPES, MALFORMED, FIXTURES_TYPED, FIXTURE_RANGES, AD7_IDS. Pins the contract.
- [x] `src/core/graph.ts`, `src/adapters/graphPanel/panels.ts`, `webview/src/*`, `src/test/core/graph.test.ts`, `src/test/integration/suites/80-graph.ts`: move to the new types and AD-7 ids (TRACER). No visible change.

**Acceptance Criteria:**
- Given the webview posts `{type: 'nodeActivated', nodeId, via: 'keyboard'}`, then the host accepts it and selects the node, as for a click.
- Given any fixture model, then every `parent` and edge endpoint names a node in the same model, and every range slices to its own YAML.

## Implementation Notes

- **FIXTURES_TYPED without a typed JSON import:** a TypeScript JSON import widens string literals (`role: string`), so it cannot type-check against the `PipelineNode['role']` union. The test reads each `*.model.json` and narrows it with the exported `isPipelineModel` guard (the same check `parseHostMessage` uses for `model`), then checks ids, parents and edge endpoints.
- **Fixture conventions** (documented in `src/test/fixtures/models/README.md`, for 3.3 to build to): routes over a list item (`switch` cases) start at `- `, routes over a keyed value (broker `outputs:`, `try:` / `catch:`, workflow branches) start at the key; `branch` children are direct children (no route), as the plan's group example reads; captions are the `check` cut to 32 characters with `…`, else `case <i>`; the broker route's caption is its `pattern`, a workflow branch route's is its name; `try`/`catch` body routes have no caption. Edges chain processor lists at each level and never cross into a group; workflow branch routes get edges from `order`. No fixture uses an edge `label` (the protocol test covers it).
- **Tracer ids:** the flat builder applies AD-7 in full for its chain, so a labelled top-level component gets `label:<label>` (and a repeat `path:` + `duplicateLabel`); it reproduces the `flat` and `labels` fixtures exactly (checked in `graph.test.ts`).
- **Snapshot:** the panel sends `nodeStatus: {}`, `selection: null`, `hostStatus: {binary: 'unresolved', schema: 'none'}` until 3.6-3.9; the model is still the empty model (not `null`) for an unparseable file, as before.
- **Webview:** validates with `parseHostMessage` and renders `snapshot` or `model`; it shows `role` and `component` (or a route's `caption`) where it showed `kind` and `name`. It still posts only `via: 'click'` (keyboard activation is 3.4).

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, by a fresh subagent; 2026-10-08):** 4 findings. 2 low patched, 1 low rejected, 1 rejected (plan edit). No intent_gap or bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `labelOf` drops a label YAML reads as a number or boolean (`label: 123`) | low | patch | Redpanda Connect reads it as the string "123" (AD-7 `label:<label>`). The scalar's source text is used; unit test. |
| 2 | The `path:` id convention has no rule for keys containing `.`, `[`, `]`, so two paths could share an id | low | patch | The README gains the `["<key>"]` rule with JSON escaping; 3.3 builds to it. |
| 3 | A `snapshot` with `model: null` blanks the graph instead of keeping the last valid model (AD-6) | low | reject | A snapshot only answers `ready` from a freshly created webview (`retainContextWhenHidden` is off), which has no earlier model. Parse errors arrive as `parseError` messages in 3.6, and that path keeps the last model. |
| 4 | FIXTURES_TYPED is checked at runtime (`isPipelineModel`), not as a typed JSON import, with no Plan Change Log entry | reject | reject | The fix would edit this build's plan. The deviation is recorded in Implementation Notes and reported to the user: a JSON import widens `role` to `string`, so a typed import cannot check the union; the runtime check is at least as strong. |

## Verification

**Re-verification after the review patches (parent, 2026-10-08):** see the commit; `npm run compile` clean, `npm test` and `npm run test:corpus` green: 552 passing on stable and 1.100.0, corpus 89. The manual Show graph check on `graph-demo.yaml` is pending (the user).

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass on stable and 1.100.0.
- `npm run test:corpus`: 89 passed.

**Manual checks:**
- Show graph on `.dev-host/workspace/graph-demo.yaml` still draws the chain, and a click still selects the YAML.
