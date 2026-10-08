---
title: 'Tracer: Show graph draws a pipeline and a click selects its YAML'
type: 'feature'
ticket: '1'
created: '2026-10-08'
status: 'built'
baseline_revision: 'b787266596e6768c6ad414a1e68e7102cb88b584'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 3 has no webview layer yet. There is no browser bundle, no protocol, no panel and no model, so none of the graph stories can start.

**Approach:** Build the thinnest end-to-end path:
1. **Show graph** (now visible) opens one panel per file beside the editor.
2. The host builds a flat model of the file (top-level input, `pipeline.processors`, output) in `src/core` and sends it as a `snapshot`.
3. The webview lays it out with elkjs and draws it with @xyflow/react.
4. A click sends `nodeActivated`, and the host selects that node's YAML range.

**Decisions (agent defaults from investigation, reported at the checkpoint):**
- **Layout on disk:** the webview source is in a top-level `webview/src/` (its own tsconfig with DOM and JSX, type-check only) and is bundled to `dist/webview.js`, an IIFE for the browser.
- **CSP:** `default-src 'none'; script-src 'nonce-<random>'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:; font-src ${cspSource}`. @xyflow/react sets inline style attributes.
- **Versions** (architecture Stack): `react` / `react-dom` / `@types/react(-dom)` 19.3.0, `@xyflow/react` 12.12.0, `elkjs` 0.12.0 (`elk.bundled.js`, main thread). Pinned exactly, as `yaml` is.
- **Commands:** Show graph appears in the Command Palette for detected files (`redpandaConnect.activeEditorDetected`). Hide graph stays hidden; the toggle and Hide are entry 10. Titles become "Show graph" and "Hide graph".
- **Showing the graph:** Show graph on an already open panel reveals it. The tab title is "Graph: {filename}". `retainContextWhenHidden` is off; the webview sends `ready` again when it is recreated and gets a fresh `snapshot`.

## Boundaries & Constraints

**Always:**
- **Layering (AD-15), lint-enforced:**
  - `webview/` imports only `src/shared` (no `vscode`, no Node built-ins, no `yaml`);
  - the model builder is pure in `src/core` (the only `yaml` importer);
  - the panel lives in `src/adapters/graphPanel`.
- **Protocol (AD-5):** every message type is defined only in `src/shared/protocol.ts`, as a discriminated union on `type`. Here: `ready` and `nodeActivated {nodeId, via: 'click'}` from the webview, and `snapshot {model}` from the host.
- **The model:**
  - holds no coordinates (AD-4);
  - node ranges are UTF-16 `[start, end)` from the parse (AD-16);
  - ids follow AD-7 in their simplest form: `input:<name>`, `processor:<index>:<name>`, `output:<name>`.
- **Navigation:** the click selects and reveals, centred, the node's range in the file's text editor. Nothing edits the text (AD-19).
- **Packaging:**
  - the `.vsix` carries `dist/webview.js` and not `webview/` sources;
  - NOTICE lists every newly bundled package with its licence: elkjs EPL-2.0; React, react-dom, scheduler, @xyflow/react and its bundled dependencies MIT;
  - the existing `npm test` (stable and 1.100.0), `npm run test:corpus` and CI stay green.

**Never:**
- nested groups, resources, edges with labels, or collapse (entries 3–4);
- live updates, `parseError`, node status, the cursor highlight, empty states, auto-open, Hide or `workspaceState` (later entries);
- a serializer or panel restore;
- a worker for elkjs;
- editing the YAML.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FLAT | `stateful_polling.yaml` (generate, 4 processors, broker output) | panel "Graph: stateful_polling.yaml" with input → 4 processors → output in order | — |
| CLICK | `nodeActivated` for processor 2 | that processor's range is selected in the file's editor, revealed centred | — |
| AGAIN | Show graph twice on one file | one panel, revealed | — |
| TWO_FILES | Show graph on two files | two panels, each with its own model | — |
| PARTIAL | only `input:` / no processors / only `output:` | the present parts only | — |
| UNPARSEABLE | a YAML parse error | snapshot with an empty model (the banner is entry 6) | never throws |
| STALE_ID | `nodeActivated` with an unknown id | nothing happens | ignored |
| CLOSED | the panel is closed, then Show graph again | a new panel | old one disposed |

</frozen-after-approval>

## Code Map

