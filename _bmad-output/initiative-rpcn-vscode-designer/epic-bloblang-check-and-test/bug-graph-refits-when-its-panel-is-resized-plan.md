---
title: 'Graph refits when its panel is resized'
type: 'bugfix'
ticket: '19'
created: '2026-10-20'
status: 'built'
baseline_revision: 'a9b5df27084dc45729e5ba055c75625a4c1194ad'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/bug-graph-refits-when-its-panel-is-resized.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The graph is fitted once, to the panel size at its first layout, and never again. When a test panel opens below it (4.17), the graph panel's height halves and the nodes end up below the visible area, so the canvas looks empty. Dragging a divider has the same effect.

**Approach:** The graph webview watches its container's size. After the size settles, it refits with the first fit's rule, unless the user has moved the view since the last fit. The "moved by the user" mark is kept with the saved viewport.

## Boundaries & Constraints

**Always:**
- **The ticket's acceptance criteria 1-5 are the contract:**
  1. **Refit when untouched:** with no user move since the last fit or restore, a size change refits, using `fitReadable` at once.
  2. **The user's view is kept:** after a move started by user input, a resize leaves the viewport alone. This survives a recreated webview.
  3. **Fit to view resets:** Fit to view sets the view as untouched again.
  4. **Nothing to fit:** a resize does nothing before the first placement.
  5. **One refit per resize:** refits are debounced, one after the size settles. The delay is about 150 ms.
- **What counts as a user move:** `onMoveStart` / `onMove` with a non-null event, meaning pointer, wheel or touch. A fit, a restore, or the reveal of a focused node (keyboard navigation) is not a user move.
- **The mark is saved** in the view state next to `viewport` (`saveViewState`), and read at mount with the saved viewport.
- **A restored viewport** counts as untouched when it was saved without the mark.
- **The refit's width** uses the container's new width, where the first fit uses `window.innerWidth`; in a webview both are the panel's width.
- **Reduced motion:** refits are already instant (no animation), so reduced-motion settings need no special handling.

