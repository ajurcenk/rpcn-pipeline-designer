---
title: 'Keyboard and screen-reader model for the test panel'
type: 'feature'
ticket: '11'
created: '2026-10-16'
status: 'ready-for-dev'
baseline_revision: ''
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The test panel's controls are native and reachable, but it has no keyboard model or screen-reader model (E4 R10):
- **Names:** the panel and its toolbar have no accessible names.
- **Tabs:** they don't follow the tabs pattern.
- **Leaving the panel:** there's no key to get back to the YAML editor.
- **Announcements:** results and errors are announced inconsistently. The output column is a non-atomic live region, error cards are assertive `alert`s, and the status pill is a separate `status`.
- **Visuals:** some elements have no focus ring, and high contrast has no borders.

**Approach:**
- One polite announcer for every result and state.
- The ARIA tabs pattern on the Content/Metadata tabs.
- Esc to return to the YAML.
- Names on the panel and its regions.
- Focus rings and contrast borders on every element, from theme tokens.
- EXPERIENCE's Accessibility Floor and DESIGN gain the panel.

## Boundaries & Constraints

**Always:**
- **Names:**
  - `main` is named `Bloblang test panel: <title>`.
  - The toolbar is `role="group"` named "Test controls".
  - The Input and Output sections keep their names.
  - The output `<pre>` (Content) is focusable (`tabIndex 0`), so it can be read and scrolled by keyboard.
  - The removed region is focusable like the no-binary one, and takes focus on entry the same way (focus in the panel moves to it, and back when it clears).
- **Tabs (each column):**
  - Only the selected tab is in the Tab order.
  - Left/Right move to the other tab and select it; Home/End go to the first and the last.
  - The tabpanel is named by its tab.
