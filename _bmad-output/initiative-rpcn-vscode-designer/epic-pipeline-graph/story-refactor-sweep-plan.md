---
title: 'Refactor sweep'
type: 'refactor'
ticket: '12'
created: '2026-10-12'
status: 'done'
baseline_revision: '5bff0442f9b501d903904575588a10868f5037d8'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 3 left its graph adapter and its integration suite as two files of over 1,100 lines each. It also left a repeated document lookup, mixed ticket names in comments, two deferred review findings, and epic notes that are already answered. Entry 12's verify requires every deferred finding to be fixed or moved to a new ticket.

**Approach:** a fixed list of cleanup items, each its own commit, and behaviour-neutral throughout.
- No change to settings, commands, messages, text, ARIA names or graph output.
- Green after every item, and the test count stays the same or rises.
- New scope becomes backlog stories, not code.

**The items:**
1. **Split `src/adapters/graphPanel/panels.ts`** (1,111 lines) by responsibility, in the style of 2.12. `GraphPanel` moves to its own file. The status mapping (`statusDiagnostics`, `hostStatusOf`, `catalogueOf`) goes to its own file, and so do the tab and rename helpers (`renamedKey`, `within`, `hasTextTab`, `isTextTabOf`, `until`). `GraphPanels` stays in `panels.ts`, and so does every name tests and `extension.ts` import from it (re-exported where needed). Layering lint still passes.
2. **One document lookup:** the four `workspace.textDocuments.find((d) => d.uri.toString() === key)` copies become one helper.
3. **Split `src/test/integration/suites/80-graph.ts`** (1,243 lines) into per-feature suites:
   - panel, model and live updates;
   - navigation;
   - markers;
   - empty states;
   - auto-open, Hide and rename;
   - keyboard host side.

   The shared helpers (`open`, `withGraph`, `showGraph`, `testPanels`, `fakeDiagnostics`, `fakeActions`, `fakeMemento`, `withAutoOpen`, `autoOpened`, `loseBinary`, `restoreBinary`) move to one graph-helpers module. The suites keep their order in `index.test.ts`. Every test keeps its name.
4. **Ticket names:** "ticket 11" and a bare "11" become "ticket 3.11" in comments and in the suite title, as the rest of the epic writes them.
5. **`slotsIn`** (`src/core/catalogue.ts`): replace the unclear dedupe idiom with a readable one (3.3 triage row 16), with the same result.
6. **Epic notes** (`epic-pipeline-graph.md`): mark the second-`activate()` open question answered (decision 2026-10-08), and the "Show Graph" title conflict resolved (sentence case shipped in 3.10).
7. **README and CHANGELOG checked against the code:** every graph claim matches behaviour. Fix only wording that is wrong.
8. **Deferred findings:**
   - **Red Hat range lag** (3.8 row 10): becomes backlog story 13, "Node markers wait for Red Hat to republish after an edit". This is new scope.
   - **Selected-node icon contrast** (3.8 row 14): handed to entry 13's checks by hand. This plan's Implementation Notes record it for 3.13.
   - **`pendingRenames` after an aborted rename** (3.10 row 7, rejected): becomes backlog story 14.

## Boundaries & Constraints

**Always:**
- Moves only (no rewritten logic) in items 1 and 3; imports updated; `npm run compile` (types, layering lint, build) is clean.
- Green after each item: `npm test` (stable and 1.100.0), `npm run test:webview`, `npm run test:corpus`.

**Never:**
- behaviour changes, new features, or new dependencies;
- splitting `webview/src/layout.ts` or `src/core/graph.ts` (they cause no named harm);
- merging the test poll helpers across test layers;
- editing `tickets.toml`.

</frozen-after-approval>

## Code Map

- **`src/adapters/graphPanel/panels.ts`:**
  - `GraphPanel` runs from about l.108 to 497;
  - the loose helpers are `statusDiagnostics`, `hostStatusOf`, `catalogueOf`, `renamedKey`/`within` (~l.570), `until` (:599) and `hasTextTab`/`isTextTabOf`;
  - `GraphPanels` runs from about l.630 to 1111;
  - the document lookups are at about :253, :282, :405 and :998;
  - importers are `src/extension.ts` and the tests (`80-graph.ts`, `src/test/adapters/graphPanel/nodeStatus.test.ts`).
- **`src/test/integration/suites/80-graph.ts`:** local helpers listed in item 3; `index.test.ts` lists the suites in order; the shared helpers go in `src/test/integration/helpers.ts` (41 lines) or a new graph helpers file beside it.
- **"ticket 11" references:**
  - `webview/src/{host.ts:13, main.tsx:7, state.ts:12, Graph.tsx, layout.ts:277,536, graph.css:333,349, test-setup.ts:1}`;
  - `panels.ts:28,457`;
  - the suite title at `80-graph.ts:16`.
- **`src/core/catalogue.ts`:** `slotsIn`.
- **Backlog format:** `_bmad-output/backlog/story-*.md`; the last one is story 12.
- **The 2.12 pattern:** `epic-smart-yaml-editing/story-refactor-sweep-plan.md`. Implementation Notes keep a "# | Commit | What changed" table.

## Tasks & Acceptance

**Execution:**
- [ ] Items 1 to 8 in that order, one commit each, with the full checks run after items 1 and 3 and the webview checks after the rest.
- [ ] Implementation Notes: the commit table, the test counts before and after, and the hand-off of item 8 to 3.13.

