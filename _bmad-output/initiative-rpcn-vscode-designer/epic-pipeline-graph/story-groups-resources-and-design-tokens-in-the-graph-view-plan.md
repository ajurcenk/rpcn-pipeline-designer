---
title: 'Groups, resources and design tokens in the graph view'
type: 'feature'
ticket: '4'
created: '2026-10-09'
status: 'built'
baseline_revision: '61d6c64c5a90eab0fc323cc29eddcbe327406937'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/DESIGN.md'
  - '{project-root}/src/test/fixtures/models/README.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The host now sends the nested model (3.3), but the view draws only its top-level nodes. Switch cases, brokers, `branch`, `try`/`catch`, `workflow` and the other groups are invisible, and their children are dropped.

**Approach:**
- Render the whole model as an ELK compound graph (`INCLUDE_CHILDREN`): groups are boxes with a header and their children inside, routes are captioned sub-boxes, and resources are standalone nodes.
- Groups start expanded and can be collapsed. Collapse is webview view state, kept across re-renders and in `setState` (AD-3).
- Colours come only from DESIGN tokens. Nothing is draggable. Pan and zoom work, without animation under reduced motion. Fit to view is kept.
- The pure model → ELK → node-props mapping moves to its own module, tested under vitest, which this entry sets up for webview tests.

**Decisions (agent defaults, reported at the checkpoint):**
- **Group box** (DESIGN `group-box`):
  - transparent, with a `{colors.group-border}` outline and `{rounded.md}`;
  - a header row with a chevron codicon (`chevron-down` / `chevron-right`), the component in `{typography.ui-muted}`, and its label when it has one;
  - children nested inside with `{spacing.3}` padding.
- **Route** (switch case, broker outputs, try/catch body, workflow branch): a sub-box inside its group with a dashed `{colors.group-border}` outline and its `caption` in `{typography.code}` at the top. An uncaptioned route has no header. DESIGN's assumed "edge label for a switch case" is shown as the route's caption; edges with a `label` still draw it.
- **Collapsed group:** drawn as a single node-sized box: header with `chevron-right`, plus a muted count such as "3 cases" or "4 processors". Its descendants and their edges are hidden. Edges into and out of the group stay attached to the box.
- **Resources:** standalone nodes with a `{typography.ui-muted}` "resource" role line, laid out as ELK's separate components (no edges).
- **Codicons:** add `@vscode/codicons` (pinned); bundle its CSS and font into `dist/` through esbuild's file loader; add it to NOTICE (CC-BY-4.0 icons, MIT code). The CSP already allows `font-src ${cspSource}`.
- **Vitest for webview tests:** a `webview/vitest.config.mts` (environment `node`, include `webview/**/*.test.ts`), an `npm run test:webview` script, and a CI step. The corpus config stays as it is.
- **Toggling:** clicking the header's chevron toggles collapse. Clicking the header label still posts `nodeActivated` for the group; the reveal of the whole block is entry 7. Keyboard (Space) is entry 11.

## Boundaries & Constraints

**Always:**
- **What the webview does (AD-3, AD-4):** it renders the latest model and holds only view state (collapse by node id, viewport). It never re-derives the model from text. Layout is ELK on the main thread, with `elk.bundled.js` and no worker.
- **Read-only:** nothing is draggable, connectable or editable. A click on a node still posts `nodeActivated {via: 'click'}`.
- **Colours:** every colour in `webview/src/*.css` is a `var(--vscode-…)` theme variable, with no hex, rgb or named colours (DESIGN). High contrast keeps `contrastBorder` outlines.
- **Stable collapse:** collapse state survives a new model for every group id still present. Ids that are gone are dropped.
- **Green:** `npm test` (stable and 1.100.0), `npm run test:corpus`, `npm run test:webview` and CI pass. The `.vsix` carries the codicon font and CSS.

