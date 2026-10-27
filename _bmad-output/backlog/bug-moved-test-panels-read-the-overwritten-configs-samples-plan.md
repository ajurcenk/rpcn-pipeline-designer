---
title: 'After an overwrite rename, the moved test panels read the overwritten config''s samples'
type: 'bugfix'
ticket: '24'
created: '2026-10-27'
status: done
baseline_revision: '19cd9e34027b3d991791a879a53ad6b8ca3d0dc7'
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

**Problem:** When a config is renamed onto another config with "Replace", its test panels move to the new name (ticket 17), but the samples file follows only when the new name has none (4.17): the overwritten config's samples file stays, the moved panels show its samples, the moved config's own samples file is left under its old name, and the user is told "Samples weren't moved".

**Approach:** A rename onto a config that existed overwrites that config, and its samples file belongs to nothing any more: it goes to the OS trash (recoverable), and the moved config's samples file takes the name; the moved panels then show their own samples. Whether a target config existed is checked before the rename runs (VS Code lets a listener delay a rename briefly for that). In a batch where several renames land on one name, only the one whose content ends up there (ticket 17's winner) moves its samples onto the name; a losing config's content is gone too, so its samples file goes to the trash. When trashing fails, both files are left and the user is told, as today. Everything else is unchanged: a rename onto a name with no config but a leftover samples file keeps both and tells the user (4.17's RENAME_TARGET_EXISTS); a plain rename moves the samples file as today.

**Decision (user, 2026-10-27):** the overwritten config's samples file goes to the OS trash, and the moved config's takes its name.

## Boundaries & Constraints

**Always:**
- The existence check covers only the renamed files' new names, and only files (a folder rename moves its samples with it, as today).
- Trash, never a permanent delete; a trash failure (not supported, an error) leaves both files and shows 4.17's "Samples weren't moved" message, and logs the reason.
- The move stays in the samples store's queue for the new name, so the moved panels' reads see the result.

**Never:**
- Changing 4.17's rule for a name whose config did not exist; touching samples files of configs not in the batch; the graph registry.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OVERWRITE | `a.yaml` + `a.samples.json` renamed onto existing `b.yaml` + `b.samples.json` with Replace, panel open on a | `b.samples.json` in the trash; `a.samples.json` is now `b.samples.json`; the moved panel shows a's samples; no "weren't moved" message | none |
| OVERWRITE_NO_SAMPLES | as OVERWRITE, `b` has no samples file | `a.samples.json` becomes `b.samples.json` (as today) | none |
| LEFTOVER | `a.yaml` renamed to `b.yaml` that did not exist, while `b.samples.json` exists | both kept, the user is told (as today) | none |
| BATCH | one batch `a→x`, `c→x` (second with overwrite), samples for a and c | c's samples become `x.samples.json`; a's samples file in the trash | none |
| TRASH_FAILS | as OVERWRITE, trashing fails | both files left, "Samples weren't moved" shown, reason logged | logged |

</frozen-after-approval>

## Code Map

