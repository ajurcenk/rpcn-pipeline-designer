---
title: 'Empty states: no binary and nothing to draw'
type: 'feature'
ticket: '9'
created: '2026-10-09'
status: 'done'
baseline_revision: 'bcc3ef4e242124b74a38b46508f3f71ab60cefd3'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Without a usable binary the graph panel shows a blank canvas and gives no way out. A config with no pipeline sections also shows a blank canvas. The panel also never picks up a schema that arrives after it opened, so the graph stays empty until the next edit (R9, R10, CAP-1, CAP-7).

**Approach (AD-9, AD-20):**
- The host sends the real `hostStatus {binary, schema}`, in the snapshot and as its own message whenever the binary state or the schema changes.
- While `binary` is not `ok` or there is no schema, the host sends **no model** (`model: null` in the snapshot, no `model` messages).
- When the schema arrives, each open panel gets the model, the selection and the node status at once, with no reopen and no edit needed.
- The webview shows:
  - **binary missing:** with `binary` `missing` or `invalid`, "No Redpanda Connect binary. The graph needs it to read the schema." and the buttons **Install guide**, **Set path** and **Retry**. They post `installGuideRequested`, `setPathRequested` and `retryRequested`, which run the same actions as the binary notification;
  - **nothing to draw:** with a schema, a model with no nodes and no parse error, "Nothing to draw yet. Add an `input`, `pipeline` or `output` section."

**Decisions (agent defaults, reported at the checkpoint):**
- **The other states:**
  - `binary: 'unresolved'`, or `ok` with the schema loading, shows an empty canvas and no text; the existing VS Code progress covers it (EXPERIENCE :106);
  - `ok` with schema `none` (generation failed) also shows an empty canvas; the existing schema warning reports it. The no-binary copy would be wrong there.
- **Schema status:** `ok` when `schemaStore.current` is set. `loading` when the binary is `ok` and a generation is in flight, through a new public read-only `SchemaStore.loading` getter. Otherwise `none`.
- **One action implementation:** the Install guide, Set path and Retry logic moves out of `attachBinaryNotifications`'s closures into an exported function that the notification and the panel share. Set path's "warn again when it is still unusable" stays as it is.
- **Parse error with no model:** the banner keeps its current behaviour. The nothing-to-draw text is not shown while the banner is up.
- **Empty states:** a `role="region"` with `aria-label="Pipeline graph, read-only"`, real `<button>`s reachable with the keyboard, muted text and link-styled buttons (DESIGN `graph-empty-state`, theme variables only).

## Boundaries & Constraints

**Always:**
- The webview stays render-only (AD-3): it decides the empty state from `hostStatus`, the model and the parse error, and does no binary work itself.
- The protocol stays as it is: the three intents and `hostStatus` are already defined and validated.
- The notification's behaviour is unchanged; its tests keep passing.
- **Green:** `npm test` (stable and 1.100.0), `npm run test:webview`, `npm run test:corpus` and CI.

**Never:**
- new commands or settings;
- skeletons or spinners;
- auto-opening the panel (3.10);
- changing how the binary is resolved;
- keyboard navigation of the graph (3.11).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MISSING | `binaryPath` points at no file; Show graph | snapshot `model: null`, `hostStatus.binary: 'missing'`; the view shows the no-binary state | — |
| SET_PATH | `setPathRequested`, the user picks the fake binary | binary `ok`, the schema arrives; the same panel gets `hostStatus` and then the model | the pick is cancelled → nothing changes |
| RETRY | `retryRequested` after the binary was fixed outside | re-resolves; the graph draws in the same panel | still missing → the state stays |
| GUIDE | `installGuideRequested` | `INSTALL_GUIDE_URL` opens | — |
| LATE_SCHEMA | the panel is open while the schema is loading | `model` is sent when the schema arrives, with no `ready` needed | — |
| LOST | the binary becomes `missing` while a graph is shown | `hostStatus` is sent; the view shows the no-binary state | — |
| NOTHING | a valid config with only `http: {}` | the model has no nodes; the view shows "Nothing to draw yet…" | — |
| RESOURCES_ONLY | only `*_resources` | resources are drawn; no empty text | — |
| VIEW | each status and model combination | the matching state, buttons post the right intent | — |