- **Esc:**
  - From anywhere in the panel, Esc with no modifier returns focus to the YAML editor, in its group with the cursor unchanged. It uses a new webview → host message `focusEditorRequested` (the graph's name).
  - **Exceptions:** the rename field (Esc cancels, as today) and an open `<select>`.
- **Announcer:** one always-mounted polite atomic region (the existing `rpcn-bl-sr`). Each announcement replaces the last; a text equal to the previous one is not announced again.
  - **Wording:**
    - ok: `Ran in <N> ms. <changes>`, where changes are the footer's tags in words ("added total, changed b") or "No changes";
    - deleted: `The mapping deleted this message`;
    - parse error: `Syntax error, mapping line L: <message>`;
    - failed: `Failed on mapping line N: <message>`, or `The mapping failed on this input: <message>`;
    - invalid input: `Input not valid for this mapping: <message>`;
    - error: `Not run: <message>`;
    - plus the existing no-binary and removed texts.
  - **Removed roles:** `aria-live` comes off the Output section, `role="status"` off the pill, and `role="alert"` off the result cards, so nothing is announced twice. The samples and rename errors keep `role="alert"`; they answer the user's own action.
- **Focus ring:** every focusable element shows `outline: 1px solid var(--vscode-focusBorder)` on `:focus-visible`. Nothing removes outlines.
- **High contrast:** pills, cards, notices, columns and buttons add `1px solid var(--vscode-contrastBorder, transparent)`. Only theme tokens are used (style test TOKENS).
- **Docs (AI-8):**
  - EXPERIENCE's Accessibility Floor gains the test panel (names, keyboard model, announcer, focus, contrast, no colour-only change marks), plus a keyboard row next to the graph's;
  - DESIGN gains the test-panel components and their tokens;
  - AD-5 lists `focusEditorRequested` for the panel;
  - CHANGELOG is updated.

**Never:**
- changing what the panel shows or does (states, wording on screen, runs);
- a new dependency (no testing-library);
- host changes beyond handling `focusEditorRequested`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| TAB_WALK | Tab through a panel with samples and a result | stops in order: sample picker, New, Rename, Delete, Run on change, Run, input tab, content, output tab, output content, Go to line (when shown) | none |
| TABS_ARROWS | Right on Content, Home/End | Metadata selected and focused; first/last | none |
| ESC | Esc in the textarea, on Run, in the output | `focusEditorRequested` posted | none |
| ESC_RENAME | Esc in the rename field | rename cancelled; nothing posted | none |
| NAMES | panel rendered | `main`, toolbar, columns, tabpanels and controls have the names above | none |
| LIVE_OK | ok result with +total ~b | announcer: "Ran in 12 ms. added total, changed b" | none |
| LIVE_ERROR | parse error, mapping error, invalid, not run | each wording above; no `alert`/`status` on the cards or the pill | none |
| LIVE_REPEAT | the same ok result twice | announced once | none |
| REMOVED_FOCUS | focus in the panel, processor removed | focus on the removed region; back when restored | none |
| FOCUS_CSS | stylesheet | every focusable selector has a `:focus-visible` ring; contrast borders present; tokens only | none |

</frozen-after-approval>

## Code Map

- `webview/src/bloblang/TestPanel.tsx`:
  - structure (543-651): `main`, toolbar (565), sections (596, 629), the `rpcn-bl-sr` region (552-554) and the pill (549);
  - `ColumnHead` tabs (146-158);
  - the removed (557) and no-binary (179) regions;
  - the focus helpers from 4.15 (keep them);
  - an announcement function from the result kinds (reuse `changeTags` from `changes.ts` for the ok text).
- `webview/src/bloblang/OutputView.tsx` -- `ErrorCard role="alert"` (73), `<pre>` (42), the stale section (157).
- `webview/src/bloblang/SamplePicker.tsx` -- the rename field's Esc (111-118) must not reach the panel's Esc handler (stop propagation).
- `webview/src/bloblang/MetadataTable.tsx` -- names are already there; only the focus rings.
- `webview/src/bloblang/bloblang.css` -- the focus rings (189-192, 412-418, 528-530) and contrast borders. The graph's pattern is in `webview/src/graph.css:29,259`.
- `src/shared/bloblangProtocol.ts` (+ test) -- `focusEditorRequested`.
- `src/adapters/bloblangPanel/panels.ts` -- handle it like `goToLine`'s editor reveal without moving the cursor (`showTextDocument` in the YAML's group, `preserveFocus: false`).
- Tests:
  - `webview/src/bloblang/TestPanel.test.tsx` -- a new describe, "keyboard and screen reader (4.11)". Use the `press` / `tabStops` / `live` helpers from `webview/src/keyboard.test.tsx:59-74` (copy or share).
  - `webview/src/style.test.ts:93-105` -- FOCUS extended to `bloblang.css`, plus a contrast-border check.
  - Suite 90 -- one integration test: `focusEditorRequested` focuses the YAML editor.
- Docs:
  - `_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md` (Accessibility Floor 132-142, keyboard 128);
  - `DESIGN.md` (components and tokens near 23-121);
  - the architecture's AD-5 (line 80);
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [ ] Protocol + host `focusEditorRequested` + tests.
- [ ] `TestPanel.tsx`, `OutputView.tsx`, `SamplePicker.tsx` -- names, tabs, Esc, announcer, roles.
- [ ] `bloblang.css` -- focus rings, contrast borders.
- [ ] Webview and style tests -- the matrix.
- [ ] Docs.

**Acceptance Criteria:**
- Given the dev host with a screen reader or the keyboard only, when the user tabs through the panel, switches tabs with the arrows, runs a mapping with an error, and presses Esc, then every control is reached with a visible ring, the result and error are announced once, and focus returns to the YAML.
- Given the change, when `npm run compile`, `npm test` (stable, under `xvfb-run -a`), `npm run test:webview` and `npm run test:corpus` run, then all pass.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable`, `npm run test:webview`, `npm run test:corpus` -- expected: all pass.

**Manual checks:**
- Dev host: the keyboard walk and Esc in Dark+ and High Contrast. Optionally Orca for the announcements.