- **`esbuild.js`** (56 lines): one context, `src/extension.ts` → `dist/extension.js` (cjs, node, `external: ['vscode']`); production and watch flags at L3–4; `esbuildProblemMatcherPlugin` at L9–24. Add a browser context (`webview/src/main.tsx` → `dist/webview.js`, iife, `jsx: 'automatic'`, same plugin and flags). Run both contexts for watch and for rebuild/dispose.
- **`tsconfig.json`:** root `include: ["src"]`, no DOM; don't put `.tsx` under `src`. Copy the noEmit pattern in `test/corpus/tsconfig.json` for `webview/tsconfig.json` (ES2022 + DOM, `jsx: react-jsx`, Bundler, include `src` and `../src/shared`).
- **`package.json`:**
  - scripts `check-types` (L171: append `&& tsc -p webview/tsconfig.json`) and `lint` (L172: add `webview`);
  - dependencies (L200–202, exact pins; `@types/*` go in devDependencies);
  - commands showGraph and hideGraph (L72–81) get sentence-case titles;
  - `menus.commandPalette` showGraph (L109–112) gets `when: redpandaConnect.activeEditorDetected`, like `run` at L117–120;
  - `activationEvents` stays `onLanguage:yaml`.
- **`.vscodeignore`:** add `webview/**`; `dist/` already ships.
- **`eslint.config.mjs`:**
  - the import patterns `vscodeImport` L7, `childProcessImport` L15, `yamlImport` L20; `sharedBlocks` L47–61 (bans relative imports out of `src/shared` by depth);
  - the base block L63–64 matches only `*.ts`/`*.mts`: add `*.tsx`;
  - add a `webview/**/*.{ts,tsx}` block that bans vscode, child_process, yaml and Node built-ins, and allows relative imports out of `webview/` only into `src/shared`;
  - extend the AD-15 header comment at L3–6.
- **`src/shared/index.ts`:** a placeholder; add `protocol.ts` beside it.
- **Core model:**
  - `src/core/yamlPath.ts` `parseYaml(text)` (L37, never throws) returns `ParsedYaml {docs, lineCounter, length}`; `node.range` is `[start, valueEnd, nodeEnd]`;
  - the new `src/core/graph.ts` builds the flat model from `docs[0].contents`;
  - the adapter gets the parse from `src/adapters/vscode/parseCache.ts` `parsedDocument(doc)`.
- **`src/extension.ts`:**
  - add `graphPanels` to `ExtensionApi` (L44–63) as a test seam;
  - construct it in `activate` after `run` (L161–162) with `context.extensionUri`, and push it and its commands to the subscriptions.
- **Pattern to copy:** commands and their target URI follow `src/adapters/vscode/run.ts` L199–218: `registerCommand(…, (uri?) => …)`, with `uri ?? activeDocument()?.uri`.
- **Reveal:** `new vscode.Range(doc.positionAt(s), doc.positionAt(e))` (as in `quickFix.ts` L140), then `showTextDocument(doc, {viewColumn, selection, preserveFocus: false})` or `editor.selection` plus `revealRange(…, InCenterIfOutsideViewport)`. There is no reveal code in `src` yet.
- **Tests:**
  - `src/test/integration/index.test.ts` L4–11: append `./suites/80-graph`;
  - helpers `waitFor`, `EXTENSION_ID` (`helpers.ts`); `REPO_ROOT` (`src/test/helpers/fakeBinary.ts` L78);
  - corpus file `test/corpus/stateful_polling.yaml`;
  - a host-side test seam (for example `panelFor(uri)` and a way to deliver a webview message), so tests don't drive the webview DOM.