**Never:**
- changing the first-fit or restore rules, `MIN_FIT_ZOOM`, or `fitReadable`'s behaviour;
- host or protocol changes;
- a new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SPLIT | fitted graph, container height halves | one refit after the settle; nodes in view | none |
| USER_MOVED | user drags or wheels, then resize | viewport unchanged | none |
| REVEAL | keyboard reveal pans, then resize | refit (a reveal isn't a user move) | none |
| FIT_RESET | user moved, Fit to view, resize | refit | none |
| BEFORE_FIRST | resize before any laid-out model | nothing | none |
| DRAG | ten size changes in 100 ms | one refit | none |
| RECREATED | mark saved, webview recreated, resize | viewport kept | none |

</frozen-after-approval>

## Code Map

- `webview/src/Graph.tsx`:
  - `fitReadable` (~67);
  - the first placement (`firstView`, `placed`, `savedViewport`, ~117-134);
  - `onMoveEnd` saving the viewport (~325);
  - `reveal` (~170), which pans by calling the instance, with no event;
  - Fit to view, if a button exists there. Find it with `fitView` or the "Fit" label in `webview/src/main.tsx` / `Graph.tsx`. If there is no such action, criterion 3 applies to whatever fit action exists, and if none exists, note that in Implementation Notes.
  - Add a `ResizeObserver` on the container ref (`container`, ~145) with a debounce timer, a `userMoved` ref, and the view-state field.
- `webview/src/` view state (`loadViewState` / `saveViewState`, find its module) -- the new optional `userMoved` field.
- `webview/src/test-setup.ts:32` -- the `ResizeObserver` stub. Tests need a controllable one: replace it per test, with a `trigger(size)`.
- Tests: the Graph webview tests (find the existing `Graph` or keyboard tests, for example `webview/src/keyboard.test.tsx` or `graph.test.tsx`). Cover the matrix with a fake timer and a spy on `fitView` / `setViewport`.
- Docs:
  - `_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md`, the graph's pan/zoom line (~127) or the layout paragraph: refits on resize until the user moves the view;
  - `CHANGELOG.md` ("Fixed").

## Tasks & Acceptance

**Execution:**
- [x] `Graph.tsx` + view state -- resize watch, debounce, user-move mark.
- [x] Webview tests -- the matrix.
- [x] EXPERIENCE, CHANGELOG.

**Acceptance Criteria:**
- Given the dev host with the graph open, when the user opens a test panel below it, then the graph's nodes are visible without panning, and a view the user has panned stays where they put it after another resize.
- Given the change, when `npm run compile`, `npm run test:webview`, the stable suite under `xvfb-run -a` and `npm run test:corpus` run, then all pass.

## Implementation Notes

- **Fit to view button added** (review, decision recorded as an assumption 2026-10-20): no fit action existed, so once the user moved the view nothing could clear the mark. A small `codicon-screen-full` button (`.rpcn-fit-view`, bottom-right of the canvas, theme tokens, `focusBorder` ring, `contrastBorder` outline, `aria-label` and `title` "Fit to view") is rendered after the graph container, outside the graph region, so it is the next Tab stop and never joins the nodes' roving Tab model. It shows once a graph with nodes is drawn and calls the same `fit()` helper as the first fit and the refits, which clears the mark (`userMoved: false`) before `fitReadable`. No host or protocol change.
- `ViewState.userMoved?: boolean` in `webview/src/host.ts`, parsed in `loadViewState` (non-boolean dropped). It is saved on every `onMoveEnd` next to `viewport`, and as `false` on each fit. At mount the mark is read only when a viewport was saved, so a viewport saved without it is untouched.
- User move = `onMoveStart` / `onMove` with a non-null event. A fit, restore and `reveal` (`setCenter`) move with a null event, so they never set it.
- The resize watch is a `ResizeObserver` on the container, created once the instance exists. Its first report (browsers send one on `observe`) is the baseline, never a change; later reports of the same size are ignored. (Seeding from the rounded `clientWidth` / `clientHeight` instead made a fractional first report look like a change at a non-integer zoom, refitting over a restored viewport after mount; fixed in review.) It debounces 150 ms (`REFIT_DELAY`), then refits with `contentRect.width` only if placed, untouched, and the size is non-zero (a hidden panel with a 0 size does not fit to nothing; the next real size refits).
- `test-setup.ts`: happy-dom 20 has its own `ResizeObserver` (which reports nothing), so the old stub was never installed. The controllable stub is now always installed, with `globalThis.resizeStub.trigger(element, size)`; like a browser it reports each observed element once after `observe` (a microtask later), with a fractional size (800.5 × 600.25).
- Tests: new `webview/src/resize.test.tsx` (14 tests: every matrix row, FIT_RESET as user move → Fit to view → resize → refit, the button's name, title, place in the Tab order and fit, no button before a graph, same size reported again, a restored viewport not refitted after mount, and a viewport restored without the mark). React Flow is wrapped via `vi.mock` only to count `fitView` / `setViewport` on the real instance and to call the move callbacks with or without an event; happy-dom has no layout to drive d3-zoom with real input. A mutation check (mark disabled, debounce removed) fails 4 and 1 tests respectively.
- Not done here: the manual dev-host check (open a test panel below the graph and see the nodes).

## Plan Change Log

- Review iteration 0 (patch, assumption 2026-10-20; the user declined the question and said to continue, so the recommended option was taken): the graph had no Fit to view action, so criterion 3 couldn't be met and one pan disabled refitting for good. A small Fit to view button in the graph panel (codicon, keyboard reachable, theme tokens) now calls the shared `fit()` helper. No host or protocol change. Reversible if the user prefers another option (a reset on a new layout, or dropping criterion 3).

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 2 medium, 1 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Nothing can clear the user-move mark (there is no Fit to view action), so criterion 3 is unmet, one pan disables refitting for good, and the docs promise a "next fit" | medium | patch (assumption, see Plan Change Log) | A Fit to view button calls `fit()`. Docs updated. |
| 2 | The FIT_RESET test doesn't test a reset | low | patch | Rewritten: user move, Fit to view, resize, refit. |
| 3 | The first ResizeObserver report (fractional `contentRect`) is compared with the rounded `clientWidth`/`clientHeight`, so a refit fires after mount and overwrites a restored viewport | medium | patch | The first observer report is now the baseline. The stub reports on `observe` with a fractional size. Test added. |
| 4 | The AC 1 manual check and the full suites aren't recorded | false | reject | The manual check is the user's, after the review. Suite results are recorded at the built step. |

## Verification

**Results (2026-10-20, after the review patches):** `npm run compile` exit 0; `npm run test:webview` 302; `npm run test:corpus` 156; full stable suite under `xvfb-run -a` 849 passing. Manual check (the user, dev host, real rpk): the graph refits when a test panel opens below it, a panned view is kept, Fit to view fits and turns refitting back on (the assumption accepted), a divider drag refits once it settles: no issues.

**Commands:**
- `npm run compile`; `npm run test:webview`; `npm run pretest && xvfb-run -a npx vscode-test --label stable`; `npm run test:corpus` -- expected: all pass.