**Acceptance Criteria:**
- Given the sweep is done, when the suites, the corpus harness and CI run, then they pass with at least as many tests as before (627 / 128 / 123), and no file of the graph adapter is over 600 lines.
- Given entry 12's verify, when the plan is read, then each deferred finding is fixed, or moved to a backlog story or entry 13's checks by hand, with a named target.

## Implementation Notes

One commit per item, in the approved order:

| # | Commit | What changed |
|---|---|---|
| 1 | c668fe2 | `src/adapters/graphPanel/panels.ts` (1,111 lines) split: `GraphPanel`, `GraphPanelHandle` and `MAX_POSTED` to `graphPanel.ts` (425); `statusDiagnostics`, `hostStatusOf`, `catalogueOf`, `GraphBinary` and `GraphSchema` to `status.ts` (78); `Rename`, `within`, `renamedKey`, `until`, `hasTextTab` and `isTextTabOf` to `tabs.ts` (56). `GraphPanels` stays in `panels.ts` (585), which re-exports every name it exported before. Moves only (`export` added where a moved name is now imported). |
| 2 | 6de7619 | `openDocument(key)` in `tabs.ts` replaces the four `workspace.textDocuments.find(…)` copies (three in `GraphPanel`, one in `GraphPanels.open`). |
| 3 | 38ab12d | `src/test/integration/suites/80-graph.ts` (1,243 lines) split into `80-graph-panel` (panel, model and live updates), `81-graph-navigation`, `82-graph-markers`, `83-graph-empty-states`, `84-graph-auto-open` (auto-open, Hide and rename, with the contributions test) and `85-graph-keyboard` (KEYBOARD and ESC), imported in that order in `index.test.ts`. The suite setup (temp folder, activation, fake binary with lint findings, schema wait, close-all teardown) is `useGraphSuite()` in `src/test/integration/graphHelpers.ts`, with the listed helpers and the shared constants (`VALID`, `SWITCH`, ids, `live`, `settle`, `insert` …). The 45 test blocks are byte-identical copies, generated by script, which checked each one is placed exactly once. |
| 4 | 63223c0 | "ticket 11" becomes "ticket 3.11" in comments in `src/` (graph adapter, `protocol.ts`), `webview/src/` and `eslint.config.mjs`, and the keyboard suite title says 3.11. |
| 5 | 3005341 | `slotsIn`: the `!seen.has(key) && seen.add(key) !== undefined` filter becomes an `if (seen.has(key)) return false; seen.add(key); return true;` filter, same result (corpus graph records unchanged). |
| 6 | d3aafc5 | E3 notes: the second-`activate()` open question **Answered (user, 2026-10-08)** (a manual check, entry 13), and the "Show Graph" title conflict **Resolved (3.10)** (sentence case shipped). |
| 7 | none | README and CHANGELOG graph claims checked against the code (commands and when clauses, auto-open conditions, Hide memory, lock, TAB_CLOSE, rename and Save As, the empty-state, banner and accessible-name strings, the 20-message hover limit, the 2px markers, the keyboard model, `setState` view state). Nothing was wrong, so no commit. |
| 8 | 49486a2 | Backlog story 13 "Node markers wait for Red Hat to republish after an edit" (3.8 row 10) and story 14 "The graph forgets a rename that never completes" (3.10 row 7). The `sendModel` comment names story 13. |

- **Hand-off to 3.13 (3.8 row 14):** check by hand the contrast of a marker's error / warning icon on a **selected** node (light, dark and high-contrast themes). Not checked in this sweep.
- **Test counts:** 627 integration tests (stable and 1.100.0), 128 webview, 123 corpus before and after.
- **Test names:** test and `describe` names that say "ticket 11" (`ESC (ticket 11): …`, and the webview `FOCUS`, `KEYBOARD` and `LIVE` describes) were left as they are, since every test keeps its name; item 4 changed comments and the suite title only.
- **Suite order:** the 3.10 contributions test now runs in the auto-open suite rather than first, and NO_SCHEMA with the empty states. Each suite sets up its own fake binaries and temp folder, as the 2.12 split did.

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 0 medium, 1 low, 0 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | One comment still says "Ticket 11" (`webview/src/layout.test.ts:360`), against item 4 and the Implementation Notes | low | patch | It is a comment, not a test name. Fixed in e0c3af6; the webview tests pass (128). |

## Verification

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass on stable and 1.100.0, 627 or more.
- `npm run test:webview` (128 or more) and `npm run test:corpus` (123, with no record changes): all pass.

**Results (2026-10-12):**
- Baseline at 5bff044: `npm test` 627 passing on stable and on 1.100.0; webview 128; corpus 123.
- After item 1 and after item 3: `npm run compile` exit 0; `npm test` 627 passing on both versions; webview 128; corpus 123, no record changes.
- After items 2, 4, 5, 6 and 8: `npm run compile` exit 0 and webview 128 (item 5 also corpus 123).
- Final run at 49486a2: `npm test` 627 passing on stable and on 1.100.0; corpus 123, no record changes; webview 128.
- Graph adapter file sizes: `panels.ts` 585, `graphPanel.ts` 425, `status.ts` 78, `tabs.ts` 56, `html.ts` 47 (none over 600).
- CI: not run (nothing pushed).
