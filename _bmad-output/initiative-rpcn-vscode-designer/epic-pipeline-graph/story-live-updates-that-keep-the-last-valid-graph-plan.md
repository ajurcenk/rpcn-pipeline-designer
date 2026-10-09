---
title: 'Live updates that keep the last valid graph'
type: 'feature'
ticket: '6'
created: '2026-10-09'
status: 'built'
baseline_revision: '67c55cdf8916f729e9c8865e7dab1bef00c2f305'
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

**Problem:** The graph is built only when the webview says `ready`, so it goes stale as soon as the YAML changes. And while the YAML does not parse, the builder returns an empty model with no reason, so a half-typed edit would blank the graph.

**Approach (AD-6, R7):**
- On every change to a document that has an open graph panel, the host re-parses (through the shared parse cache) and sends the complete `model`.
- If the document does not parse, the host sends only `parseError {message, range}`. The webview then keeps the last valid graph and shows the banner "YAML has errors — showing last valid graph.". A click on the banner sends `bannerClicked`, and the host selects the error range in the file's editor.
- The next valid change sends a `model` again, which clears the banner.
- A first open on a broken file shows the banner over an empty canvas.
- The per-keystroke cost (build plus layout) on the largest corpus config is measured and recorded.

**Decisions (agent defaults, reported at the checkpoint):**
- **Parse error:** a new pure `parseErrorOf(parsed)` in `src/core` returns the first YAML error of the first document as `{message, range}` (UTF-16 offsets from the `yaml` error's `pos`), or `undefined`. This is the same document the builder reads.
- **The snapshot:** it carries `parseError` whenever the current text is broken, so a webview recreated while the YAML is broken shows the banner at once (with `model: null` when no valid model was ever built for this panel).
- **No debounce:** an update is sent on every change, as specified (epic decision). A debounce becomes a story only if the measurement shows a problem.
- **Banner** (DESIGN `invalid-yaml-banner`): a full-width strip at the top of the panel, with banner tokens and `codicon-warning`, `role="status"`. It is clickable and cannot be dismissed. Its text is the EXPERIENCE string, followed by the parser message in muted text.
- **Viewport:** a model update never refits. The user's pan and zoom stay; only the first model of a panel fits to view (3.1).
- **Stable positions (user, 2026-10-09, "use recommendations", (a)):** "unchanged nodes keep their position" means the layout is deterministic. The same model gives the same positions, so an edit that does not change the model (whitespace, a comment, a field value) moves nothing. A structural edit re-lays out everything, but the viewport and collapse state are kept. No ELK position hints.
- **What updates:** only documents with an open panel. Closing the panel stops its updates. Node status freezing while the banner shows is 3.8, and selection is 3.7.

## Boundaries & Constraints

**Always:**
- **Complete models (AD-6):** the host sends the complete model, never a diff. The webview renders the latest model it got and holds only view state (AD-3). Collapse state survives updates (3.4).
- **Purity:** `parseErrorOf` is pure core and never throws. The host reads the parse from `parsedDocument(doc)`, so there is one parse per document version.
- **Messages:** only those already in `src/shared/protocol.ts` (`model`, `parseError`, `bannerClicked`, `snapshot`). No new message types.
- **No edits:** the banner click selects and reveals the error range (the parser's position to the end of its line when the parser gives no end) and never edits the text (AD-19).
- **Green:** `npm test` (stable and 1.100.0), `npm run test:webview`, `npm run test:corpus` and CI pass.

**Never:**
- debouncing or throttling;
- a diff protocol;
- updates for documents without a panel;
- selection, cursor sync or node status (3.7, 3.8);
- the no-binary empty state (3.9);
- reloading the webview to apply a change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| EDIT | a valid edit (add a processor) | one `model` with the new node | — |
| BREAK | an edit that makes the YAML unparseable | one `parseError {message, range}` and no `model` | — |
| HEAL | a valid edit after BREAK | a `model`; the banner is gone | — |
| KEEP | the webview after BREAK | still shows the last valid graph, with the banner | — |
| FIRST_BROKEN | Show graph on a file that does not parse | a snapshot with `model: null` and `parseError`; the banner over an empty canvas | — |
| RECREATED | the panel hidden and shown while broken | the snapshot carries the last valid model and the `parseError` | — |
| BANNER_CLICK | `bannerClicked` | the error range is selected in the file's editor | ignored when there is no error |
| OTHER_DOC | an edit to a file without a panel | nothing is posted | — |
| CLOSED | an edit after the panel was closed | nothing is posted; no error | — |
| PARSE_ERROR_OF | valid text / a bad indent / an unclosed flow map / a multi-document file with an error in the second document | `undefined` / the error with its offset / the same / `undefined` (only the first document is read) | never throws |
| STABLE | the same model sent twice, and a model after a whitespace-only edit | identical node positions from the layout | — |
| COST | the largest corpus config | build and ELK layout times recorded in the plan | — |

</frozen-after-approval>

## Code Map

- **`src/adapters/graphPanel/panels.ts`** (203 lines):
  - `GraphPanel.receive` (L53) answers `ready` with a `snapshot` (L57) and handles `nodeActivated`;
  - `post` (L76) records to `posted` (the test seam);
  - `document()` (L81) and `model()` (L87) use `parsedDocument` and the catalogue;
  - `activate` (L96) selects and reveals a range (reuse it for the banner click);
  - `GraphPanels` (L137) keeps the registry and wires `onDidDispose` (L173);
  - subscribe to `vscode.workspace.onDidChangeTextDocument` once in `GraphPanels`, and route each change to the panel for that URI.
- **Core:**
  - `src/core/yamlPath.ts` `parseYaml` → `ParsedYaml {docs, lineCounter, length}`; `doc.errors` holds `YAMLParseError` with `pos: [start, end]` and `message`;
  - `src/core/graph.ts` `buildPipelineModel` returns `EMPTY_MODEL` when `docs[0].errors.length > 0`;
  - `src/adapters/vscode/parseCache.ts` `parsedDocument(doc)` gives one parse per version.
- **Protocol (`src/shared/protocol.ts`):** `HostMessage` already has `model`, `parseError {message, range}` and `snapshot {model | null, parseError?, …}`, and `WebviewMessage` has `bannerClicked`; `parseHostMessage` and `parseWebviewMessage` validate them.
- **Webview:**
  - `webview/src/main.tsx` (33 lines) accepts `snapshot` and `model` (`setModel`); add `parseError` state and the banner;
  - `webview/src/Graph.tsx` (76 lines) fits on first layout (`fitReadable`); keep the viewport on later models;
  - `webview/src/layout.ts` is pure (vitest);
  - `webview/src/graph.css` holds theme-variable styles (the TOKENS test scans it).
- **DESIGN:** the banner tokens are in the frontmatter (`invalid-yaml-banner`: `{colors.banner-surface}`, `{colors.banner-border}`; L90–92). The EXPERIENCE string is "YAML has errors — showing last valid graph.".
- **Tests:**
  - `src/test/integration/suites/80-graph.ts` drives the host seam (`panelFor(uri).posted`, `receive`), with an `open()` helper and the fake 4.112.0 binary;
  - `src/test/core/` (mocha) is where `parseErrorOf` tests go;
  - `webview/src/*.test.ts` run under vitest (node); put the banner and keep-last logic in a pure reducer there.
  - The largest corpus config: measure with `wc -c test/corpus/*.yaml`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/parseError.ts` (or in `yamlPath.ts`): `parseErrorOf(parsed)`. PARSE_ERROR_OF.
- [x] `src/adapters/graphPanel/panels.ts`: document-change routing, `model` / `parseError`, `bannerClicked` → select, and the snapshot fields. Host behaviour.
- [x] `webview/src/state.ts` (new, pure) plus `main.tsx`, `Graph.tsx`, `graph.css`: a reducer that keeps the last model and the error, the banner, and no refit on update. View behaviour.
- [x] Tests:
  - `src/test/core/parseError.test.ts`;
  - `src/test/integration/suites/80-graph.ts` (EDIT, BREAK, HEAL, FIRST_BROKEN, RECREATED, BANNER_CLICK, OTHER_DOC, CLOSED);
  - `webview/src/state.test.ts` (KEEP, plus the reducer for every message) and STABLE in `webview/src/layout.test.ts`;
  - COST measured with a small script or test, with the numbers in Implementation Notes.
- [x] `README.md`, `CHANGELOG.md`. Docs.

**Acceptance Criteria:**
- Given a graph open beside the YAML, when a processor is added, then the graph shows it with no reopening.
- Given a broken YAML, when typing continues, then the last valid graph and the banner stay until the YAML parses again, and a banner click selects the error.

## Implementation Notes

- **Core:** `src/core/parseError.ts` `parseErrorOf(parsed)`: the first error of `docs[0]`, offsets clamped to the text. The message is the first line of the `yaml` message (it appends a code excerpt), without the trailing colon, for example "All mapping items must start at the same column at line 3, column 1". A parse the parser gave up on (`parseYaml` → `undefined`) gives `{message: 'The YAML could not be parsed', range: [0, 0]}` rather than `undefined`, so the graph never blanks on it.
- **Host:** `GraphPanels` subscribes once to `onDidChangeTextDocument` and routes a change to the panel of its URI; events with no content change (dirty state, save) send nothing. `GraphPanel.state(doc)` reads `parsedDocument(doc)` once, returns the parse error or the model, and remembers the last valid model; `changed` posts `model` or `parseError`, `ready` posts the snapshot with the current model, or the last valid one (`null` if none) plus `parseError` while broken. `activate` and the banner click share `select(doc, range)`.
- **Banner click range:** `yaml` gives almost every error a one-character `pos` (`[p, p + 1]`), which is a position, not an end. So a range of at most one character is widened to the end of its line (the "no end" case of the plan); a longer range is selected as given.
- **Webview:** `webview/src/state.ts` `reduce(view, message)` (snapshot replaces both, `model` clears the banner, `parseError` keeps the model). `main.tsx` renders the banner (a `role="status"` strip holding one full-width button with `codicon-warning`, the EXPERIENCE text and the muted parser message) and the canvas in fixed slots, so the `Graph` stays mounted and `onInit`'s fit runs only for the first model. `graph.css` adds `.rpcn-app`, `.rpcn-canvas` and the banner styles (theme variables only; TOKENS passes).
- **Tests:** the old `UNPARSEABLE` integration test (empty model on a parse error) is replaced by `FIRST_BROKEN`, as its expectation changed.
- **COST** (2026-10-09, Node 22.23.1, Intel Xeon W-11855M, 4.112.0 catalogue, median of 50 runs after 10 warm-up runs; script in the session scratchpad, not committed):

  | Config | Size | Nodes | parse + `parseErrorOf` | build | ELK layout (median / max) |
  | --- | --- | --- | --- | --- | --- |
  | `eval.yaml` (largest, `wc -c`) | 5332 chars | 20 | 1.16 ms | 0.17 ms | 11.7 / 18.5 ms |
  | `track_benthos_downloads.yaml` (most nodes) | 2658 chars | 23 | 0.94 ms | 0.15 ms | 12.6 / 17.7 ms |

  About 13 ms per keystroke, nearly all ELK in the webview; the host side is under 1.5 ms. No debounce is needed.
- **Review fixes:** `posted` keeps only the last `MAX_POSTED` (50) messages. The banner click range comes from the pure `errorSelection(text, range)` in `parseError.ts`, which never runs into the next line (an error on a line break selects that line; an empty line, just the position). The banner overlays the top of the canvas (absolute), so the canvas never resizes; its text and the parser message both shrink with ellipsis. The view is placed once, on the first laid-out model with nodes (`firstView` in `state.ts`): it restores the viewport saved in `setState` on every move end (a recreated webview), else it fits. A core test (STABLE_IDS) shows a comment line and a blank line at the top keep every id, parent, group and edge.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, by a fresh subagent; 2026-10-09):** 9 findings: 2 medium and 6 low patched, 1 low rejected. No intent_gap or bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `post()` keeps every posted message in `posted`, so live updates hold a model per keystroke for the panel's lifetime in production | medium | patch | Bounded to the last 50 messages. |
| 2 | A panel whose first model is empty never fits the real graph that arrives later | medium | patch | Fit once, on the first non-empty model; pure helper with a test. |
| 3 | The banner is a flex item, so each break or heal shifts the whole graph | low | patch | The banner overlays the canvas. |
| 4 | The viewport is not saved with `setState` (AD-3), so hide and show refits | low | patch | Saved on move end and restored on mount. |
| 5 | The banner text overflows on narrow panels | low | patch | It shrinks with an ellipsis. |
| 6 | A banner click on an error at a line break selects into the next line | low | patch | Clamped to the error's line. |
| 7 | The README and CHANGELOG say a field value "moves nothing", but a `label:` sets width and id | low | patch | Reworded. |
| 8 | STABLE never builds a model from edited text | low | patch | A builder test: a comment and a blank line give the same ids, parents and edges. |
| 9 | The banner's live region is inserted with its text and re-announces on each keystroke | low | reject | Entry 11 owns the screen-reader model, including "a polite live region for the banner and new errors". |

## Verification

**Re-verification after the review patches (parent, 2026-10-09):** `npm run compile` clean; `npm run test:webview` 75 passed; `npm test` 589 passing on stable and 1.100.0; `npm run test:corpus` 123 passed. Manual check pending (the user).

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass on stable and 1.100.0.
- `npm run test:webview`: all pass.
- `npm run test:corpus`: all pass.

**Manual checks:**
- In the dev host, type into `graph-demo.yaml` with the graph open: it follows edits; breaking the indentation keeps the graph with the banner; clicking the banner selects the error; fixing it clears the banner.
