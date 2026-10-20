---
title: 'Test panel checks by hand'
type: 'chore'
ticket: '14'
created: '2026-10-20'
status: 'built'
baseline_revision: '798e1d084865fbaa76a62d48c97d4ef1c4451f4e'
route: 'oneshot'
route_source: 'auto'
review: 'none'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic E4's Done when 5 needs a person to check the Bloblang features by hand: the panel works by keyboard and screen reader, the CI `.vsix` carries it, and the user passes a hands-on check on VS Code stable in light, dark and high-contrast themes. 1.100 is dropped (user decision, 2026-10-20).

**Approach:** The user works through the checklist below in the dev host (VS Code 1.141.0, real rpk). Each check is recorded with its date, VS Code version and result. Findings become backlog stories. No code changes.

</frozen-after-approval>

## Implementation Notes

Hands-on ticket (hitl), so the oneshot route with no code and no review. Demo file: `.dev-host/workspace/bloblang-handcheck.yaml` (git-ignored), a labelled mapping with no samples.

## Checklist

| # | Check | Date | VS Code | Result |
|---|---|---|---|---|
| C1 | Empty sample to a passing and a failing run | 2026-10-20 | 1.141.0 | Pass (the user): empty panel, a passing run with change marks, New sample, a failing run with Go to line, dimmed last output and the end-of-line hint. |
| C2 | Live syntax errors and the graph marker | 2026-10-20 | 1.141.0 | Pass (the user): a trailing ` +` gave rpk's `expected line break` (Bloblang, Ln 14 Col 20, the binary's position) underlined, in Problems and on the `greet` node; it cleared on fixing. |
| C3 | Light, dark and high-contrast themes (panel and graph) | 2026-10-20 | 1.141.0 | Pass (the user). |
| C4 | Keyboard walk and Esc; screen reader optional | 2026-10-20 | 1.141.0 | Pass (the user). |
| C5 | The CI `.vsix` carries the panel | 2026-10-20 | n/a (artifact) | Pass (checked by Claude): the `rpcn-pipeline-designer-vsix` artifact of CI run 39433758016 (7cc9bb5) contains `dist/bloblang.js` (the panel webview), `dist/webview.js`, `dist/extension.js`, `dist/codicon.ttf`, and `package.json` contributes `redpandaConnect.testMapping`. |

## Findings

None: no backlog stories from the hands-on checks.

## Verification

All five checks passed on 2026-10-20 (VS Code 1.141.0, rpk connect 4.112.0); C5 from CI run 39433758016.
