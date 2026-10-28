# Deferred work

- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/story-graph-interaction-fixes-across-tickets-plan.md`
  summary: renamedDriving entries leak when a rename is announced (onWillRenameFiles) but never reported (onDidRenameFiles).
  evidence: 3.15 triage row 13; the same family as backlog 14 (pendingRenames). A stale entry can later make an editor in that column the driving one.
  resolution: fixed by 4.13 (2026-10-17): an unreported rename expires after 30 s, and its unreported `renamedDriving` entries are dropped with it.
- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/story-graph-interaction-fixes-across-tickets-plan.md`
  summary: Rename collisions keep the overwritten file's panel and dispose the moved one; two renames landing on one key depend on Map iteration order.
  evidence: 3.15 triage row 15; behaviour from 3.10's renamed(); group with E3 retro F9 / AI-2.
  resolution: moved to backlog bug 17 "A rename that overwrites a file keeps the wrong panel" (4.13, user decision 2026-10-17).
- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/story-graph-interaction-fixes-across-tickets-plan.md`
  summary: The 3.7 test "CURSOR / CURSOR_SAME / CURSOR_OUTSIDE / FOCUS" failed once in CI on VS Code 1.100.0 ("the YAML editor is active after moves within the node") at f3242f4, and passed on the rerun.
  evidence: CI run for f3242f4, attempt 1 failed and attempt 2 passed. It passed in all 7 earlier CI runs and in every local run. The likely cause is that focus and `activeTextEditor` are unreliable on 1.100 (spike 3.14). If it recurs, make the assertion wait for the focus state, and open a ticket.
  resolution: fixed by bug 15 (2026-10-12). It recurred (4 of 9 CI runs); the cause was the lock sequence giving up after its 1 s wait while the delayed reveal still took focus. The sequence now finishes late; the test's assertions are unchanged. What remains on the 1.100 floor (next entry) is won't-fix (4.13).

- source_plan: `_bmad-output/backlog/bug-yaml-editor-loses-focus-during-cursor-moves-on-vs-code-1-100-plan.md`
  summary: After bug 15's fix the 3.7 CURSOR focus test still fails in CI on VS Code 1.100.0 about 1 run in 3 (run on 376c2cc, attempt 2); 1.141.0 passed 3/3. Bug 15 reduced the 1.100 failure, it did not remove it.
  evidence: User decision (2026-10-13): focus only on VS Code 1.141.0 now; the 1.100.0 flake is not worked on and CI stays as it is (a red 1.100 run is rerun by hand).
  resolution: won't-fix (4.13, user decision 2026-10-17): the 1.100 floor is out of scope and non-blocking in CI.

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
  resolution: fixed by 4.13 (2026-10-17): one `PendingRenames` helper in `graphPanel/tabs.ts` for both registries drops an entry when its rename is reported or 30 s after its announcement; backlog story 14 is done with it.

- source_plan: `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/story-bloblang-parity-in-the-corpus-harness-plan.md`
  summary: The graph panel reopens its document with `openTextDocument` on every webview `ready` (it sends `ready` again on each reload, since `retainContextWhenHidden` is false), which keeps a closed document open for minutes. This made suite 90's CLOSE_UNSAVED + WITH_GRAPH flaky in CI.
  evidence: Found after the 4.12 commit (CI 2a73cfa failed it on both labels; run 38851777631 on the 4.11 plan commit failed it on the floor before 4.12). Reproduced locally by sending one extra `ready` 50 ms after the close. 4.12 fixed only the test (wait for the graph's `ready` to settle). A product fix, not reopening a closed document on `ready`, changes graph behaviour; candidate for the refactor sweep (4.13).
  resolution: fixed by 4.13 (2026-10-17): on `ready` the graph uses its document only when it is already open, else its last model and status; suite 90's settle workaround is removed.

- source_plan: `_bmad-output/backlog/bug-a-rename-that-overwrites-a-file-keeps-the-wrong-panel-plan.md`
  summary: After an overwrite rename, the moved test panels read the overwritten config's samples file, and the moved config's own samples file is left under its old name.
  evidence: `moveSamples` returns `exists` when the target's samples file is there, so both are left and the user is told; before ticket 17 the moved panel closed, which hid this. Changing how samples files move was out of the ticket's scope.
  resolution: ticketed as backlog 24 (2026-10-27): `_bmad-output/backlog/bug-moved-test-panels-read-the-overwritten-configs-samples.md`.

- source_plan: `_bmad-output/backlog/bug-a-rename-that-overwrites-a-file-keeps-the-wrong-panel-plan.md`
  summary: The test registry's dirty tracking misses an edit's dirty state; only a panel opened on an already dirty document records it.
  evidence: Found while writing OVERWRITTEN_DIRTY (ticket 17 review): VS Code sets `isDirty` only after the content-change event, and the handler ignores the later change event that has no content changes.
  resolution: ticketed as backlog 25 (2026-10-27): `_bmad-output/backlog/bug-test-panels-miss-unsaved-changes-made-after-the-panel-opened.md`.

- source_plan: `_bmad-output/backlog/bug-a-rename-that-overwrites-a-file-keeps-the-wrong-panel-plan.md`
  summary: A hidden file renamed (with overwrite) onto a file whose graph is open marks the new name hidden while that graph stays open, showing the moved content.
  evidence: Ticket 17 resumed review R4. `GraphPanels.renamed` picks winners among open graphs only, so `follows(this.hidden, …)` moves the hidden flag with no winner check; the same before ticket 17.
  resolution: ticketed as backlog 26 (2026-10-27): `_bmad-output/backlog/bug-a-hidden-file-renamed-over-an-open-graph-marks-the-name-hidden.md`.

- source_plan: `_bmad-output/backlog/bug-typing-rpcn-in-a-blank-file-offers-no-starter-snippet-plan.md`
  summary: In a detected config (also a blank one matched by `redpandaConnect.filePatterns`), accepting a section snippet after typing `rpcn-…` leaves `rpcn-` in front, since VS Code's YAML word stops at `-`; the README tells users to type `rpcn-` for the sections.
  evidence: Ticket 11 review finding 1. `SnippetCompletionProvider` sets `item.range` only for undetected blank files; the YAML language configuration has no `wordPattern`. Ticket 11's boundary kept detected files unchanged.
  resolution: not a bug (checked 2026-10-27 in the 1.143.1 test host with YAML by Red Hat): in a detected config the sections are offered for `r`, `rpcn`, `rpcn-`, `rpcn-in` (with or without a trailing newline), VS Code's range covers the whole typed word including `-`, and a real accept after typing `rpcn-ou` leaves exactly `output:` / `stdout: {}`, no `rpcn-`. The assumed word pattern does not apply (Red Hat's language configuration covers `-`).

- source_plan: `_bmad-output/backlog/story-quick-fix-inside-name-keyed-maps-plan.md`
  summary: Suite 50's Quick Fix tests (QUICK_FIX, OPTION_FIX, FIX_ALL, ticket 7's) sometimes get no action from the provider: `executeCodeActionProvider` lists only Copilot's "Fix" / "Explain".
  evidence: Seen on the baseline (c063d6c, 1 of 6 runs) and with ticket 7 (2 of 6, all Quick Fix tests of the run). Building a longer failure message (schema state, diagnostics) before the assertion made 8 of 8 runs pass, so it looks like the request racing the diagnostics reaching the provider's context. Related to bug 21 (CI timing flakes).
  resolution: ticketed as backlog 27 (2026-10-27): `_bmad-output/backlog/bug-flaky-focus-and-timing-dependent-integration-tests.md`.

- source_plan: `_bmad-output/backlog/story-multi-root-workspace-folder-choice-plan.md`
  summary: No automated test covers a real multi-root workspace: per-folder `resourceFiles` / `envFile` (ticket 4) are tested through an injected folder and the pure `definingFolder`, not through `getConfiguration(…, resource)` and `inspect`.
  evidence: Ticket 4 review finding 2. The test host opens no workspace folder (some suites rely on that); a multi-root case needs a separate `vscode-test` run with its own `.code-workspace` and folder settings.
  resolution: ticketed as backlog 28 (2026-10-27): `_bmad-output/backlog/story-automated-test-run-in-a-multi-root-workspace.md`.

- source_plan: `_bmad-output/backlog/bug-graph-webview-ready-timing-flakes-in-ci-plan.md`
  summary: CI flake in the graph keyboard suite (3.11): `ESC (ticket 11): focusEditorRequested focuses the driving editor with its cursor unchanged; with no editor nothing happens` failed with "focus stays where it was" in the stable run (933 passing, 1 failing); the same job's non-blocking 1.100.0 floor run failed `RETAKE_STEAL (bug 19)`.
  evidence: CI run 40398418336 on d89e711 (story 6, which changed only scripts/spike/*.sh). The next two runs on the same CI setup passed (eb4ddbc, f994870). Same family as bugs 19 and 21: focus-dependent tests under xvfb on the 2-CPU runner; not reproduced locally.
  resolution: ticketed as backlog 27 (2026-10-27): `_bmad-output/backlog/bug-flaky-focus-and-timing-dependent-integration-tests.md`.

- source_plan: `_bmad-output/backlog/bug-flaky-focus-and-timing-dependent-integration-tests-plan.md`
  summary: On the 1.100.0 floor, RETAKE_STEAL sometimes ends with the graph's webview group focused after the focus return to the YAML.
  evidence: CI run 40558514970 attempt 1 (floor, non-blocking): "focus stays in the YAML, in its group: editor none, group 2 (tab Graph: retake-steal.yaml [webview]), visible [retake-steal.yaml@1]"; attempt 2 and the stable runs passed. Only seen on 1.100.0.

- source_plan: `_bmad-output/backlog/story-secret-environment-variables-kept-in-the-secret-storage-plan.md`
  summary: The schema cache in the extension's global storage (`schema-<key>.json`, about 2 MB each) is never pruned, and live-parse temporary files (`bloblang-parse-*.blobl`) can be left behind.
  evidence: found while building ticket 30 (2026-10-28): the test profile's storage held 7001 schema files (14 GB; the tests make a new fake binary per run) and 465 parse files dated from 2026-10-13. For a user, one stale file per binary they have used; nothing removes them.

- source_plan: `_bmad-output/backlog/story-secret-environment-variables-kept-in-the-secret-storage-plan.md`
  summary: Ticket 30's env-file clash warning scans `^NAME=` only, so a line with spaces around `=` (`API_TOKEN = x`), which the binary applies, gets no "the env file wins" warning.
  evidence: re-probed 2026-10-28 on 4.100.0 and 4.112.0: `A = 1` sets A. The secret is still passed and the binary's precedence still applies; only the warning is missed. Ticket 31's `src/core/envFileRead.ts` reads the binary's rules and could be reused.
  resolution: fixed in ticket 31 (review row 7): `envFileNames` reads with `envFileRead`.

- source_plan: `_bmad-output/backlog/story-an-environment-view-shows-each-configs-variables-plan.md`
  summary: Ticket 30's "Set secret variable" declares the name at folder level whenever a `.code-workspace` file is open (`workspaceFile !== undefined`), so a single folder opened through a workspace file gets folder settings, unlike ticket 31's rule (by the number of folders) and the README.
  evidence: found in ticket 31's review (row 6); ticket 31 changed its own level choice only.
  resolution: ticketed as backlog 33 (2026-10-28): `_bmad-output/backlog/bug-set-secret-variable-declares-the-name-in-the-folder-settings-of-a-one-folder-workspace.md`.


- source_plan: `_bmad-output/backlog/bug-set-secret-variable-declares-the-name-in-the-folder-settings-of-a-one-folder-workspace-plan.md`
  summary: Ticket 32's suite 90 tests OTHER_NAME ("the secret is set": OTHER_32's value undefined) and CANCEL (nothing offered, `picked` empty) failed together once in a local stable run, then passed on the next run.
  evidence: `.vscode-test/bug33-stable-run1.log` (2026-10-28, 1038 passing, 2 failing); the next stable run on the same machine had 1040 passing. Bug 33's change does not touch a no-folder config's path. Not reproduced; possibly the secret reload after the previous test's teardown (WRITE_SETTLE_MS) racing the next set.
