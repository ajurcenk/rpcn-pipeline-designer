---
title: 'Code health for the graph model and the panel adapters (story 50 group B)'
type: 'refactor'
ticket: '55'
created: '2026-11-13'
status: 'built'
baseline_revision: 'eb154b8ea9d26a6a7561f1cdcf5fb66b2637ccb5'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The epic 3 and epic 4 retrospectives (F12, F15, F17, AI-6; G-1) found the graph model walking ancestors and building id-to-node maps in six places with three slightly different rules, errors read inline with `instanceof Error` instead of `errorText` in about 30 places, and the graph and Bloblang test panel adapters reaching VS Code directly, so no unit test runs them.

**Approach:** A refactor: one shared ancestor walk and id map serve the model and the webview layout; every error read that gives `errorText`'s text uses `errorText`; each panel registry reaches VS Code through a named Source interface (defaulting to the real API), and unit tests drive it through a fake. What the user sees does not change.

**Decision (user, 2026-11-12):** split from story 50 as its group B. No floor (VS Code 1.100.0) runs (user).

**Decision (2026-11-13, the recommended options; the user's standing instruction that day: "Do not ask me for approval, use the recommendation if I have to make a decision"):** the shared walk and map live in `src/shared` (the webview may import only `src/shared`), and `errorText` moves to `src/shared` (re-exported where it is today); reads that print other text today (`String(err)` giving `Error: msg`, the duck-typed log read errors, the cloud errors with their cause) keep their text and stay as they are; epic 3's AI-6 shared test filters are out of scope (they would edit integration suites, which criterion 3 keeps unchanged); epic 4's G-1 split of the Bloblang panel registry (tabs, placement, focus) is out of scope and deferred, as it is large; the Source interfaces follow the `DetectionSource` and `CloudUi` precedent.

## Boundaries & Constraints

**Always:** Every command, message, log line, setting, focus and placement behavior of the panels, and the webview protocol, unchanged; each walk keeps its own edge rules (whether the node itself is included, whether an unknown parent id is yielded, how a cycle stops) on top of the shared walk; the Source defaults to the real VS Code API, so `src/extension.ts` passes nothing new unless needed; AD-15 layering (`src/core` and `src/shared` import no adapters or `vscode`; `webview/` imports only `src/shared`).

**Never:** Changing an existing integration or corpus test; changing an error's text; splitting the Bloblang panel registry (G-1); the shared test filters (AI-6).

</frozen-after-approval>

## Code Map

- Graph types: `src/shared/protocol.ts:23` `PipelineNode` (`parent?` :39), `:54` `PipelineModel`.
- Walks and maps: `src/core/nodeAt.ts:15-18` map, `:20-44` depth memo walk (stops on unknown parent or cycle via `seen`); `src/core/nodeStatus.ts:35` map, `:61` strict ancestors stopping when `!byId.has(p)` (map rebuilt per diagnostic through `nodeAt` :52); `webview/src/layout.ts:148`/`:155` `visibleAncestor` (yields an unknown parent id, then stops), `:262`/`:265` `visibleNodes` (same), `:311`/`:313` `focusChain` (includes the node; cycle by `chain.includes`), `:417-426` `ancestors(id, parentOf)` over a filtered `parentOf` (:439, appends `undefined`), maps `:508` (`toFlow`), `:565` (`roles`, id→role, not a node map); linear `nodes.find` at `src/core/bloblangProcessors.ts:286`, `src/adapters/graphPanel/graphPanel.ts:467`.
- `errorText`: `src/adapters/redpandaConnect/text.ts:4`. Same-text copies to replace: local functions `redhatYaml/contributor.ts:15-17`, `vscode/cloudShared.ts:29` `reasonOf`, `vscode/secrets.ts:73`, `vscode/environmentView.ts:289`; inline `core/samples.ts:140`, `unsetVariables.ts:123`, `:202`, `envSetting.ts:161`, `cloud/sidecar.ts:114`, `cloud/controlPlane.ts:134`, `logsPanel.ts:856`, `shared/logsProtocol.ts:528`, `graphPanel/graphPanel.ts:458`, `graphPanel/panels.ts:375, 704, 725, 758, 931, 986, 1024, 1043`, `bloblangPanel/panels.ts:936, 1051, 1365, 1430, 1475, 1541, 1593, 1617`, `bloblangPanel/sampleStore.ts:306, 341, 361, 413`. Keep as they are: `vscode/diagnostics.ts:299`, `vscode/run.ts:307`, `:456`, `redpandaConnect/lint.ts:40`, `vscode/bloblangDiagnostics.ts:351` (`String(err)`), `logsPanel.ts:1424`, `:1633`, `cloudLogs.ts:304` (`isLogReadError`), `core/samples.ts:163` (`ShapeError`), `cloud/errors.ts:106-111`, `logs/platformaticReader.ts:115`.
- Panels: `src/adapters/graphPanel/panels.ts` `GraphPanels` :162 (ctor :211, options `GraphPanelsOptions` :89; VS Code calls :221-297, `createWebviewPanel` :802, `registerCommand` :681-682, `lockEditorGroup` :1019, `setContext` :1056) with `groups.ts`, `tabs.ts`, `graphPanel.ts`; `src/adapters/bloblangPanel/panels.ts` `BloblangPanels` :1065 (ctor :1089, options :241; `createWebviewPanel` :1545, `registerCommand` :1446, `SET_MISSING_COMMAND` :1309) and `BloblangPanel` :307. Wiring `src/extension.ts:260-296`.
- Precedent: `DetectionSource` `src/adapters/vscode/detection.ts:13` (default `vscode.workspace` :81); `CloudUi` `src/adapters/vscode/cloudView.ts:217`, `defaultCloudUi` :254, option :447.
- Unit tests: `src/test/adapters/graphPanel/{html,nodeStatus,tabs}.test.ts`, `src/test/adapters/bloblangPanel/sampleStore.test.ts`; run in the extension host by `vscode-test` (mocha tdd, `out/test/**/*.test.js`).

## Tasks & Acceptance

**Execution:**
- [ ] `src/shared/graphModel.ts` (new) -- `nodesById(model)` (last duplicate wins, as today) and `ancestorIds(parentOf, id)` (a generator of strict ancestor ids, guarded against cycles, taking a `parentOf` accessor so the filtered layout walk can use it); unit tests for both (unknown parent, cycle, duplicate ids) -- criterion 1.
- [ ] `src/core/nodeAt.ts`, `src/core/nodeStatus.ts`, `webview/src/layout.ts`, `src/core/bloblangProcessors.ts`, `src/adapters/graphPanel/graphPanel.ts` -- use them, each keeping its edge rule (see Code Map); `nodeStatus` builds its map once per call, not once per diagnostic, if that keeps its output -- criterion 1.
- [ ] `src/shared/errorText.ts` (new) -- `errorText` moved here; `src/adapters/redpandaConnect/text.ts` re-exports it; every same-text read in the Code Map uses it; the keep-as-is reads untouched -- criterion 1.
- [ ] `src/adapters/graphPanel/panels.ts` (+ `groups.ts`, `tabs.ts`, `graphPanel.ts` where they call VS Code) -- `GraphPanelsSource` (workspace and window events, `visibleTextEditors`, `activeTextEditor`, `tabGroups`, `createWebviewPanel`, `showTextDocument`, `openTextDocument`, `executeCommand`), an optional `source` option defaulting to the real API -- criterion 2.
- [ ] `src/adapters/bloblangPanel/panels.ts` -- `BloblangPanelsSource` (its workspace and tab events, `textDocuments`, `openTextDocument`, `applyEdit`, `fs.stat`, `getWorkspaceFolder`, `showTextDocument`, `createWebviewPanel`, `executeCommand`), same pattern; prompts and messages stay on the existing seams -- criterion 2.
- [ ] `src/test/adapters/graphPanel/panels.test.ts`, `src/test/adapters/bloblangPanel/panels.test.ts` (new) -- a fake Source with fake `WebviewPanel`s; graph: show creates one panel and a second show reveals it, dispose empties `panelFor`, hide stores to the memento and suppresses auto-open, closing the last text tab closes the panel, a will/did rename re-keys the panel and its title; Bloblang: test mapping with no processor shows `NO_MAPPING_AT_CURSOR`, a second open reveals, a close or rename follows the panel -- criterion 2.
- [ ] Run the stable and multi-root suites after the walk/errorText tasks and again after the Source tasks; record it in Implementation Notes.
- [ ] `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` -- one entry each for G-1 (the Bloblang registry split) and AI-6 (the shared test filters), naming this decision.

**Acceptance Criteria:**
- Given the code after this change, when it is read, then one ancestor walk and one id map serve the model and the layout, and every error read whose text is `errorText`'s uses it.
- Given compile with lint, corpus, webview, stable and multi-root runs, when they run, then all pass, and `git diff eb154b8 -- src/test/integration src/test/integration-multiroot src/test/corpus` is empty.

## Implementation Notes

- `src/shared/graphModel.ts`: `ancestorIds` keeps its own seen set, not seeded with the start id, so the start is yielded once if it is its own ancestor; `visibleAncestor`, `focusChain` and `nodeStatusOf` (whose old walks seeded it) stop on `p === id`, `visibleNodes` and the layout's `ancestors` take every yield. `nodeAt`'s depth walk and `visibleNodes` start from the iterated node's own `parent` (then `ancestorIds(parentOf, node.parent)`), as the old loops did. Callers that stopped on an unknown parent (`nodeAt`, `nodeStatusOf`, `focusChain`) check `byId.has` themselves. `bloblangProcessors` `entryOf` and `GraphPanel.activate` keep their `nodes.find` (first duplicate wins; one lookup).
- `nodeStatusOf` builds its own map once per call but keeps one `nodeAt` per diagnostic: a locator shared across offsets would carry `nodeAt`'s depth memo between them, which changes the result on a parent-cycle model. Cycle values are now pinned in the `nodeAt`, `nodeStatusOf`, `visibleAncestor` and `focusChain` tests.
- `errorText` moved to `src/shared/errorText.ts`; the local copies (`redhatYaml/contributor.ts`, `reasonOf` in `cloudShared.ts`, `secrets.ts`, `environmentView.ts`) are gone and their callers (also `cloudDeploy.ts`, `cloudLogs.ts`, `cloudView.ts`, `cloudActions.ts`) call `errorText`. The keep-as-is reads are untouched.
- Sources: `PanelSource` (`window` tab groups, active editor and its event, `showTextDocument`; `commands.executeCommand`), `GraphPanelSource` (what `GraphPanel` reaches) and `vscodeSource` (the real `workspace`, `window`, `commands`, the registries' default only) in `groups.ts`; `newGroupNextTo`, `returnFocusTo`, `hasTextTab`, `openDocument` and the `GraphPanel` constructor take their Source (or its tab groups / documents) as a required argument. `GraphPanelsSource` (panels.ts, also passed to `GraphPanel`) and `BloblangPanelsSource` extend it as `Pick`s of `typeof vscode.workspace` / `vscode.window`; `registerCommand` and the prompts stay on VS Code. `src/extension.ts` is unchanged.
- Fake: `src/test/helpers/fakePanelSource.ts` (events, tab groups, editors, recording webview panels); its parts are checked with `satisfies` against both Sources' slices, with no cast. `src/test/shared/errorText.test.ts` pins `errorText`.
- Review fixes (2026-11-13): the focused unit run (nodeAt, nodeStatus, graphModel, errorText, graph and Bloblang panels, tabs, statusDiagnostics, sampleStore, bloblangProcessors) 81 passing; layout tests 79 passed; compile with lint exit 0.
- Runs after the walk/errorText tasks: stable 1514 passing, 1 pending, 0 failing; multiroot 15 passing. After the Source tasks: compile (lint) exit 0, corpus 182 passed, webview 384 passed; stable 1522 passing / 1 failing (the new Bloblang test expected `kind: undefined`; `tell` passes `'info'`; test fixed); rerun: stable 1523 passing, 1 pending, 0 failing; multiroot 15 passing. `git diff eb154b8 -- src/test/integration src/test/integration-multiroot src/test/corpus` is empty.

## Plan Change Log

## Review Triage Log

Thorough review (2026-11-13; blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Verdicts: 0 high, 3 medium, 12 low (8 patched, 4 rejected), 1 false. Routes: 11 patch, 0 defer, 0 loopback. Every `errorText` swap gives the same text; the walks keep their include, unknown-parent and cycle rules on acyclic and missing-parent models; the Source defaults reach the same VS Code members.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 1 | EC, BH, IA | `entryOf` and `GraphPanel.activate` switched from first to last duplicate id | medium | patch | `nodes.find` was first-wins; restored (the map gained nothing for one lookup). |
| 2 | EC | `visibleNodes` and `nodeAt`'s depth take their first step through the map, not the node's own `parent` | medium | patch | Differs on a duplicate id; start from `node.parent`. |
| 3 | EC | `nodeStatusOf` shares one depth memo across offsets, changing the result on a parent cycle | medium | patch | The plan allowed it only "if that keeps its output"; output kept. |
| 4 | VG | The per-caller cycle breaks are pinned only by `doesNotThrow` | low | patch | Value assertions on the cyclic cases; cyclic `focusChain`, `visibleAncestor`. |
| 5 | BH | `errorText` has no test | low | patch | Test added. |
| 6 | VG, BH | `BloblangPanelsSource`'s doc promises isolation `SampleStore` and `BloblangHints` do not have | low | patch | Doc narrowed; routing them is out of scope. |
| 7 | BH | The fake is cast through `unknown`; `remove(-1)` drops the last tab; every group starts active | low | patch | Typed against the Picks; guarded; first group only. |
| 8 | BH | Unused real-API default parameters on helpers | low | patch | Required; the registries keep the default. |
| 9 | BH | Type-only import cycle `graphPanel.ts` ↔ `panels.ts` | low | patch | The slice moves to `groups.ts`. |
| 10 | BH | New `shared` imports placed after local imports | low | patch | Grouped. |
| 11 | BH | The fake's `showTextDocument`, `applyEdit`, commands and the lock sequence are not exercised | low | reject | Beyond the tests the plan lists; the integration suites cover focus, lock and placement unchanged. |
| 12 | BH | `entryOf` scans the model per processor | low | reject | Pre-existing; 1 restores the one `find`. |
| 13 | BH | `redpandaConnect/text.ts` re-export kept | low | reject | The decision moves `errorText` and re-exports it where it is today. |
| 14 | IA | The unit tests need the extension host | low | reject | Every unit test here runs there (mocha via `vscode-test`); the Source isolates the panels, not the process. |
| 15 | BH | Three `isLogReadError(err) || …` reads not converted | false | reject | The decision keeps them: a log read error may not be an `Error`. |

Intent-alignment notes (descriptive): reading A1 (one primitive, each caller's rule on top), B1, C1 (registry-level seam, prompts and `registerCommand` on their existing seams, as `DetectionSource`); the integration suites unchanged.

## Design Notes

```ts
// src/shared/graphModel.ts
export function nodesById(model: { nodes: readonly PipelineNode[] }): ReadonlyMap<string, PipelineNode>;
export function* ancestorIds(parentOf: (id: string) => string | undefined, id: string): Generator<string>; // strict, stops on a repeat
```

A caller that must not yield an unknown parent checks `byId.has` itself; one that includes the node yields it first. The Source is structural (a subset of `typeof vscode.workspace` and `vscode.window`), so the real API satisfies it; the fake builds `vscode.Uri`, `ViewColumn` and `TabInputText` from the real module (unit tests run in the extension host).

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (lint included)
- `npm run test:corpus`, `npm run test:webview` -- expected: pass
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: 0 failing
- same with `--label multiroot` -- expected: 0 failing
- `git diff eb154b8 -- src/test/integration src/test/integration-multiroot src/test/corpus` -- expected: empty

**Result (2026-11-13, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 385, stable 1524 passing, 1 pending, 0 failing (11 min), multi-root 15 passing; `git diff eb154b8 -- src/test/integration src/test/integration-multiroot src/test/corpus` empty; the test settings clean; no floor run.
