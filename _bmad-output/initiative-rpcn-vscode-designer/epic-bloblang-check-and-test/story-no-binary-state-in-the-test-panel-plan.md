---
title: 'No-binary state in the test panel'
type: 'feature'
ticket: '15'
created: '2026-10-14'
status: 'built'
baseline_revision: 'd1a4cd393c77617ee870503ec0d81ec812a234f5'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/initiative-rpcn-vscode-designer/brief-rpcn-vscode-designer/bloblang-test-panel-prototype.html']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** With no usable binary, the test panel shows 4.8's generic "The test could not run" card ("No Redpanda Connect binary."). It offers no way to fix the binary, and it does not recover by itself once a binary is found (E4 R7, Done when 4).

**Approach:** The host sends the binary's status to every test panel on each change and handles the three binary actions the protocol already defines, reusing the graph's `BinaryActions`. The webview shows the prototype's no-binary state while the status is not `ok`, and runs its current input once when the status becomes `ok`.

## Boundaries & Constraints

**Always:**
- **Status:**
  - Any status other than `ok` (`missing`, `invalid`, `unresolved`) is the no-binary state.
  - The snapshot's `binary` sets the state when the panel opens.
  - The host posts `{type:'binary', status}` to every open test panel each time `RedpandaConnect.onDidChange` fires.
- **State (webview):**
  - The header (title and kind) stays. The status pill, the toolbar and the Input/Output columns are hidden.
  - A region named "No Redpanda Connect binary" shows the bold title "No Redpanda Connect binary" and the text "The test panel runs mappings with your own binary, so results match the version you deploy." (prototype).
  - The region has the buttons **Install guide**, **Set path** and **Retry**, in that order. They post `installGuideRequested`, `setPathRequested` and `retryRequested`.
  - The input (content, metadata rows, tabs, Run on change) is kept in ViewState and comes back unchanged.
  - Nothing runs while in this state: no debounce run, and no restored run on open.
  - It is announced once in the polite live region on entry.
- **Actions (host):** each button calls the same `BinaryActions` method the graph uses (`installGuide`, `setPath`, `retry`), so the notifications, the setting scope and the output log are exactly the graph's.
- **Recovery:**
  - When the status changes from not `ok` to `ok`, the webview leaves the state and runs its current input once.
  - The run happens whether Run on change is on or off, so the panel is not left empty.
  - Empty content runs nothing (the empty state, as today).
  - The panel is not reopened.
  - A status that goes `ok` → `ok`, or not `ok` → not `ok`, runs nothing.
- **Lost binary:** when a binary goes from `ok` to missing, the panel enters the state. The last result is not shown, and it comes back only through the run that follows recovery.
- **Unchanged:**
  - The host's no-binary guard in `runMappingTest` stays. It is the result for a run that races a binary loss, and 4.8's `error` card shows it.
- **AI-8:**
  - EXPERIENCE gains a "Bloblang test panel: no binary" row.
  - The "run could not happen" row no longer says "until the no-binary state".
  - CHANGELOG is updated.

**Never:**
- protocol changes beyond what `bloblangProtocol.ts` already defines;
- changes to `BinaryActions`, to the graph panel's empty state, or to binary detection;
- new notifications;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OPEN_MISSING | open a panel with the binary missing | the snapshot has `binary: 'missing'`; the state is shown; no `run` is posted | none |
| GUIDE / SET_PATH / RETRY | press each button | the matching `BinaryActions` method is called once | a failing action is logged, not thrown |
| RECOVER | Set path to a working binary | `binary ok` is posted; the panel posts one `run` with its current input and shows the result, without reopening | none |
| RECOVER_TOGGLE_OFF | Run on change off, then recovery | one run anyway | none |
| WITH_GRAPH | graph and test panel open on the same file, then recovery | the graph renders and the test panel runs; each heard the change once | none |
| LOST | binary lost while a result shows | the state is shown, the result is hidden; on recovery, one run | none |
| UNCHANGED | Retry leaves the state missing | nothing posted to the webview changes, and no run | none |
| EDIT_WHILE_MISSING | edits to the mapping or the input while missing | no run; the input is kept | none |

</frozen-after-approval>

## Code Map

- `src/adapters/bloblangPanel/panels.ts`:
  - `BloblangPanelsOptions` (:~86) widens `binary` to `{state, onDidChange}` and adds `actions: BinaryActions | undefined`, as `GraphPanels` has (`src/adapters/graphPanel/panels.ts:84,93`).
  - Subscribe to `onDidChange` in the constructor's disposables and post `{type:'binary', status: binaryStatus()}` to each panel.
  - `receive` (:122) handles `installGuideRequested`, `setPathRequested` and `retryRequested` as `GraphPanel` does (`graphPanel.ts:122-127`).
  - Drop the deferral line in the header comment (:10-11).
- `src/extension.ts:198-204` -- pass `actions: redpandaConnect.actions` (as at :183-195). `redpandaConnect` already has `onDidChange`.
- `src/adapters/redpandaConnect/notify.ts:96-104` -- the `BinaryActions` type. Reuse it; don't change it.
- `src/shared/bloblangProtocol.ts:80-112` -- `binary` and the three button messages already exist and are parsed. No change.
- `webview/src/bloblang/TestPanel.tsx`:
  - the message handler (:167-191) handles `binary`;
  - add a `binary` state seeded from the snapshot;
  - gate `runNow` and `schedule` and the restored run;
  - run once on the not-`ok` → `ok` transition, using `latest.current`;
  - render the no-binary view instead of the pill, the toolbar (:242) and `rpcn-bl-io` (:250);
  - announce it through the existing live region.
  - Update the header comment (:10).
