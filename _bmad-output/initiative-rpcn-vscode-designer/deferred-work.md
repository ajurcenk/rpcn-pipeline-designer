# Deferred work

- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/story-graph-interaction-fixes-across-tickets-plan.md`
  summary: renamedDriving entries leak when a rename is announced (onWillRenameFiles) but never reported (onDidRenameFiles).
  evidence: 3.15 triage row 13; the same family as backlog 14 (pendingRenames). A stale entry can later make an editor in that column the driving one.
- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/story-graph-interaction-fixes-across-tickets-plan.md`
  summary: Rename collisions keep the overwritten file's panel and dispose the moved one; two renames landing on one key depend on Map iteration order.
  evidence: 3.15 triage row 15; behaviour from 3.10's renamed(); group with E3 retro F9 / AI-2.
- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/story-graph-interaction-fixes-across-tickets-plan.md`
  summary: The 3.7 test "CURSOR / CURSOR_SAME / CURSOR_OUTSIDE / FOCUS" failed once in CI on VS Code 1.100.0 ("the YAML editor is active after moves within the node") at f3242f4, and passed on the rerun.
  evidence: CI run for f3242f4, attempt 1 failed and attempt 2 passed. It passed in all 7 earlier CI runs and in every local run. The likely cause is that focus and `activeTextEditor` are unreliable on 1.100 (spike 3.14). If it recurs, make the assertion wait for the focus state, and open a ticket.
  resolution: fixed by bug 15 (2026-10-12). It recurred (4 of 9 CI runs); the cause was the lock sequence giving up after its 1 s wait while the delayed reveal still took focus. The sequence now finishes late; the test's assertions are unchanged.

- source_plan: `_bmad-output/backlog/bug-yaml-editor-loses-focus-during-cursor-moves-on-vs-code-1-100-plan.md`
  summary: After bug 15's fix the 3.7 CURSOR focus test still fails in CI on VS Code 1.100.0 about 1 run in 3 (run on 376c2cc, attempt 2); 1.141.0 passed 3/3. Bug 15 reduced the 1.100 failure, it did not remove it.
  evidence: User decision (2026-10-13): focus only on VS Code 1.141.0 now; the 1.100.0 flake is not worked on and CI stays as it is (a red 1.100 run is rerun by hand).

- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/story-errors-and-states-in-the-test-panel-plan.md`
  summary: The test panel's no-binary state (E4 R7): toolbar and columns hidden, "No Redpanda Connect binary" with Install guide, Set path and Retry (posting `installGuideRequested` / `setPathRequested` / `retryRequested` to `BinaryActions` in `notify.ts`, as the graph does), the host sending `binary {status}` on every binary change, and the panel running its input once when the binary becomes `ok`, without reopening.
  evidence: Split from 4.8 at planning (user, 2026-10-14) to keep the plan near the size guideline; it ships independently of the error cards. It goes right after 4.8 and before 4.9. Until then, a missing binary shows 4.8's `error` card ("No Redpanda Connect binary.").
  resolution: ticket 4.15 "No-binary state in the test panel" (user, 2026-10-14), after 4.8 and before 4.9.

- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/story-saved-samples-plan.md`
  summary: The "add a label" offer for a mapping with no `label` (writing the label into the YAML and re-linking its samples) and the sample count in the "▷ Test mapping" CodeLens (E4 R9).
  evidence: Split from 4.9 at planning (user, 2026-10-15) to keep the plan near the size guideline; both build on 4.9's samples file and ship on their own.
  resolution: ticket 4.16 "Sample label offer and CodeLens count" (user, 2026-10-15), after 4.9 and before 4.10.

- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/story-test-panel-follows-its-processor-plan.md`
  summary: The test panel closing with its file's last tab, following a file rename (with the samples file), and opening in a settled editor group beside the YAML and the graph's locked group (E4 R8).
  evidence: Split from 4.10 at planning (user, 2026-10-15) to keep the plan near the size guideline; it reuses the graph's tab, rename and group helpers and ships on its own.
  resolution: ticket 4.17 "Test panel tabs, rename and placement" (user, 2026-10-15), after 4.10 and before 4.11.

- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/story-test-panel-tabs-rename-and-placement-plan.md`
  summary: `pendingRenames` in the graph and Bloblang panel registries is cleared only by a matching `onDidRenameFiles`. A rename that fails after `onWillRenameFiles` leaves the entry for the session, and that file's panels then never close with their last tab (and the Bloblang 4.10 close reset is skipped).
  evidence: Review of 4.17 (finding 5). The pattern is pre-existing in `src/adapters/graphPanel/panels.ts` and was copied into `src/adapters/bloblangPanel/panels.ts`. A fix such as dropping entries after a timeout, or on the next rename event, belongs to both registries (refactor sweep 4.13).

- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/story-bloblang-parity-in-the-corpus-harness-plan.md`
  summary: The graph panel reopens its document with `openTextDocument` on every webview `ready` (it sends `ready` again on each reload, since `retainContextWhenHidden` is false), which keeps a closed document open for minutes. This made suite 90's CLOSE_UNSAVED + WITH_GRAPH flaky in CI.
  evidence: Found after the 4.12 commit (CI 2a73cfa failed it on both labels; run 38851777631 on the 4.11 plan commit failed it on the floor before 4.12). Reproduced locally by sending one extra `ready` 50 ms after the close. 4.12 fixed only the test (wait for the graph's `ready` to settle). A product fix, not reopening a closed document on `ready`, changes graph behaviour; candidate for the refactor sweep (4.13).