</frozen-after-approval>

## Code Map

- **Protocol** (`src/shared/protocol.ts`, no change needed):
  - `BinaryStatus`, `SchemaStatus` and `HostStatus` (:90–93);
  - the `hostStatus` host message (:115);
  - the intents (:128–130); the snapshot's `model: PipelineModel | null` (:101).
- **`src/adapters/graphPanel/panels.ts`:**
  - `SNAPSHOT_HOST_STATUS` (:47) and its header comment (:20–22) go;
  - `receive` (:136) gains the three intents;
  - `state()` (:319–337) returns `EMPTY_MODEL` with no catalogue and records it as `lastModel`. With no schema it must give no model, and it must not overwrite `lastModel`;
  - `GraphPanelsOptions` (:387) gains the binary state source, `schemaLoading` (or the store) and the actions;
  - `GraphPanels` (:411+) subscribes to `RedpandaConnect.onDidChange` and `SchemaStore.onDidChange` and fans out per panel. `catalogueOf` (:396) already re-keys on a new schema.
- **`src/extension.ts:167`:** pass `redpandaConnect` (:144), `schemaStore` (:148) and the shared actions built from `createVsCodeNotifier(log)` (:69).
- **`src/adapters/redpandaConnect/notify.ts`:**
  - `setPath` (:123) and `runAction` (:139) inside `attachBinaryNotifications` (:98) are the logic to extract;
  - `INSTALL_GUIDE_URL` (:9);
  - `BinaryNotifier` (:21).
- **`src/adapters/redpandaConnect/schema.ts`:** `SchemaStore` (:79), private `inFlight` (:81); add a `get loading()`.
- **Webview:**
  - `state.ts`: `ViewModel` (:13) gains `hostStatus`; `reduce` (:30) handles `hostStatus`; the snapshot keeps it;
  - `main.tsx`: `Banner` (:17) is the pattern; `App` (:30) picks the empty state;
  - `host.ts:26`: `post`;
  - `graph.css`: next to the banner (:236–280), checked by the TOKENS test;
  - mockup `ux-rpcn-vscode-designer/mockups/key-binary-missing.html`.
