---
title: 'Error and warning markers on nodes'
type: 'feature'
ticket: '8'
created: '2026-10-09'
status: 'done'
baseline_revision: '1c28bc32f8da389213e5a8214ad6688ef83276a4'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Lint findings and Red Hat's diagnostics show only in the editor and the Problems panel, so the graph cannot point at the faulty node (CAP-10, Done when 4).

**Approach (AD-17, R8):**
- A host **NodeStatusService** for each open graph panel reads `LintDiagnostics.diagnosticsFor(uri)`, which holds Red Hat's diagnostics plus the deduplicated lint ones (E2).
- It maps each diagnostic to a node with `nodeAt` at the right offset and builds `nodeStatus {byId}`.
  - Error beats warning.
  - Severity rolls up to every ancestor group.
  - Each node keeps its messages verbatim.
- It sends `nodeStatus` as its own message, when the status changes, a new model arrives or the diagnostics change. It stays frozen while the banner shows.
- The webview shows each state as a 2px border plus its own codicon (`codicon-error`, `codicon-warning`, from DESIGN's error and warning tokens), never colour alone. Hover lists the messages verbatim. A collapsed group shows the roll-up of what it hides.

**Decisions (agent defaults, reported at the checkpoint):**
- **Offset per diagnostic:**
  - a lint finding (source `Redpanda Connect`, a whole line from column 1) maps at the **first non-whitespace character** of its start line (epic Source conflict decision; otherwise the indentation lands in the parent node);
  - any other diagnostic maps at its `range.start` offset;
  - a diagnostic that maps to no node is dropped.
- **Severity:** `Error` is an error and `Warning` is a warning; `Information` and `Hint` are ignored. In practice, warnings come only from `lint --deprecated` (epic note).
- **Roll-up and own state:** `NodeStatus` gains an optional `own?: NodeSeverity`. `severity` is the rolled-up worst of the node and its descendants, `own` is the node's own worst, and `messages` are the node's own messages followed by its descendants' (in document order, with duplicates removed).
  - The webview marks a leaf by `severity`, an **expanded** group or route by `own` only (its children carry their own markers), and a **collapsed** group by `severity`.
  - It is an additive protocol change: the validators accept it, and old snapshots without `own` still validate.
- **Freeze (AD-17):** while `parseError` stands, no `nodeStatus` is sent and the webview keeps the last status. The next valid model recomputes it.
- **The snapshot** carries the current `nodeStatus` (the frozen one while broken).
- **First edit after save:** lint findings clear (AD-17, E2 R3), so their markers clear with them, which is correct by rule. Red Hat's diagnostics stay.
- **Wiring:** `GraphPanelsOptions` gains `diagnostics: Pick<LintDiagnostics, 'diagnosticsFor' | 'onDidChangeDiagnostics'>`, passed from `extension.ts`.
- **"Churn it caused itself" (AD-17):** the service never creates diagnostics, so it only needs not to re-send an unchanged status. This is noted in the code.

## Boundaries & Constraints

**Always:**
- **Mapping is the host's (AD-16, AD-17):** the host maps ranges to nodes, only through `nodeAt`, and the webview never maps ranges. The mapping (diagnostics → `byId`) is a pure core function and never throws.
- **Accessibility:** every marked node has a border **and** an icon, and the hover text is the messages verbatim. Colours are only DESIGN theme variables (TOKENS test).
- **Read-only:** no edits, no Quick Fix from the graph, and no change to the editor's diagnostics.
- **Green:** `npm test` (stable and 1.100.0), `npm run test:webview`, `npm run test:corpus` and CI pass.

**Never:**
- running lint;
- changing the clear-on-first-edit rule (backlog story 10);
- node status for files without a panel;
- screen-reader announcement of status (entry 11);
- the no-binary empty state (3.9).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MAP_LINT | a lint Error on a processor's line (whole line from column 1, indented) | that processor gets `{severity: 'error', own: 'error', messages: [msg]}`, not its parent | — |
| MAP_REDHAT | a Red Hat diagnostic with a precise range inside a node | the innermost node at `range.start` | — |
| ERROR_WINS | an error and a warning on the same node | `severity: 'error'`, both messages | — |
| ROLL_UP | an error inside a switch case | the case route and the switch group get `severity: 'error'` and no `own` | — |
| OWN_AND_CHILD | a warning on a group's own line and an error inside it | the group gets `severity: 'error'`, `own: 'warning'` | — |
| UNMAPPED | a diagnostic on a blank top-level line, or Information / Hint | dropped | never throws |
| SEND | save a file whose fake lint reports one error and one deprecation | a `nodeStatus` with the error and the warning on the right nodes and their groups | — |
| SAME | diagnostics change but the mapped status does not | no new `nodeStatus` | — |
| CLEAR | the first edit after save | a `nodeStatus` without the lint markers | — |
| FROZEN | `parseError` stands while diagnostics change | no `nodeStatus`; the next valid model sends the recomputed one | — |
| SNAPSHOT | the webview is recreated | the snapshot's `nodeStatus` is the current (or frozen) one | — |
| VIEW_MARKERS | status on a leaf, an expanded group (`own` absent or present) and a collapsed group | border and icon per the rules above; title holds the messages | — |
| VALIDATE | `nodeStatus` with and without `own`, and a bad `own` | accepted / accepted / rejected | — |

</frozen-after-approval>

## Code Map

- **E2 hand-off** (`src/adapters/vscode/diagnostics.ts`):
  - `LintDiagnostics.diagnosticsFor(uri)` (~L111) returns Red Hat's diagnostics plus the published lint ones;
  - `onDidChangeDiagnostics: Event<Uri>` (L80) fires when that set changes;
  - `LINT_SOURCE` is the source string.
- **`ExtensionApi.lintDiagnostics`:** `src/extension.ts` L54–55; built at L156, and `graphPanels` is constructed after it.
- **`src/adapters/graphPanel/panels.ts`:**
  - `GraphPanelsOptions` (L260) gains `diagnostics`;
  - `GraphPanel` keeps the last model, the parse error, the selection and the driving editor (3.6, 3.7);
  - the snapshot is built ~L95–100 (`nodeStatus: {}` today);
  - `GraphPanels` subscribes to events once and routes them per URI (L295 onward).
- **Core:**
  - `src/core/nodeAt.ts` `nodeAt(model, offset)`;
  - add `src/core/nodeStatus.ts` `nodeStatusOf(model, diagnostics: {offset, severity, message}[])`, which is pure. The adapter turns `vscode.Diagnostic` into offsets: the first non-whitespace character of the line for `LINT_SOURCE`, otherwise `doc.offsetAt(range.start)`.
- **Protocol** (`src/shared/protocol.ts`): `NodeSeverity`, `NodeStatus {severity, messages}` (L71–79; add `own?`), `NodeStatusById`, the `nodeStatus` host message (L104), `isNodeStatusById` (L180).
- **Webview:**
  - `webview/src/state.ts` is the reducer (it keeps `nodeStatus` on `model` and `parseError`; a `nodeStatus` message replaces it);
  - `webview/src/layout.ts` has `visibleAncestor` and `highlightDrawn` (3.7), the pattern for the pure marker resolution;
  - `webview/src/nodes.tsx` holds the renderers;
  - `webview/src/graph.css` is checked by the TOKENS test;
  - codicons come from `@vscode/codicons`, already bundled (3.4).
- **DESIGN tokens:**
  - `colors.error` `var(--vscode-errorForeground)`, `colors.error-border` `var(--vscode-inputValidation-errorBorder)`, `colors.warning` `var(--vscode-editorWarning-foreground)`, `colors.warning-border` (L26–29);
  - `pipeline-node-error` / `pipeline-node-warning` (L75–81), with "error wins" and "each always comes with its own icon" (L118).
- **Tests:**
  - `src/test/integration/suites/80-graph.ts` drives the host seam;
  - `src/test/integration/suites/50-lint.ts` shows a fake lint binary that prints findings (copy its pattern for SEND and CLEAR);
  - the core tests go in `src/test/core/`; the webview tests are vitest.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/nodeStatus.ts`: `nodeStatusOf` for MAP_*, ERROR_WINS, ROLL_UP, OWN_AND_CHILD and UNMAPPED. Pure mapping.
- [x] `src/shared/protocol.ts`: `own?` and its validation (VALIDATE). Additive contract.
- [x] `src/adapters/graphPanel/panels.ts` and `src/extension.ts`: the per-panel NodeStatusService (diagnostics → offsets → `nodeStatusOf`), send-on-change, the freeze, the snapshot, and the wiring. Host behaviour.
- [x] `webview/src/state.ts`, `webview/src/layout.ts`, `webview/src/nodes.tsx`, `webview/src/graph.css`: the marker resolution (leaf, expanded and collapsed groups), border plus icon, and the title. View behaviour.
- [x] Tests:
  - `src/test/core/nodeStatus.test.ts`;
  - `src/test/shared/protocol.test.ts` (VALIDATE);
  - `80-graph.ts`: SEND with a fake lint, SAME, CLEAR, FROZEN, SNAPSHOT;
  - `webview/src/*.test.ts` (VIEW_MARKERS).
- [x] `README.md`, `CHANGELOG.md`. Docs.

**Acceptance Criteria:**
- Given a saved config whose lint reports an unknown field inside a switch case and a deprecated field elsewhere, when the graph is open, then that case's node has the error border and icon, the switch header shows the error when collapsed, the deprecated field's node has the warning border and icon, and hovering shows each message verbatim.
- Given those markers, when the user types, then the lint markers clear (first edit after save).

## Implementation Notes

- Core `nodeStatusOf(model, StatusDiagnostic[])` takes severities `error | warning | information | hint` and drops the last two, so the adapter only converts. Keys follow model node order, so the host compares statuses by `JSON.stringify` to skip re-sending an unchanged one (SAME).
- The adapter part is `statusDiagnostics(doc, diagnostics)` in `panels.ts` (exported, with its own adapter test): it maps lint findings at the first non-whitespace character of their line and everything else at `range.start`. A whitespace-only lint line keeps its start.
- `GraphPanel` keeps `status` (the current one, or the frozen one while broken) and the serialisation last sent. A snapshot with a valid model recomputes the status, and one sent while broken carries the frozen status.
- Review round 1: `NodeStatus` gains `ownMessages` (present exactly when `own` is: the node's own messages, deduplicated, in document order; additive). An expanded group or route marked by `own` hovers its `ownMessages` (falling back to `messages` from an older host). The validator rejects an `own` worse than `severity`, and `ownMessages` without `own` or with a non-string entry.
- Hover lists at most 20 messages, then `…and N more`. Box class and codicon come from the pure `markerClass` / `markerIcon` helpers (`pipeline-node-error` / `pipeline-node-warning`, `codicon-error` / `codicon-warning`).
- Sizing: every box is `box-sizing: border-box` at 100% of ELK's size, so the 2px border never changes the box size. The extra inner pixel is given back (component padding `3px 23px 3px 7px`, a `-1px` margin on group headers, summaries and route captions), so labels and captions do not shift.
- `sentStatus` is recorded only after a post succeeds (`postMessage` resolves true), on the snapshot path too. When the document has left `workspace.textDocuments`, a sent non-empty status is cleared with `nodeStatus {byId: {}}`.
- Known, transient: Red Hat's published ranges are not shifted by an edit, so until Red Hat republishes (debounced, well under a second) one of its markers can sit one node off. No fix.
- Test harness: `useSchemaBinary({ lintFindings })` gives the graph suite's fake 4.112.0 binary a grep-based lint (`nope:` / `codec:`). SAME, FROZEN and NO_PANEL use a second `GraphPanels` with fake diagnostics.
- The lint clear on the first edit fires `onDidChangeDiagnostics` inside the same `onDidChangeTextDocument` dispatch, before the panel's own change handler runs. The resulting `nodeStatus` can therefore come just before that edit's `model`. Both use the same document version, so the ids match.

## Plan Change Log

## Review Triage Log

Iteration 0 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment).

| # | Finding | Lens | Disposition |
|---|---|---|---|
| 1 | An expanded group or route marked by `own` lists its descendants' messages on hover; README says its own | intent, edge | **patch**: additive `ownMessages?` (present with `own`), used for expanded containers |
| 2 | The validator accepts an `own` worse than `severity` | blind | **patch** |
| 3 | `diagnosticsChanged` returns early when the document is closed, so stale lint markers stay | blind, edge | **patch**: clear to `{}` |
| 4 | `sentStatus` is set before the post | blind | **patch**: set after a successful post |
| 5 | One null diagnostics entry makes the outer catch drop every marker | edge | **patch**: filter non-objects |
| 6 | No cap on hover size | blind | **patch**: 20 messages, then "…and N more" |
| 7 | No rendering test for the box class or icon | verification-gap | **patch**: pure `layout.ts` helpers with tests; DOM rendering stays untested (no DOM harness, same as 3.4–3.7) |
| 8 | The 2px border may clip labels or captions | blind | **patch**: check and compensate |
| 9 | CSS comment typo; fake lint pattern unescaped; README "exactly as the Problems panel" | blind | **patch** |
| 10 | Red Hat ranges are not shifted by edits, so a marker can briefly sit on the wrong node | blind, edge | **defer**: known and transient until Red Hat republishes; noted in code and Implementation Notes |
| 11 | A lint finding on a blank line maps to the parent or nowhere | edge | **reject**: lint reports fields, not blank lines; the plan already keeps the line start |
| 12 | Unmapped findings are silently dropped | blind | **reject**: UNMAPPED by design; the Problems panel still shows them |
| 13 | Screen-reader access to the messages | blind | **reject**: out of scope (entry 11) |
| 14 | Icon contrast on a selected node | blind | **defer**: to the 3.12 sweep's visual check |

## Verification

**Commands (2026-10-09, after the review patches):**
- `npm run compile` and `npm run lint`: exit 0.
- `npm test`: 607 passing on stable 1.141.0 and on 1.100.0, including the 3.8 suites (core/nodeStatus, statusDiagnostics, SEND / CLEAR, SAME / FROZEN / SNAPSHOT).
- `npm run test:webview`: 92 passed.
- `npm run test:corpus`: 123 passed.

**Manual checks:**
- In the dev host with the user's `rpk connect` on a copy of `graph-demo.yaml`:
  - add a typo field to a processor and a deprecated field, then save: the markers appear with icons and hover text;
  - collapse the group around the typo: the header shows the error;
  - type a character: the lint markers clear.
