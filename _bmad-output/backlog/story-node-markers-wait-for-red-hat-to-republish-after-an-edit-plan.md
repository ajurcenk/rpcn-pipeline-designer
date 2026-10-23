---
title: 'Node markers wait for Red Hat to republish after an edit'
type: 'bugfix'
ticket: '13'
created: '2026-10-23'
status: 'built'
baseline_revision: '82b16477d830db5c13b4ea384bba3cd26c56e14d'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The graph's node status (3.8, AD-17) maps the file's diagnostics onto every new model. YAML by Red Hat's diagnostics keep the ranges they were published with: after an edit, until Red Hat republishes (debounced, well under a second), the host maps those old ranges onto the edited text, so a Red Hat marker can sit on the wrong node (for example one node off after a node is inserted above it).

**Approach:** The view the graph reads (`LintDiagnostics.diagnosticsFor`, `src/adapters/vscode/diagnostics.ts`) holds Red Hat's diagnostics, shifted by the edits, until Red Hat republishes: their offsets are taken when Red Hat's set changes, moved through every content change after that (the helper the 4.10 panels use), and a diagnostic whose start lies in replaced or deleted text is left out. A change it cannot map, or a document version the shifts did not reach, leaves Red Hat's diagnostics out until Red Hat republishes. A marker then stays on its node through the edit, without a blink, and Red Hat's republish sends nothing new when it agrees. Lint's own findings (cleared on the first edit, AD-17), lint's suppression on lines Red Hat flags, the Bloblang diagnostics, the editor and the `nodeStatus` message are unchanged.

</frozen-after-approval>

## Implementation Notes

Oneshot: per-URI held Red Hat offsets in `LintDiagnostics`, shifted in its change listener (registered before the graph's), used by `diagnosticsFor`; unit tests in `diagnostics.test.ts`; an integration case in suite 82.

- `src/adapters/vscode/diagnostics.ts`: `HeldRedHat` per URI (Red Hat's set, the document version, offsets). `takeRedHat` on each diagnostics event retakes only when Red Hat's set is new; `shiftRedHat` on each content change maps the offsets with `mapRange` (`core/processorTracking`, the 4.10 helper), drops one whose start lies in replaced text, drops all on a change without offsets; `heldRedHat` gives Red Hat's at the held ranges, none when the version differs, Red Hat's own when nothing is held. `diagnosticsFor` and the view's change signature use it; lint's suppression keeps Red Hat's own ranges. Cleared on close and dispose.
- Surprise: a content signature can't tell Red Hat's republish from another collection's change (the event only names URIs), and a republish with the same content after a deletion would never be taken. A probe against the real YAML by Red Hat (removed) showed `getDiagnostics` returns the same objects on every call and after another collection's change, and new objects on every republish even with the same content, so the set is compared by identity.
- `src/test/adapters/vscode/diagnostics.test.ts`: the fake's `edit` sends a real-shaped no-op change by default (FIRST_EDIT keeps passing); a story 13 test (shift on insert, another collection's event, republish, deleted start, unmappable change, unreached version).
- `src/test/integration/suites/82-graph-markers.ts`: HELD, the real view and graph with a test-driven Red Hat: no status puts the marker on another node after a two-line insert above (AC 1); the republish at the shifted place posts nothing (AC 2, as no status changes). Fails without the change.
- `src/adapters/graphPanel/graphPanel.ts`: the "known, transient" note in `sendModel` replaced. `CHANGELOG.md`: a "Fixed" line.
- After review: the shift updates the view's stored signature, so it fires no event (one would send the new model's status before the model); text inserted exactly at a held start goes before it; only detected files are held.
- Found by the full suite: story 18's GRAPH FROZEN failed, since the broken YAML's Red Hat syntax error (source `YAML`) was held, shifted onto `output`, through the edit that fixed it. A held syntax error now goes on any edit (it describes the text's structure, which the edit may have fixed); schema diagnostics are held. The unit fake's `setRedHat` takes a source; FIRST_EDIT and the story 13 tests use a schema one.

## Review Triage Log

Quick review. Verdicts: 0 high, 1 medium, 3 low, 1 rejected low.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | An edit above a held diagnostic changes the view's signature, so the view's event fires in its change listener (before the graph's) and the graph posts the new model's `nodeStatus` before the `model`; the webview applies new ids to the old model and may announce under the wrong node's name | medium | patch | Confirmed (panels.ts forwards the event to `diagnosticsChanged`, which posts at once). The shift now updates the stored signature, so it fires nothing; the graph's rebuild on the edit uses the shifted ranges. HELD checks the model comes before the status. |
| 2 | Text inserted exactly at a held start stays after it (`mapOffset` keeps an offset before an insertion at it), so the marker moves onto a node typed at the cursor | low | patch | Confirmed. Held starts move past text inserted at them; unit case added. |
| 3 | A Red Hat publish computed for an older version is taken as current | low | reject | Real but pre-existing: the API does not say which version Red Hat validated (the ticket's candidate approach has the same gap); the next publish corrects it. |
| 4 | HELD's AC 1 check accepts a message on the switch or case (messages roll up) | low | patch | Confirmed; it now checks that only the log has the message among its own. |
| 5 | A held entry for every URI with diagnostics, not only detected ones | low | patch | Confirmed (memory only); only detected files are held. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "adapters/vscode LintDiagnostics"`, `--grep "Extension tracer path|Pipeline graph: markers"`, and the full stable suite -- expected: all pass.