**Never:**
- host changes, or new messages;
- live updates (3.6);
- selection highlight (3.7);
- node status (3.8);
- empty states (3.9);
- keyboard navigation (3.11);
- drag or edit;
- a layout worker.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FIXTURES | every fixture model | an ELK graph whose hierarchy equals the model's `parent` tree; every node and edge present; groups and routes are ELK compound nodes | — |
| SWITCH | `switch-processor` | one group box, a captioned route per case, each case's processors chained inside it | — |
| COLLAPSE | `nested` with the branch collapsed | the branch is one leaf box with its count; its descendants and their edges are absent; edges to the branch are kept | — |
| COLLAPSE_KEPT | collapse a group, then a new model with the same id | still collapsed | — |
| COLLAPSE_GONE | collapse a group, then a model without it | its state is dropped | — |
| RESOURCES | `resources` | standalone resource nodes with no edges | — |
| PROPS | any fixture | every xyflow node has `draggable: false` and `connectable: false`; children carry `parentId` and appear after their parent | — |
| TOKENS | `webview/src/*.css` | no hex, `rgb(`, `hsl(` or named colour outside `var(--vscode-…)` | — |
| REDUCED_MOTION | `prefers-reduced-motion: reduce` | fit view and zoom use duration 0 | — |
| PACKAGE | `vsce package` | `dist/` holds the codicon font and CSS | — |

</frozen-after-approval>

## Code Map

- `webview/src/Graph.tsx` (139 lines):
  - `layout(model)` builds a flat ELK graph;
  - `drawnPart(model)` (3.3) keeps only the top-level nodes (remove it);
  - `nodeWidth`, `fitReadable` (the min-zoom fit from 3.1) and `ComponentView` (the node renderer);
  - `ReactFlow` props.
- `webview/src/main.tsx`: the message handling with `parseHostMessage`, and `App`. `webview/src/graph.css` holds the node styles, all `var(--vscode-…)`. `webview/src/host.ts` wraps `acquireVsCodeApi` and is the place for `getState`/`setState`.
- **Model types:** `src/shared/protocol.ts`, `PipelineNode {id, role, component?, label?, caption?, range, parent?, group?, duplicateLabel?}` and `PipelineEdge {id, source, target, label?}`.
- **Fixtures:** `src/test/fixtures/models/*.model.json` (16), with conventions in their README. Vitest can read them with `fs` (plain JSON).
- **@xyflow/react sub-flows:** a child node has `parentId`, a position relative to its parent and `extent: 'parent'`, and must come after its parent in the array. ELK returns child coordinates relative to the parent, which matches.
- **ELK compound layout:**
  - nest `children` per the `parent` tree;
  - set `elk.hierarchyHandling: INCLUDE_CHILDREN` at the root;
  - give each group padding for its header (for example `[top=32,left=12,bottom=12,right=12]`);
  - give a collapsed group a fixed size and no children.
- **Build and packaging:**
  - `@vscode/codicons` is pinned to `0.0.46-24`, the architecture Stack version, which exists on npm (prerelease line; newer `-4x` builds exist).
  - `esbuild.js`: the webview context already bundles CSS to `dist/webview.css`; add `loader: {'.ttf': 'file'}` (or `copy`) so the codicon font lands in `dist/`.
  - The webview HTML's `localResourceRoots` already covers `dist/`.
  - The `vitest.config.mts` at the root includes only `test/corpus/**`; leave it.
  - `.github/workflows/ci.yml` runs `npm run test:corpus`; add `npm run test:webview` beside it.
  - NOTICE entry format: see its existing entries.
- **DESIGN tokens:**
  - `colors.group-border` is `var(--vscode-panel-border)` and `colors.edge` is `var(--vscode-editorLineNumber-foreground)`;
  - `rounded.md`, `spacing.3` and the typography `ui` / `ui-muted` / `code` tokens are in the DESIGN.md frontmatter (L12–90);
  - group-box rules at L82–87 and L148.

## Tasks & Acceptance

