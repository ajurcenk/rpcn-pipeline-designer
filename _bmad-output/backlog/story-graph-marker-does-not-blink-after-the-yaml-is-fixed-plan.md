---
title: 'Graph marker does not blink after the YAML is fixed'
type: 'bugfix'
ticket: '18'
created: '2026-10-23'
status: 'built'
baseline_revision: 'f57dd3f9a6cc429c0868787bb9d47f9f70cfa0f5'
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

**Problem:** While a config's YAML does not parse, 4.5 (`src/adapters/vscode/bloblangDiagnostics.ts`) has no Bloblang diagnostics for it and the graph keeps its last node status (AD-17). On the edit that makes the YAML parse again, the graph rebuilds its model and status at once, before 4.5's 300 ms debounce republishes the cached errors, so a Bloblang marker disappears for about 300 ms and comes back (two `nodeStatus` posts). The editor underline also comes back only after the debounce.

**Approach:** On the edit that makes a file's YAML parse again, 4.5 updates at once instead of after its debounce: it reads the processors and republishes every cached result in that same change event, and asks for the parses it lacks. 4.5's change listener is registered before the graph's (it is created first at activation), so the graph's rebuild already sees the republished errors: an unchanged marker is not posted again, and the underline returns with it. Nothing else changes: while the YAML is broken there are still no Bloblang diagnostics, other edits keep the debounce, and a mapping whose text changed while the YAML was broken shows its result when its parse returns.

</frozen-after-approval>

## Implementation Notes

Oneshot: a `broken` flag on 4.5's per-document state and an immediate update on the edit that fixes the YAML; suite 91's GRAPH FROZEN test inverted (it pinned the blink); CHANGELOG and EXPERIENCE.

- `src/adapters/vscode/bloblangDiagnostics.ts`: `DocState.broken` (set by `update`), `changed()` on each content change: when the last update found the YAML broken and it parses now, the timer is cleared and `update` runs in the change event; otherwise `schedule` as before. `parses(doc)` is shared with `update`.
- `src/test/integration/suites/91-bloblang-diagnostics.ts`: GRAPH FROZEN now asserts that no status other than the marker is posted after the fix and that the current status (a fresh snapshot) is the marker; the last `nodeStatus` post can't be read: the marker was first sent in a snapshot, and the unchanged status is not posted again. YAML_BROKEN: back within 150 ms (under the 300 ms debounce). With the product change reverted both fail (the blink shows as `[{}, marker]`).
- `CHANGELOG.md` ("Fixed"), `EXPERIENCE.md` (the 300 ms return).

## Review Triage Log

Quick review. Verdicts: 0 high, 0 medium, 3 low, 0 false. The reviewer traced the main path (4.5's publish → lint refresh → the graph's `diagnosticsChanged`, all before the graph's `changed`), a fix within 300 ms of breaking, and a mapping changed while broken: all as intended.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The 4.6 CHANGELOG entry in the same Unreleased section still says the marker returns about 300 ms later | low | patch | Confirmed; reworded to "it stays when the YAML parses again". |
| 2 | `DocState.current` comment still says "the last debounced update" | low | patch | Confirmed; now names the immediate update too. |
| 3 | The header sentence inserted without re-wrapping (a ~160-column line) | low | patch | Re-wrapped. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|Live Bloblang diagnostics .integration, 4.5.|Pipeline graph: markers"` -- expected: all pass (3 runs: 30 passing each).
