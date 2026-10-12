---
title: 'Newcomer Flow 3 and reload checks by hand'
type: 'chore'
ticket: '13'
created: '2026-10-12'
status: 'done'
baseline_revision: 'fa34f24ee9605e85769d32913ed282c95bb5551f'
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

**Problem:** Done when 5 (Flow 3 in under 10 minutes) and the decision that a real window reload stays a manual check cannot be tested automatically. Earlier tickets also handed this entry checks only a person can do (3.10, spike 3.14, 3.12 item 8).

**Approach:** the user runs the checks below by hand. The agent prepares each window, records what the user reports, and turns every finding into a backlog ticket. No product code changes.

**A. Flow 3, timed** (EXPERIENCE Flow 3, steps 1–7):
- **Setup:** VS Code 1.141.0, a clean profile (`.dev-host/user-flow3`, no settings, no cached schema) and an empty folder (`.dev-host/flow3`).
- **Steps:** create and save `webhooks.yaml`, then do steps 1–7, from `input:` to Run.
- **Pass:** a running pipeline in under 10 minutes. Logs that show the `redpanda` output failing to reach a broker still count as running, because no broker is required.

**B. Reload:** on 1.141.0, then on 1.100.0 (`.vscode-test/vscode-linux-x64-1.100.0/code`):
- Open a graph for one file and store a Hide for another, then run **Developer: Reload Window**.
- **Check:**
  - the hidden file does not auto-open, and Show graph works;
  - the visible detected file's graph comes back through auto-open;
  - if VS Code leaves an empty locked group, the next graph reuses it rather than adding a group;
  - restored tabs that are not visible auto-open only when first shown.

**C. Contrast** (3.8 row 14): a selected node with an error marker, and one with a warning marker, in Dark Modern, Light Modern and a High Contrast theme. Both the marker icon and the selection must stay distinguishable.

</frozen-after-approval>

## Implementation Notes

- Oneshot: this entry changes no product code. The agent prepared each window: a clean profile `.dev-host/user-flow3` on an empty folder `.dev-host/flow3`; the usual dev host on 1.141.0; and a 1.100.0 window with profile `.dev-host/user-1100`. The user ran every check. No review lens ran (`review: 'none'`), because the only change is this record.

## Verification

**Manual checks:** A, B (both versions) and C, each recorded below with the date, version and result in the user's words. A records the time taken. Every finding becomes a backlog story (the next free id is 15).
- **A. Flow 3, done by the user on 2026-10-12** on VS Code 1.141.0 with a clean profile and an empty folder. Steps 1–7 were completed. Result: "I have tested all stepps, no issues". Time: **under 10 minutes** (user, "under 10 minutes"), so Done when 5 is met.
- **B. Reload on 1.141.0, done by the user on 2026-10-12** in the dev host: a graph open, a stored Hide, then Developer: Reload Window. Result: "reload tested, no issues".
- **B. Reload on 1.100.0, done by the user on 2026-10-12** in a 1.100.0 window (`.vscode-test/vscode-linux-x64-1.100.0/code`, profile `.dev-host/user-1100`). The same steps as on 1.141.0. Result: "working".
- **C. Contrast, done by the user on 2026-10-12** on 1.141.0. Checked a selected node with an error (`mapping`, `noope`) and one with a warning (`log`, `fields`), in Dark Modern, Light Modern and a High Contrast theme. Result: "working", so 3.8 row 14 is closed.

No findings, so no backlog stories were created.