**Execution:**
- [x] `webview/src/layout.ts` (new, pure): turn the model and collapse state into the ELK graph, and the ELK result into xyflow nodes and edges, with `nodeWidth`, sizes and the collapsed-group count. This is the testable core.
- [x] `webview/src/Graph.tsx`, `webview/src/nodes.tsx` (new): component, group and route renderers with codicons; the chevron toggles collapse; collapse state in React plus `host.setState`; fit and reduced motion; remove `drawnPart`. Rendering.
- [x] `webview/src/graph.css`: group, route, header and resource styles, all as theme variables. DESIGN tokens.
- [x] `package.json`, `package-lock.json`, `esbuild.js`, `NOTICE`, `.github/workflows/ci.yml`, `webview/vitest.config.mts`: codicons, the font loader, the `test:webview` script and CI step. Setup.
- [x] `webview/src/layout.test.ts`, `webview/src/style.test.ts`: FIXTURES, SWITCH, COLLAPSE, COLLAPSE_KEPT, COLLAPSE_GONE, RESOURCES, PROPS, TOKENS, REDUCED_MOTION (the motion decision as a pure function). The matrix.
- [x] `README.md`, `CHANGELOG.md`. Docs.

**Acceptance Criteria:**
- Given `graph-demo.yaml` (stateful_polling) in the dev host, when Show graph runs, then `catch` and the broker output are boxes holding their children, the cache resources stand alone, and a click on any node still selects its YAML.
- Given a collapsed group, when the file's graph is re-sent (Show graph again), then it is still collapsed.

## Implementation Notes

- `layout.ts` puts each ELK edge in the deepest node containing both ends; groups and routes get `elk.padding` plus `nodeSize.minimum` so the header fits. Node types are `component`, `groupBox` and `route`, never xyflow's built-ins (`group` brings its own padding, border and tint).
- The main flow is laid out without the top-level resources; they are then placed in one row below it.
- Collapsed count: `switch` -> "N cases", `workflow` -> "N branches"; otherwise the components held directly or through routes, named by role when they share one ("4 processors", "2 outputs"), else "N components".
- A labelled node's first line is `role · label`; only the role is capitalised.
- The codicon CSS is bundled into `dist/webview.css`; the font is emitted as `dist/codicon.ttf` (`assetNames: '[name]'`).
- Webview test files run in Node: `webview/tsconfig.json` excludes `*.test.ts`, `webview/tsconfig.test.json` (in `check-types`) checks them with Node types, and an ESLint block lets `webview/**/*.test.ts` import Node built-ins while keeping every other webview/ rule.
- Only collapse state goes to `setState`; the viewport is not saved.
- Fit runs once, on the first layout, instantly as before; collapsing does not refit. Nothing animates, so `motionDuration` stays a tested helper for later zoom controls.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, by a fresh subagent; 2026-10-09):** 5 findings: 1 medium and 4 low, all patched. No intent_gap or bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The group node type is named `group`, so xyflow's `.react-flow__node-group` styles (`@xyflow/react/dist/style.css` L457–466: 10px padding, 12px font, a hard-coded border and a tint) apply to every group | medium | patch | Checked in the stylesheet and `nodes.tsx` L79. The type is renamed; a test rejects xyflow's built-in type names. |
| 2 | `text-transform: capitalize` re-capitalises user labels in the `role · label` line | low | patch | Only the role is capitalised. |
| 3 | Route captions and node names lack `font-size: var(--vscode-editor-font-size)` (half of `{typography.code}`) | low | patch | Size added. |
| 4 | Resources are packed around the main flow, not in DESIGN's "separate area outside the main flow" | low | patch | Resources are laid out in a row below the main flow; a layout test checks it. |
| 5 | The first fit now animates (200 ms), which the plan did not ask for | low | patch | The initial fit is instant. |

## Verification

**Re-verification after the review patches (parent, 2026-10-09):** `npm run compile` clean; `npm run test:webview` 47 passed; `npm test` 572 passing on stable and 1.100.0; `npm run test:corpus` 89 passed; the `.vsix` holds `dist/codicon.ttf`, `webview.css` and `webview.js`. Manual check pending (the user).

**Commands:**
- `npm run compile`: exit 0.
- `npm run test:webview`: all pass.
- `npm test`: all pass on stable and 1.100.0.
- `npm run test:corpus`: 89 passed.
- `npx vsce package --no-dependencies` plus `unzip -l`: the codicon font and CSS are in `extension/dist/`.

**Manual checks:**
- In the dev host on `graph-demo.yaml` and on a `switch` fixture: groups and routes look like the editor-and-graph mockup, a chevron collapses and expands, and light, dark and high-contrast themes all render.