- `src/adapters/bloblangPanel/panels.ts` -- `BloblangPanels`: the `onWillRenameFiles` listener (~line 1067, announces pending renames: add the existence check of each renamed file's new name, via `e.waitUntil`), `renamed()` (~1103: ticket 17's `renameWinners` over the panels' configs; calls `moveSamples(f.oldUri, f.newUri)` per file), `moveSamples` (~1156: tells `samplesNotMoved` on `'exists'`), `samplesNotMoved` (~143).
- `src/adapters/bloblangPanel/sampleStore.ts` -- `SamplesStore.moveFile(config, renamed)` (~232, queued on the new samples file) and `moveSamplesFile` (~250: returns `'exists'` when the new samples file exists; `'folder'` for a folder rename); `samplesUri`; `SamplesMove`. The overwrite (trash the new name's file, then rename) belongs inside the queued move.
- `src/adapters/graphPanel/tabs.ts` -- `renameWinners`, `renameFate`, `overwrittenBy` (ticket 17's batch rules) to reuse for the batch winner over every renamed config, not only those with panels.
- Tests: `src/test/integration/suites/90-bloblang-panel.ts` -- `renameFile(from, to, { overwrite })` (~1991), `samplesFile`, `readSamples`, `RENAME_TARGET_EXISTS` (~2144, must keep passing: its target config does not exist), `COLLISION` / `OVERWRITTEN_*` (ticket 17); a batch rename helper may be needed (suite 86's `batchedRegistry` fires `onWillRenameFiles` / `onDidRenameFiles` itself).

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/bloblangPanel/panels.ts` -- record, before each batch, which new names held a file; route each renamed config's samples by the batch winner and that record.
- [x] `src/adapters/bloblangPanel/sampleStore.ts` -- the overwriting move (trash the new name's samples file, then rename) and trashing a losing config's samples file, queued, with the failure path.
- [x] `src/test/integration/suites/90-bloblang-panel.ts` -- OVERWRITE, OVERWRITE_NO_SAMPLES, BATCH, TRASH_FAILS (a store seam if needed); LEFTOVER is RENAME_TARGET_EXISTS, kept.
- [x] `CHANGELOG.md` -- a "Fixed" line; `README.md` if it describes the samples file on rename.

**Acceptance Criteria:**
- Given a config with test panels and samples renamed onto an existing config with its own samples file, when the rename replaces it, then the moved panels show their own samples under the new name and the overwritten samples file is in the trash.
- Given a batch where two renames land on one name, when it applies, then the winner's samples are at the name and the loser's samples file is in the trash.
- Given the change, when compile, suite 90 and the full stable suite run, then all pass.

## Implementation Notes

- `panels.ts`: the `onWillRenameFiles` listener now calls `e.waitUntil(checkTargets(files))`, which stats each rename's old name and, only for a file, its new name, recording in `targets` (keyed `from\nto`) whether the new name held a file; each record is consumed when the rename is reported. `moveSamples` routes per renamed file with ticket 17's `renameFate` / `overwrittenBy` over the batch's renames (every renamed file, not only those with panels): a moved file whose content a later rename destroyed (the loser) gets `SampleStore.discard`; otherwise `moveFile` with `overwrite` when the new name held a file and the batch overwrote it. A rename with no record (not announced, or a folder) moves as 4.17. The `moveFile` call stays synchronous before the moved panels' `refresh`, so it is queued before their reads.
- `sampleStore.ts`: `moveFile(config, renamed, overwrite)`: with `overwrite`, an existing new samples file is moved to the trash (`useTrash: true`) before the rename, inside the queued move on the new name; a failed trash logs `Samples: <file>: not moved to the trash: <reason>` and returns `'exists'` (both left, 4.17's message). New `discard(config)` (queued on the loser's samples file) trashes it, `SamplesDiscard` outcome. Seam: the store's constructor takes a `DeleteFile` (default `vscode.workspace.fs.delete`), passed from the new `BloblangPanelsOptions.deleteFile` test seam.
- Tests (suite 90): helper `ownRenames(deleteFile?)` (a registry of the test's own on fake will/did events that waits for `waitUntil`, renames on disk with `fs.renameSync` and opens the new names, so the extension's registry never hears it; the default seam records `[file, useTrash]` and deletes for good, so no test depends on the OS trash). `OVERWRITE (bug 24)`, `OVERWRITE_NO_SAMPLES (bug 24)`, `BATCH (bug 24)`, `TRASH_FAILS (bug 24)`; LEFTOVER stays `RENAME_TARGET_EXISTS (4.17)`.
- A loser's trash that fails is logged only (no message): its samples file is left as an orphan and nothing at the new name was "not moved", so 4.17's message would name the wrong file.
- `CHANGELOG.md`: a "Fixed" line. `README.md` does not describe the samples file on rename: unchanged.

## Plan Change Log

## Review Triage Log

Quick review. Verdicts: 0 high, 1 medium, 4 low.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Chains in one batch (`b→t, a→b`; `a→b, b→t`) are handled pair by pair: the moved config's samples can stay under its old name with "Samples weren't moved" | medium | defer | 4.17's behaviour for chains, not made worse (in `a→b, b→t` the overwritten b's samples now go to the trash instead of following a's content to t); the Explorer does not send such batches. |
| 2 | Case-only overwrite on a case-sensitive file system (`a.yaml` onto a separate `A.yaml`) is not trashed: the move refuses and the user is told | low | defer | Nothing lost; needs telling two files apart from one renamed by case. |
| 3 | Trash succeeds, then the rename fails: logged, the user is not told | low | defer | As 4.17's failed move (logged, `{failed}`); the trashed file is recoverable. |
| 4 | Rename records of an announced, never reported rename stay | low | patch | Each expires with a pending rename (`pendingRenameMs`, 4.13). |
| 5 | BATCH does not cover an existing x | low | patch | BATCH_OVER: x and its samples existed; x's and a's samples files go to the trash, c's become x's. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|Bloblang test panel"` -- expected: all pass.
- `xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
  Result (2026-10-27): 942 passing; suite 90 96 passing.

**Manual checks:**
- Dev host on 1.143.1: two configs with samples; move one onto the other with Replace; the moved panel shows its own samples, the old samples file is in the OS trash.
  Done by the user (2026-10-27): no issues.