- **NOTICE:** an entry is `name version (url), Licence:`, a blank line, the copyright, a blank line, the full licence text (see the yaml entry, L1–11 onward). Check the built bundle for transitive packages (scheduler, @xyflow/system, zustand, d3-*, classcat).
- **Docs:** README gets a `## Pipeline graph` section after "Run and Stop" (dense paragraph, bold UI names); CHANGELOG gets one bullet under `[Unreleased]`, newest first.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `package-lock.json`: dependencies and @types, scripts, command titles and the Show graph palette entry. Builds the webview lane.
- [x] `esbuild.js`, `webview/tsconfig.json`, `eslint.config.mjs`, `.vscodeignore`: the browser bundle, its type-check and the layer rule. AD-15.
- [x] `src/shared/protocol.ts`: `PipelineModel` (flat) and the three messages. AD-5.
- [x] `src/core/graph.ts`: the flat model from `ParsedYaml`, with unit tests for every matrix row that is about the model (FLAT, PARTIAL, UNPARSEABLE). Pure core.
- [x] `src/adapters/graphPanel/` (a panel registry plus the HTML with CSP and nonce): Show graph, the snapshot on `ready`, `nodeActivated` → select and reveal, dispose on close. The host lane.
- [x] `webview/src/` (`main.tsx` and a `Graph` component): post `ready`, lay out the snapshot with elkjs, render with @xyflow/react, post `nodeActivated` on click. The view lane.
- [x] `src/extension.ts`: wiring and the `ExtensionApi` seam.
- [x] `src/test/integration/suites/80-graph.ts`: FLAT (one panel, its model), CLICK, AGAIN, TWO_FILES, STALE_ID and CLOSED through the seam. End to end on both VS Code versions.
- [x] `NOTICE`, `README.md`, `CHANGELOG.md`: licences and docs.

**Acceptance Criteria:**
- Given a corpus config open in the editor, when Show graph runs from the Command Palette, then a panel beside it draws input → processors → output, and clicking a processor selects its YAML.
- Given `npx vsce package --no-dependencies`, then the `.vsix` holds `dist/webview.js`, NOTICE lists each bundled package, and no `webview/` source is included.

## Implementation Notes

- **Ranges:** a block collection's `valueEnd` from `yaml` includes its trailing line break, so `src/core/graph.ts` trims trailing whitespace off the end; a processor's start moves back over its `- ` indicator (AD-16). Input and output nodes span the `input:` / `output:` pair. A component map's name is its first key other than `label` / `processors`; an input or output with no component key gives no node.
- **UNPARSEABLE:** any error in the first YAML document gives the empty model (`EMPTY_MODEL` in `protocol.ts`).
- **Webview:** `webview/src/main.tsx`, `Graph.tsx`, `host.ts` (the `acquireVsCodeApi` wrapper; a file named `vscode.ts` trips the `vscode` import ban), `graph.css` (theme variables only) and `css.d.ts`. The @xyflow/react stylesheet is imported, so esbuild also emits `dist/webview.css`, linked from the HTML (`style-src ${cspSource}`). `elk.bundled.js` names `web-worker` only on its `workerUrl` path, so the browser bundle marks it external. `process.env.NODE_ENV` is defined per build mode for React.
- **Host:** `src/adapters/graphPanel/panels.ts` (`GraphPanels` registry, `GraphPanelHandle` seam with `posted` and `receive`) and `html.ts` (CSP and nonce). Messages from the webview are validated; anything else is ignored. The model is rebuilt from the current document on each `ready` and `nodeActivated`; nothing is stored between them.
- **Lint:** `webview/**` blocks ban vscode, child_process, yaml and Node built-ins, and relative imports that leave `webview/` for anything but `src/shared` (checked by hand with a throwaway file).
- **NOTICE:** the bundle (esbuild metafile) holds react, react-dom, scheduler, use-sync-external-store, @xyflow/react, @xyflow/system, zustand, classcat, d3-color/-dispatch/-drag/-ease/-interpolate/-selection/-timer/-transition/-zoom and elkjs. The d3 packages are ISC (d3-ease BSD-3-Clause), not MIT as the Boundaries line assumed; NOTICE lists each with its real licence.

## Plan Change Log

## Review Triage Log