- `webview/src/state.ts:50-54` -- `NO_BINARY_ACTIONS` (labels and messages). Import it, or mirror it in `webview/src/bloblang/`, whichever the bundle allows. The graph's `EmptyStateView` (`webview/src/main.tsx:80`) is the model for markup and keyboard handling. The CSS goes in `bloblang.css`, with theme tokens only.
- Tests:
  - `src/test/integration/suites/90-bloblang-panel.ts`:
    - replace `NO_BINARY` (:491) with the matrix;
    - use `loseBinary`, `restoreBinary`, `fakeActions` and `testPanels` from `src/test/integration/graphHelpers.ts:118-165`, as `83-graph-empty-states.ts` does;
    - WITH_GRAPH uses the real `GraphPanels` from `api()`.
  - `webview/src/bloblang/TestPanel.test.tsx`:
    - replace 'samples and binary messages change nothing' (:478) with the state, the buttons, the recovery runs (toggle on and off), LOST, UNCHANGED and EDIT_WHILE_MISSING;
    - the fixture `src/test/fixtures/bloblang/binary-missing.json` already renders through `FIXTURE_NAMES`.
- Docs:
  - `_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md`: add the new row after :116 and edit :116;
  - `CHANGELOG.md` `[Unreleased]`: a "Bloblang test panel: …" bullet.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/bloblangPanel/panels.ts`, `src/extension.ts` -- the binary subscription and the actions.
- [x] `webview/src/bloblang/TestPanel.tsx`, `bloblang.css` -- the state, the gating and the recovery run.
- [x] `src/test/integration/suites/90-bloblang-panel.ts`, `webview/src/bloblang/TestPanel.test.tsx` -- the matrix.
- [x] `EXPERIENCE.md`, `CHANGELOG.md` -- the docs.

**Acceptance Criteria:**
- Given the dev host with no rpk on PATH, when the user opens a test panel, then the no-binary state shows. When they press Set path and pick the real binary, the panel runs its input and shows the output without being reopened.
- Given the change, when `npm run compile`, `npm test` (stable), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- Mirrored `NO_BINARY_ACTIONS` in `TestPanel.tsx` (typed with `BloblangWebviewMessage`) rather than importing `webview/src/state.ts`, which is typed on the graph protocol.
- The test panel had no always-mounted polite region (only the Output column's `aria-live`, which the state hides), so a visually hidden `role="status"` region (`.rpcn-bl-sr`) carries the one announcement on entry.
- A `result` that arrives while the status is not `ok` is dropped (only clears Running…), so a lost result comes back only through the recovery run. A recovery seen through a later snapshot (not `ok` → `ok`) also runs once.
- `loseBinary` / `restoreBinary` in `graphHelpers.ts` gained optional `folder` / `binary` parameters (defaults unchanged), so suite 90 can use them with its own fake binary without `useGraphSuite`. Suite 90 uses a BloblangPanels of its own with `fakeActions` (the extension's has the real picker); `testPanels` was not needed (WITH_GRAPH uses `api().graphPanels`). RECOVER_TOGGLE_OFF is covered in the webview tests only (the host cannot tell).

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 1 medium, 4 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | After ok → missing, the YAML end-of-line hint of a `failed` result stays, though the panel hides that result | medium | patch | `binaryChanged` only posts `binary`; the hint clears only on another result, an edit or close, and no run happens without a binary. Now `binaryChanged` clears the hint when the status is not `ok`. Suite 90 LOST asserts no hint ranges after the loss. |
| 2 | Keyboard focus falls to `<body>` when the state starts or ends; the region has no `tabIndex` (the graph's `EmptyStateView` is the plan's keyboard model) | low | patch | The focused textarea or button unmounts on the switch. Keyboard use is in R10. The region now has `tabIndex 0` and takes focus on entry when focus was in the panel; on recovery, focus moves back to the input. Webview tests added. |
| 3 | WITH_GRAPH doesn't check that the test panel heard the change once | low | patch | Test-only. It now asserts exactly one `binary ok` post. The graph's `hostStatus` may come twice by design (the binary change, then the schema settling), so that assertion stays as it was, with a comment. |
| 4 | Integration RECOVER posts the run itself, so it doesn't see the webview's recovery run | low | reject | Integration handles don't execute the webview script. The run on the not `ok` → `ok` change is webview logic, covered by the vitest RECOVER tests (toggle on and off). The host side, `binary ok` then a run with no reopen, is asserted. The real path is the user's manual check. |
| 5 | The header comment in `TestPanel.tsx` has an over-long, unwrapped line | low | patch | Re-wrapped. |

## Verification

**Results (2026-10-14, after the review patches):** `npm run compile` exit 0; full stable suite (VS Code 1.141.x) 758 passing; `npm run test:webview` 206; `npm run test:corpus` 129. Floor not run (user decision). Manual check (the user, dev host with no rpk on PATH): the no-binary state, Install guide, Retry, Set path to the real binary running the panel without reopening it with the graph rendering, and keyboard focus: no issues.

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm test` (stable is the target), `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- Dev host with no rpk on PATH (memory: a bad `binaryPath` alone is not enough). Open a test panel and see the state. Install guide opens the docs. Set path to the real binary runs the panel without reopening it, and the graph renders too.
