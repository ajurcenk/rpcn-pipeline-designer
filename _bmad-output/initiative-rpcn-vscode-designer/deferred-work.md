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