**Pass 1 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment; 2026-10-08):** 31 findings (deduplicated into 24 rows): 0 high, 0 medium, 8 low patched, 12 low rejected, 4 false. No intent_gap or bad_plan.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|---|
| 1 | verification-gap | Show graph from the Command Palette (no argument) is never run | low | patch | PALETTE integration test. |
| 2 | blind, edge | An ELK layout rejection becomes an empty graph with no trace | low | patch | `console.error` in the webview (a host error message would add protocol surface). |
| 3 | blind | The node tooltip shows the internal id | low | patch | Shows `kind: name`. |
| 4 | edge | A merge key `<<` or a null key becomes the component name | low | patch | Skipped like `label`; unit test. |
| 5 | blind | Flow-style components and processors, and CRLF, are untested | low | patch | Unit tests. |
| 6 | blind | CSP, nonce and `escapeHtml` are untested | low | patch | Unit test of the page. |
| 7 | blind, edge | The webview Node built-in list is hand-written and incomplete; `../../src/shared/../core` bypasses the layer rule | low | patch | List from `module.builtinModules`; the rule rejects climbing out of `src/shared`. |
| 8 | edge | In watch mode the shared problem matcher can report "finished" before the webview bundle is written | low | patch | One started/finished pair across both contexts. |
| 9 | intent, verification-gap, edge, blind | No test drives the rendered webview: ELK layout, @xyflow drawing, a real click posting `nodeActivated` | low | reject | Epic decision (2026-10-08): rendering is checked by hand; pure webview modules get vitest tests from entry 4, the DOM gets happy-dom in entry 11. The FLAT test shows that the real bundle loads under the CSP and posts `ready`. Manual check below. |
| 10 | blind, edge | A click on a graph drawn before an edit re-parses the current text, so an index-based id can pick another processor or nothing | low | reject | The frozen Never excludes live updates; entry 6 re-sends the model on every change, which removes the stale graph. |
| 11 | blind, edge | The panel outlives a renamed, deleted or closed YAML file | low | reject | Entry 10 owns closing with the YAML tab and re-keying on rename; the fix adds listeners and branches. Errors are logged, not thrown. |
| 12 | verification-gap | A click with the file in a column other than One, and a range below the fold, are not observed | low | reject | Entry 7 owns the driving-editor rule; the fix is a new test setup. |
| 13 | blind | No empty-state or loading text in the panel | low | reject | Entries 6 (banner) and 9 (empty states). |
| 14 | blind | Not usable from the keyboard; no ARIA | low | reject | Entry 11 (R11). |
| 15 | blind | Two files with the same name get the same tab title | low | reject | The intent sets the title "Graph: {filename}"; VS Code shows the path in the tab tooltip. |
| 16 | blind, edge | `showGraph` accepts any URI | false | reject | R2: Show graph opens and marks any YAML file (entry 10); the palette is gated for detected files. |
| 17 | blind | `hideGraph` is contributed but not registered | low | reject | Pre-existing since 1.2 and hidden from the palette; entry 10 implements it. |
| 18 | blind | No `WebviewPanelSerializer`, so panels are lost on reload | false | reject | Frozen Never: "a serializer or panel restore" (spec Non-goals). |
| 19 | blind | StrictMode posts `ready` twice | false | reject | Only in development builds: esbuild defines `process.env.NODE_ENV` as `"production"` for the packaged bundle (`esbuild.js`). A second snapshot is harmless. |
| 20 | blind | `pairRange` uses non-null assertions | false | reject | It is called only after `componentName` found a map value, and parsed keys and values always carry ranges. |
| 21 | blind | Node size is set in both `Graph.tsx` and `graph.css` | low | reject | Cosmetic; entry 4 rewrites the node rendering. |
| 22 | edge | A leading empty document hides the config in a later document | low | reject | `parseAllDocuments` makes no empty first document for a leading `---`; multi-document configs are not a supported shape. |
| 23 | edge | A block item starting on the line after a bare `-` loses its indicator in the range | low | reject | Rare formatting; walking back across line breaks could pick up an unrelated `-`. |
| 24 | verification-gap | Lint layer rules have no fixture test; the packaging check omits `dist/webview.css` | low | reject | Lint fixtures would be repo-wide (the core and shared rules use the same hand-checked pattern). Adding the CSS to the check means editing this plan; the `.vsix` listing showed `dist/webview.css`. |

## Verification

**Re-verification after the review patches (parent, 2026-10-08):** `npm run compile` clean (one started/finished pair); `npm test` 540 passing on VS Code stable and 1.100.0; `npm run test:corpus` 89 passed; `vsce package --no-dependencies` holds `extension/dist/extension.js`, `dist/webview.js` (1.9 MB, vsce warns about the size) and `dist/webview.css`, and no `extension/webview/`. The dev-host manual check is pending (the user).

**Commands:**
- `npm run compile`: exit 0 (type-checks root, corpus and webview; lint over `webview/`).
- `npm test`: all pass on stable and 1.100.0.
- `npm run test:corpus`: 89 passed.
- `npx vsce package --no-dependencies` and `unzip -l *.vsix`: `extension/dist/webview.js` present, no `extension/webview/`.

**Manual checks:**
- With `scripts/dev-host.sh`, run Show graph on `test/corpus/stateful_polling.yaml`: the graph draws and a click selects the YAML. Check the webview developer console for CSP errors.