- **Tests:**
  - `80-graph.ts`: the snapshot assertion of `hostStatus` (:163) changes; NO_SCHEMA (:557) and CURRENT_SCHEMA (:575, which re-posts `ready` by hand) are the patterns;
  - `schemaHarness.ts`: `setBinaryPath` (:37), `useSchemaBinary` (:89);
  - missing binary: `70-feedback.ts:38`;
  - a custom `BinaryNotifier`: `00-activation.ts:154`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/redpandaConnect/notify.ts`, `src/adapters/redpandaConnect/schema.ts`: export the shared binary actions; add `SchemaStore.loading`. Reuse without changing behaviour.
- [x] `src/adapters/graphPanel/panels.ts`, `src/extension.ts`: the real `hostStatus`, no model without a schema, the fan-out on binary and schema changes (LATE_SCHEMA, LOST), and the three intents. Host behaviour.
- [x] `webview/src/state.ts`, `webview/src/main.tsx`, `webview/src/graph.css`: `hostStatus` in the view, a pure `emptyStateOf(view)` helper, and both empty states with their buttons. View behaviour.
- [x] Tests:
  - `80-graph.ts`: MISSING → SET_PATH (fake picker) → model in the same panel; RETRY; GUIDE; LATE_SCHEMA; LOST; NOTHING; RESOURCES_ONLY;
  - vitest: `emptyStateOf` and the reducer (VIEW);
  - the notify tests are kept green.
- [x] `README.md`, `CHANGELOG.md`. Docs.

**Acceptance Criteria:**
- Given no binary, when the user opens the graph and clicks Set path and picks a valid binary, then the graph draws in that same panel.
- Given an open graph for an empty file, when the user types `input:\n  stdin: {}`, then the empty text gives way to the input node.

## Implementation Notes

- **Shared actions:** `binaryActions(source, notifier, log, warnings, isDisposed)` in `notify.ts` holds Install guide, Set path (with its "warn again") and Retry; `attachBinaryNotifications` builds its actions with it and exposes them as `BinaryNotifications.actions`, surfaced as `RedpandaConnect.actions`, which `extension.ts` passes to `GraphPanels` (so the panel's Set path counts the same warnings as the notification's).
- **No parse error without a schema either:** with no schema the host sends neither a model nor a `parseError` (snapshot included), and the webview drops its model and banner on a `hostStatus` whose schema is not `ok`. Otherwise a banner raised before the binary was lost would never clear (only a `model` clears it). When the schema comes back on a broken file, the panel gets the `parseError` again. The banner's behaviour with a schema is unchanged.
- **Generation that yields no schema:** a binary change to `ok` starts a generation; the panels also re-check once `SchemaStore.settled()` resolves, so `loading` gives way to `none` even though a failed generation fires no schema change.
- **Nothing to draw** keeps the (empty) graph mounted under the text, so the first typed node is placed by the existing first-fit rule.
- **Tests:** SET_PATH, RETRY and GUIDE use a test-owned `GraphPanels` on the extension's binary and schema with `binaryActions` over a fake picker and browser (the real picker needs a human).

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 1 medium, 4 low, 0 false, 0 maybe-false; 1 low rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | `ready` reads `hostStatus` before `await this.document()`, so a change during the await leaves a stale status in the snapshot and in `sentHost` | medium | patch | `SchemaStore` sets `undefined` synchronously on a binary change, so `hostChanged` can run in that await; read the status after it |
| 2 | Schema back on a broken file: live shows the banner over an empty canvas, a recreate shows it over `lastModel` | low | patch | `hostChanged` posts only `parseError`, while `ready` sends `state.model ?? lastModel`; send `lastModel` first |
| 3 | No test that each button posts the right intent (VIEW) | low | patch | the buttons are inline in `main.tsx`; move them to a tested constant |
| 4 | LATE_SCHEMA asserts an exact, timing-dependent status sequence | low | patch | relax to the final status plus the model |
| 5 | LOST does not check "the parse error, no model" and leaves `lost.yaml` broken | low | patch | assert the order; undo the edit |
| 6 | `actions` `undefined` makes the buttons silent no-ops | low | reject | production always has a notifier (`createVsCodeNotifier`); unlikely in use, and the fix adds a branch |

## Verification

**Commands (2026-10-09, after the review patches):**
- `npm run compile` and `npm run lint`: exit 0.
- `npm test`: 614 passing on stable 1.141.0 and on 1.100.0, including MISSING / SET_PATH, RETRY, GUIDE, LATE_SCHEMA, LOST, NOTHING, RESOURCES_ONLY and NO_SCHEMA.
- `npm run test:webview`: 99 passed. `npm run test:corpus`: 123 passed.

**Manual checks:**
- In the dev host:
  - set `redpandaConnect.binaryPath` to a missing file, then Show graph: the no-binary state shows; Set path to the real binary draws the graph;
  - an empty YAML file shows "Nothing to draw yet".
- **Done by the user on 2026-10-09** in the dev host (stable), started with a PATH without `rpk` and `redpanda-connect` and no `redpandaConnect.binaryPath` (the setting is only a fallback after PATH, so a bad setting alone does not make the binary missing): the no-binary state with its three buttons, Retry with nothing fixed, Install guide, Set path to `~/.local/bin/redpanda-connect` drawing "Nothing to draw yet" in the same panel (a `buffer`-only file), and typing an `input` replacing it. Result: "tested".
