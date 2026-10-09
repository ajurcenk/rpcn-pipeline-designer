---
title: 'Probe: group lock, focus return and restored tabs on VS Code 1.100'
type: 'chore'
ticket: '14'
created: '2026-10-09'
status: 'built'
baseline_revision: '3f0356e3037e4590640114faca0a18ead91533b1'
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

**Problem:** Auto-open (entry 10) has to open the graph beside the YAML, lock that group "best effort" and return focus to the YAML. VS Code exposes locking only as the `workbench.action.lockEditorGroup` command, which the API types do not describe and which acts on the *active* group. Nothing says whether it works on VS Code 1.100.0, what it does with a webview group, where focus ends, or what a window reload restores (no panel serializer, by spec).

**Approach:** A throwaway probe suite runs in a scratch worktree on VS Code stable and 1.100.0 and records:
- whether the command exists;
- the steps "Show graph → make the graph group active → lock → focus the YAML" and the tab groups, active group and active editor after each;
- whether a file opened with the graph group active lands in that group (unlocked) or in another group (locked);
- what `showTextDocument` with an explicit column does to a locked group.

The reload behaviour (which tabs come back, whether the graph comes back, whether the lock survives) is checked by hand in the dev host, because reloading ends a test run. A findings note beside this plan records both, with the probe code, and recommends entry 10's approach. No product code changes.

</frozen-after-approval>

## Implementation Notes

- **Probe:** `spike-3-14-findings/probe-lock.ts`, run as an extra suite (`--grep "Spike 3.14"`) in a scratch worktree at 3f0356e on VS Code 1.141.0 and 1.100.0, then removed. It passed on both. The step logs are in `spike-3-14-findings/probe-log.md`. The suite needed the extension activated before the schema harness, as in the E2 behaviour check.
- **Reload:** checked by hand in the dev host by the user (2026-10-09; screenshot `spike-3-14-findings/reload-locked-empty-group.png`). The YAML came back, the graph tab did not, and the group stayed, empty and locked.
- **Findings and recommendation for entry 10:** `spike-3-14-findings/findings.md`. Lock with the graph group active, then return focus with `showTextDocument`; open later graphs into the graph column explicitly, since an explicit column bypasses the lock; reuse an empty group left beside the editor after a reload; on 1.100, never read `activeTextEditor` mid-sequence.
- No product code changed.

## Verification

**Manual checks:**
- The probe runs on both versions; its log is copied into the findings note.
- The user's reload check in the dev host is recorded in the note.

## Review Triage Log

**Pass 1 (quick, by a fresh subagent; 2026-10-09):** 10 findings. 9 patched in the findings note (wording and evidence; no probe re-run) and 1 patched in the screenshot. None rejected.

- **Reload recorded for one version only (verify asks for both):** low, patch. The note now says the reload was checked on VS Code 1.103.2 (the user's `code`), not 1.100.0. Entry 13 repeats it on 1.100.0 (`CODE=… scripts/dev-host.sh`). Partly unmet: reported to the user.
- **Restored tabs reaching the extension as opens not observed; manual steps not recorded:** low, patch. Marked as not observed, with the steps written down. Entry 10 or 13 checks it.
- **Rec 3 claims a second `lockEditorGroup` keeps the lock and that the leftover group appears in `tabGroups` with no tabs, neither probed (step 9 suggests otherwise after a close-all):** low, patch. Both are marked unverified for entry 10.
- **Rec 2's explicit column is shown only for a text editor, not `createWebviewPanel`:** low, patch. Marked "entry 10 must verify".
- **On 1.100, `activeTextEditor` can name another group's editor (step 8), which affects `GraphPanels.show()`'s no-URI fallback:** low, patch. Added to the table and Rec 1.
- **Step 6 differs by version (preview tab replaced on stable, kept on the floor):** low, patch. Added; Rec 5 asserts where an editor lands, not the tab count.
- **Probe code cannot be re-run as kept:** low, patch. Re-run instructions are in the note.
- **Step 6's starting state was never logged:** low, patch. Marked as inferred from step 3.
- **"No context key in the API" is imprecise:** low, patch. Reworded: the API cannot read context keys; `activeEditorGroupLocked` exists for `when` clauses.
- **The screenshot shows another person's name outside the VS Code window:** medium, patch. Cropped to the window before commit.

