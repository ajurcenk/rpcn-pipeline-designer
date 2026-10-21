---
epic: epic-bloblang-check-and-test
date: 2026-10-21T11:36:03-04:00
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective: epic-bloblang-check-and-test (Bloblang check and test)

> Final. Phases 1, 2, 4 and 5 are complete. Phase 3 (team discussion) was not requested. Decisions by the user, 2026-10-21.

## Epic summary

- **Epic:** `epic-bloblang-check-and-test` (epic file `epic-bloblang-check-and-test.md`, Done when 1–5 declared at :39-45). Requirements R1–R14 at :22-37. Spec CAP-15–CAP-17.
- **Tickets (build order from `tickets.py status`):** 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.15, 4.9, 4.16, 4.10, 4.17, 4.11, 4.12, 4.18, 4.13, 4.19, 4.14. All 19 are `done` (`counts: {total: 19, done: 19}`).
- **Tickets at `built`:** none. **`pending_tickets`:** empty.
- **Scope changes during the epic (epic Notes):** 4.15 split from 4.8 (:79), 4.16 split from 4.9 (:80), 4.17 split from 4.10 (:81), 4.18 added for new R14 (:83), 4.19 added as a bug from the 4.13 manual check (:84). 1.100 dropped from the hands-on checks and kept as a non-blocking CI run (:82, :85).
- **Going-in concern (user):** weight CI flakiness. The focus-dependent integration tests kept failing on the 2-CPU GitHub runner across 4.10, 4.13, 4.17 and 4.19. What did the process miss? See [CI flakiness](#ci-flakiness-focus).

### Ranges (from plan baselines; linear history, 0 merges)

Baselines were ordered by ancestry. Each range runs to the next baseline. The last range is cut at `6695328` ("epic 4 … done"); `d43d911` (backlog bug 20, after the epic) is outside the range but used as evidence.

| Ticket | Range | Commits | Src+tests churn (non-`_bmad-output`) | Notes |
|---|---|---|---|---|
| 4.1 | 8243faa..59c31aa | 6 | +725/−58, 8 files | Also holds backlog bug 15's fix (535afaf, c3617aa, f2e2497). That fix is not epic work, but it shares the graph lock and focus code. |
| 4.2 | 59c31aa..023c426 | 5 | +2040/−16, 27 | 7d4c517; CI test fix 376c2cc |
| 4.3 | 023c426..7ac8f9a | 3 | +965/−49, 9 | 3cd36fd |
| 4.4 | 7ac8f9a..696b000 | 2 | +774/−103, 20 | ac7bffb |
| 4.5 | 696b000..ae3ee8f | 2 | +1512/−28, 17 | d2f2b27 |
| 4.6 | ae3ee8f..da91681 | 2 | +229/−11, 6 | 9a3c271 |
| 4.7 | da91681..b539477 | 2 | +1268/−228, 18 | 8403fde |
| 4.8 | b539477..d1a4cd3 | 3 | +1122/−141, 20 | d67cdd8 |
| 4.15 | d1a4cd3..32d9bff | 3 | +647/−116, 8 | 15413ac |
| 4.9 | 32d9bff..0d30ad8 | 2 | +1729/−40, 15 | 72fe5f5 |
| 4.16 | 0d30ad8..bba2547 | 3 | +979/−52, 17 | 61b77c5 |
| 4.10 | bba2547..f3b66b3 | 2 | +1744/−78, 15 | d1a6cc5 |
| 4.17 | f3b66b3..4e49179 | 3 | +815/−30, 14 | 160f6c7 |
| 4.11 | 4e49179..943aebb | 3 | +454/−48, 13 | 3f69db2 |
| 4.12 | 943aebb..c978f31 | 5 | +2299/−267, 35 | 2a73cfa; test fix bcaeed9; CI change 1728710 |
| 4.18 | c978f31..b602126 | 3 | +777/−34, 14 | 6ed1358 |
| 4.13 | b602126..a9b5df2 | 3 | +413/−50, 9 | 5fa2870 |
| 4.19 | a9b5df2..798e1d0 | 3 | +497/−51, 6 | 7cc9bb5 |
| 4.14 | 798e1d0..6695328 (inferred end, cut) | 3 | 0 | records only |

Epic-wide (`git_evidence.py --range 8243faa..6695328`): **58 commits**, 0 merges (`merge_count` 0, `merges_measured` 0), 0 binary revisions. Outside `_bmad-output`, the churn is +18,989/−1,400 over 114 paths. Raw JSON: the session scratchpad `ev/*.json`.

### Evidence inventory

| Evidence | Status |
|---|---|
| Epic file, Done when, Notes | present |
| Initiative Requirements (R1–R14 restated in the epic file); spec CAP-15..17; architecture AD-1..22; EXPERIENCE/DESIGN | present |
| `tickets.py status` and the 19 plans (frontmatter, Verification, Review Triage Log) | present; all `status: done`, all with a `baseline_revision` |
| Story files | none (no ticket refined except bug 4.19, file `bug-graph-refits-when-its-panel-is-resized.md`) |
| Spike findings | `spike-4-1-findings/findings.md` + captures |
| deferred-work.md | `_bmad-output/initiative-rpcn-vscode-designer/deferred-work.md` (resolutions by 4.13) |
| Backlog bugs from the epic | 17, story 18 (b602126), 19 (798e1d0), 20 (d43d911) |
| CI | `gh run list` (60 runs) and `gh run view --log-failed` for each failed run, including the earlier attempts of re-run runs |
| Session log | `~/.claude/projects/-home-aleksejjurcenko-projects-clients-personal-rpcn-vscode-byoc-plugin/268853b3-1dfc-4afe-b271-cc6ebd368b10.jsonl` (searched with grep, not read in full; cited as "session log :line") |
| Previous retro | `epic-pipeline-graph/epic-pipeline-graph-retrospective.md` |

**Narrowings recorded:**
- madge was not installed, so cycles come from a Tarjan pass over relative imports (scratchpad `cycles.js`).
- The diff-scope review ran inline in a sub-agent over the boundary files, not as `bmad-review` over the whole 19k-line diff (see Diff-scope review).
- The system was not re-run (see Behavior verification).
- Integration tests were not re-run.

## Findings

Severity: H/M/L. Dispositions are suggestions for Phase 4: fix now / defer / accept.

### CI flakiness (focus)

**Data.** In the epic window (2026-10-12T21:34 to 2026-10-20T19:33), 58 CI runs were on `main` commits (plus 3 bug-15 diagnostic commits not for main). Going by each run's last attempt, **27 of the 58 failed**. Re-runs hide more failed attempts:
- 38416355305 (376c2cc): attempts 1 and 2 failed;
- 38429202033 (ac7bffb): attempt 1 failed;
- 38958402090 (bcaeed9): attempt 1 failed;
- 39433758016 (7cc9bb5): attempt 1 failed.

Each failed run's label below was found from the "Validated version" order in its log.

| Run | Commit (ticket range) | Label | Failing test(s) |
|---|---|---|---|
| 38311464573 | 8243faa (4.1) | floor | 3.7 CURSOR/FOCUS |
| 38323410082 | 6b7a442 (4.1) | floor | 3.7 CURSOR/FOCUS |
| 38338323735 (att 3) | 535afaf (bug 15) | floor | 3.9 NOTHING, E3 interactions (webview `ready` within 30 s) |
| 38346921240 | 59c31aa | floor | 3.10 LATE_ACTIVE |
| 38415363837 | 7d4c517 (4.2) | floor | BOUNDARY 3.1 + 3.10 (graph `ready`) |
| 38416355305 att 2 | 376c2cc (4.2) | floor | 3.7 CURSOR (att 3 green) |
| 38429202033 att 1 | ac7bffb (4.4) | stable | VS Code "CodeWindow: detected unresponsive" at startup, no tests ran (att 2 green) |
| 38430963286 | 696b000 | floor | 3.7 CURSOR |
| 38584794151 | 9a3c271 (4.6) | floor | 3.7 CURSOR |
| 38602560118 | 8403fde (4.7) | floor | 3.7 CURSOR |
| 38618360855 | d1a4cd3 | floor | 3.10 LATE_USER_EDITOR |
| 38678822862 / 38679572347 | 15413ac / 3089b0d (4.15) | floor | 3.10 LATE_ACTIVE |
| 38751397456 / 38761920131 | 0d30ad8 (4.9) / 61b77c5 (4.16) | floor | 3.7 CURSOR |
| 38809741917 | f3b66b3 (4.10 done) | **stable** | OFFER + ACCEPT + REORDER_AFTER (4.16): snapshot mismatch |
| 38851105027 | 160f6c7 (4.17) | floor | 3.10 LATE_ACTIVE |
| 38851211694 | e465d0d (4.17 done) | **stable** | 3.7 HEADER; PLACE_WITH_GRAPH (4.17) |
| 38851777631 | 4e49179 | floor | CLOSE_UNSAVED + WITH_GRAPH (4.10) "the document closed" |
| 38921978508 | 943aebb | **stable** | PLACE_WITH_GRAPH (4.17) |
| 38952777661 | 2a73cfa (4.12) | **stable + floor** | CLOSE_UNSAVED + WITH_GRAPH (4.10) |
| 38958402090 | bcaeed9 (4.12) | att 1 **stable**: PLACE_WITH_GRAPH; att 2 floor | CLOSE_UNSAVED "graph webview did not settle" |
| *1728710: floor made non-blocking* | | | |
| 38983467550 | 1728710 | **stable** | PLACE_WITH_GRAPH "focus is back in the YAML" |
| 38990107216 | 7120f18 (4.18 done) | **stable** (+floor) | PLACE_WITH_GRAPH `2 !== 1`; floor: 3.7, CLOSE_UNSAVED |
| 39001143371 | b602126 | **stable** | PLACE_WITH_GRAPH |
| *5fa2870: 4.13 sweep (green)* | | | |
| 39354646781 | be0d026 (4.13 done) | **stable** | PLACE_WITH_GRAPH `2 !== 1`; PLACE_GRAPH_LEFT `2 !== 4` |
| 39433758016 | 7cc9bb5 (4.19) | **stable** | att 1: PLACE_GRAPH_LEFT; att 2: window unresponsive at startup |
| 39444568138 | 798e1d0 | **stable** | PLACE_GRAPH_LEFT `2 !== 4` |
| 39482409309 | a9ece43 (4.14) | **stable** | PLACE_WITH_GRAPH `2 !== 1`; PLACE_GRAPH_LEFT `2 !== 4` |

The last two runs of the epic are green: 39484260114 (b1faf3b) and 39484337467 (6695328).

**Findings.**

- **CI-1 (H). The failures are flakes, proven from the record.** Commits that change only `_bmad-output/` flip the CI outcome on an identical source tree (`git diff --name-only` shows 0 non-ticket files):
  - 6ed1358 (green) and 7120f18 (red);
  - 5fa2870 (green) and be0d026 (red);
  - a9ece43 (red) and b1faf3b (green).
  - *Disposition:* fix (backlog bug 19 exists; see CI-3 for a correction it needs). *Lesson:* see P1–P3.

- **CI-2 (H). Two families with different causes.**
  - **(a) Floor (1.100.0) focus and `ready` timing in the E3 graph suites:** 3.7 CURSOR, 3.10 LATE_*, 3.9 and E3 "ready within 30 s".
    - These predate the epic. Bug 15 reduced the 3.7 failures but did not remove them (`deferred-work.md`, the CURSOR entries resolved as won't-fix).
    - The user decided on 2026-10-13 to stop working on the floor (session log :14962).
    - On 2026-10-16 the floor run was made non-blocking (1728710; epic :82).
    - **Since then no floor failure has failed the build.**
  - **(b) Stable failures in this epic's own suite 90 tests:**
    - 4.10 CLOSE_UNSAVED + WITH_GRAPH;
    - 4.16 OFFER;
    - **4.17 PLACE_WITH_GRAPH / PLACE_GRAPH_LEFT**, which is by far the most frequent. It failed on stable in 6 of the 14 runs from 160f6c7 to b602126, and in **4 of the 9 runs after the 4.13 sweep** (5fa2870 onward).
  - CLOSE_UNSAVED has not failed on stable since the sweep's "no reopen on `ready`" fix (last stable failure 38952777661), so **that fix held**. The placement fix did not.

- **CI-3 (H). The 4.13 placement fix confirms one focus signal, while the test also asserts another.**
  - Before the sweep, the failure message was "focus is back in the YAML" (`90-bloblang-panel.ts:2041`, run 38983467550). That is the message the 4.13 plan quotes (`story-refactor-sweep-plan.md:23`).
  - The fix, `BloblangPanels.returnFocus` (`src/adapters/bloblangPanel/panels.ts:1376-1393`), confirms `activeTextEditor.document === doc && viewColumn === column`.
  - The test's very next assertion is `tabGroups.activeTabGroup.viewColumn === One` (`:2042`; `:2071` in PLACE_GRAPH_LEFT). It is synchronous, with no wait.
  - Every post-sweep failure is on those lines (`2 !== 1`, `2 !== 4`). The active tab group is the graph's (column 2), while the `activeTextEditor` waits pass.
  - The `2 !== 1` mode was already in a pre-sweep log, 38990107216 (7120f18), which the sweep's investigation did not cite.
  - Bug 19 (`_bmad-output/backlog/bug-focus-dependent-integration-tests-are-flaky-in-ci.md:20`) says "PLACE_WITH_GRAPH … before the 4.13 sweep fixed their specific races". **Runs 39354646781 and 39482409309 contradict that.**
  - Bug 19 also says 39433758016's re-run failed 3.7 CURSOR. Attempt 2's log shows a VS Code window that froze at startup ("detected unresponsive") instead.
  - Whether the cause is product behaviour (the graph group's late activation after the focus return) or only the test's order of reads cannot be settled from the logs.
  - *Disposition:* fix now. Correct bug 19's text and give it this evidence, so the fix targets the tab-group signal, not only `activeTextEditor`.

- **CI-4 (M). Startup freezes on the runner.** "CodeWindow: detected unresponsive" before any test ran: 38429202033 att 1 and 39433758016 att 2. This is runner load with no code involved, and bug 19 does not track it. *Disposition:* defer into bug 19 (for example, a retry around the VS Code launch only).

- **CI-5 (M). Before 1728710, a failing VS Code step skipped the corpus parity step**, which is Done when 2's evidence, on 2a73cfa and bcaeed9 (session log :20777, :20942). 1728710 added `if: !cancelled()` to the later steps (`.github/workflows/ci.yml`). This is a real fix that came late: the gap existed from 4.12's first push. *Disposition:* accept, landed.

**Process lessons (what the process missed), each with a source:**

- **P1. No plan reproduced the runner's conditions until after 4.19.**
  - Every plan's Verification is local full-suite runs on the developer machine. Examples:
    - 4.17 plan :151 ("826 passing, three runs");
    - 4.13 plan :154 ("three runs in a row alone");
    - 4.19 plan :113.
  - The first 2-CPU-pinned comparison ran on 2026-10-20, after 4.19 (session log :23631; bug 19 :22). It reproduced failures on both commits.
  - CI was the first slow environment each change met, and it ran after the commit.

- **P2. "Passes alone → flake" was the per-ticket triage rule:**
  - 4.10 plan :169 ("Both passed alone twice");
  - session log :17204, :18854, :15385.
  - The rule was right that the failures were not regressions. But it never fed back into fixing a test until 4.13, and 4.13 fixed from one log line (CI-3).

- **P3. CI on `chore(tickets)` commits was not watched.**
  - The session reported the feat commits' runs (6ed1358 green, session log :21707; 5fa2870 green, :22621-22647). It has no mention of the failed runs on 7120f18 (38990107216), b602126 (39001143371) or be0d026 (39354646781).
  - The claim after the sweep, "two clean runs on `main` in a row" (session log :22647), is contradicted by b602126's red run 39001143371 just before it. be0d026 failed minutes later.
  - These runs are the cleanest flake evidence there is (same tree, CI-1).

- **P4. The 4.13 plan's CI acceptance line was too weak.** "Given the push, when CI runs, then the stable step … pass[es]" (`story-refactor-sweep-plan.md:126`). One green run satisfied it, and the Verification at :154 records no CI run at all.
  - Bug 15 had used "three green runs, the push plus two reruns" (session log :14313, :14607). 4.13 did not carry that over.
  - Bug 19's own acceptance line, "8 runs in a row on a 2-CPU-pinned machine and in CI" (bug 19 :24), is the right shape.

- **P5. Re-runs as triage hide failures.** `gh run list` shows only the last attempt. 4 of the 7 multi-attempt runs had hidden failed attempts (CI-Data above). Neither a plan nor deferred-work.md records the hidden attempts, except bug 15's plan.

- **P6. The local environment was itself a flake source.**
  - Shared `.vscode-test/user-data` across overlapping runs, and the real display: memory note `integration-tests-under-xvfb` (2026-10-16, during 4.17). Also the 4.18 plan :146: an overlapping run failed 5 undo tests.
  - `xvfb-run -a` became the standard from 4.11's plan on (:127). Before that, plans ran `npm test` on the desktop, for example 4.2 :137 and 4.5 :151.

- **P7. Per-ticket reviews never looked at test determinism under load.**
  - The 4.17 Review Triage Log (plan :137-148) has no timing row for its placement tests. The one timing note in the epic is 4.5's ERROR_SHOWN bound, rejected at plan :144.
  - The review lenses used (quick, or adversarial, edge-case and verification-gap) do not include a "flaky on slow CI" check.

### Aggregate views

**Architecture delta (vs AD-1/5/9/14/15/17/21/22; sub-agent evidence, spot-checked)**

- **A-1 (L), AD-9 holds.** The only `child_process` import is still `src/adapters/redpandaConnect/process.ts:9`. Blobl runs go through `bloblangRunner.ts` → `process.ts`. A second argv builder `buildBloblCommandLine` (`commandLine.ts:111`) sits beside `buildCommandLine` (:84) and shares env and `NO_COLOR` (:136). That sharing was the 4.12 triage row 4 fix (4.12 plan :166). *Accept.*
- **A-2 (L), AD-15 layering: core, shared and webview are clean.** ESLint enforces it (`eslint.config.mjs`). *Accept.*
- **A-3 (M), AD-15 "Only `src/extension.ts` wires the adapters together" is not what the code does.**
  - `src/adapters/vscode/bloblangLens.ts:15-16` imports `bloblangPanel/panels` and `sampleStore` (7d4c517).
  - `bloblangPanel/panels.ts` imports `graphPanel/{groups,html,tabs}`, `redpandaConnect/*` and `vscode/{detection,parseCache}`.
  - Similar imports predate the epic, and no lint rule bans them.
  - *Spec reconciliation:* amend AD-15 to the actual rule (adapters may import other adapters' pure helpers, never construct them), or add the lint rule. Defer.
- **A-4 (L), one new type-only cycle:** `src/adapters/vscode/diagnostics.ts:21` ↔ `bloblangDiagnostics.ts:22` (d2f2b27). No runtime cycles. *Defer* (code health).
- **A-5 (L), AD-1/AD-5/AD-21/AD-22 match the code.** They were amended in the deciding tickets: AD-1 four times (ARCH :50), AD-5 seven times (ARCH :81), AD-21 at 6b7a442, AD-22 at 72fe5f5. *Accept.*

**God-class / size growth**

- **G-1 (M), `src/adapters/bloblangPanel/panels.ts` grew from 347 to 1,579 lines across 12 commits** (4.2 → 4.13): 347 → 356 → 361 → 496 → 538 → 651 → 809 → 1,141 → 1,358 → 1,376 → 1,542 → 1,579. The largest steps were 4.10 (+332), 4.17 (+217), 4.18 (+166) and 4.16 (+158).
  - It holds two classes: `BloblangPanel` (:248-932, run, samples and the webview protocol) and the registry `BloblangPanels` (:933-1515, commands, tracking, tabs, rename, placement, focus).
  - **No unit test exercises it.** `src/test/adapters/bloblangPanel/` has only `sampleStore.test.ts`, so its behaviour is tested only through `src/test/integration/suites/90-bloblang-panel.ts`. That suite grew from 311 to 2,441 lines, and it is exactly where the flaky stable tests live (CI-2b).
  - This repeats E3 F12 for the graph adapter, which E3 routed to AI-6 (not landed; see follow-through).
  - *Disposition:* defer to a code-health story: split the registry's tabs, placement and focus code from the panel, and add a `Source` seam with fake-driven unit tests. *Lesson:* the 4.13 sweep scope (plan :20-36) took only deferred findings, never size.
- **G-2 (L), webview `TestPanel.tsx` is 759 lines and `TestPanel.test.tsx` 1,399.** Large, but one component with its states. *Accept.*
- **G-3 (L), `src/adapters/graphPanel/panels.ts` is 807 lines** (+193/−28 in the epic: placement, rename and the 4.13 `ready` change). *Accept.*

**Duplication map**

- **D-1 (M), the graph and test-panel registries each implement tab-close, rename-follow and placement.**
  - The pending-rename bookkeeping is now shared: 4.13 put the `PendingRenames` helper in `src/adapters/graphPanel/tabs.ts` (4.13 plan Implementation Notes).
  - The focus-return and confirm loop is written twice: the graph's `lockLate` (bug 15) and the panel's `returnFocus` (`panels.ts:1376`). 4.13 named the second one "the bug-15 pattern" (plan :49-53).
  - Line-level detail comes from the diff-review sub-agent (see Diff-scope review).
  - *Disposition:* defer, with G-1.

**Pattern divergence**

- **PD-1 (L), AI-8 held for every feat commit except DESIGN tokens.**
  - Every feat commit touches the architecture or UX docs (`git show --stat`), except 2a73cfa, the corpus harness.
  - `webview/src/bloblang/bloblang.css` used `--vscode-badge-*`, `--vscode-input-*` and `--vscode-button-border` from 7d4c517 (4.2), but DESIGN.md was first edited in 3f69db2 (4.11).
  - *Accept* (now in DESIGN :38-48). Noted for AI-8's wording ("tokens a webview starts using").

**Spec-to-implementation reconciliation (R1–R14, Done when 1–5, CAP-15..17)**

| Item | Status | Source | Suggested disposition |
|---|---|---|---|
| R1 | met; `try`/`catch`/`for_each` lists were missing until 4.12 | `src/core/bloblangProcessors.ts:56`; 2a73cfa; IT91 :234 TRY_CATCH_FIX | accept |
| R2 | met, narrowed: only `line L char C` parse failures become diagnostics, others only log | `bloblangDiagnostics.ts:25,27,89`; AD-21; EXPERIENCE :110; IT91 :335 | accept; reconcile R2 wording |
| R3 | **partial**: no node marker for an error at the very end of a mapping | backlog bug 20 :18-22 (d43d911); `nodeAt` half-open range (hypothesis in the bug, untested) | defer (bug 20 tracked) |
| R4 | met | `bloblangLens.ts:20`; `panels.ts:151`; IT90 :224, :253 | – |
| R5 | met | `TestPanel.tsx:134`; `bloblangRun.ts:174`; IT90 :295 | – |
| R6 | met; Copy error, per-error explanation and deleted-state matched line from the prototype not built | `hint.ts:24`; EXPERIENCE :112-115 | accept |
| R7 | met | IT90 :689 RECOVER | – |
| R8 | met, plus added behaviour (removed/undo state, shared test group, focus confirm) | `processorTracking.ts:34-80`; AD-1 amendments | accept |
| R9 | met; storage moved from the prototype's `.rpcn/samples/` to `<config>.samples.json` (user decision, AD-22, epic :80) | `samples.ts:57`; `sampleStore.ts:320` | accept (recorded) |
| R10 | met in code; the hands-on screen-reader check was optional | `TestPanel.tsx:660-661`; 4.14 plan :38 (C4) | accept |
| R11 | partial: compares the adapter (`bloblangRunner.ts`), not the panel; the only parse errors are synthetic (` +` on a new last line) | `corpus.test.ts:50-53, 96-97` | accept, and reconcile R11 / Done when 2 wording |
| R12 | met; no automated `.vsix` content check; C5 read the artifact of a **red** run (39433758016) and did not name `dist/bloblang.css` | `esbuild.js:78-92`; 4.14 plan :39 | defer (a `vsce ls` assertion in CI) |
| R13 | met; DESIGN late (PD-1) | ARCH :130, :142, :173, :198, :209 | accept |
| R14 | met (added mid-epic) | `bloblangProcessors.ts:97`; IT90 :2188-2328 | – |
| DW1 | met with gaps: "within about a second" is not asserted (IT91 waits 5–10 s; 300 ms debounce); graph marker gap (R3/bug 20); 4.14 C2 says a trailing ` +` did mark the node, while bug 20 (same day) says end-of-mapping errors don't | IT91 :149, :204; 4.14 plan :36; bug 20 :18 | defer (bug 20); open question Q1 |
| DW2 | met in CI at 6695328 (run 39484337467: corpus harness green on both versions); reinterpreted as adapter-level parity | `ci.yml:55-59`; R11 row | accept with spec reconciliation |
| DW3 | met; "after a window reload" is proxied by "a new panel finds them" (no panel serializer) | IT90 :891, :930, :1088 | accept |
| DW4 | met | IT90 :689 | – |
| DW5 | met per user decision: checked on 1.141.0 only (the text says 1.141 / 1.142); screen reader optional; 1.100 dropped by user decision (epic :45, :85) | 4.14 plan :34-47 | accept (user decision) |
| CAP-15 | met | SPEC :79-81 | – |
| CAP-16 | **diverged**: SPEC :85 still says "Opened from the processor (CodeLens, graph node)"; the graph-node entry was excluded by the user (epic :72), but no backlog item exists and the spec was not amended | SPEC :85; epic :72 | spec reconciliation (propose) |
| CAP-17 | met | SPEC :87-90, :145 | – |

### Diff-scope review

**How it ran (narrowing).** The `bmad-review` skill was not invoked over the full 19k-line diff. A sub-agent ran three lenses inline: adversarial, edge-case and verification-gap. It weighted ticket boundaries and covered these files at HEAD 6695328 (with their epic diffs):
- `bloblangPanel/panels.ts` (in full) and `sampleStore.ts`;
- `core/processorTracking.ts` and `core/samples.ts` (relink, change and metadata parts);
- `redpandaConnect/bloblangRunner.ts`, `bloblang.ts` and `commandLine.ts`;
- `graphPanel/panels.ts` (diff plus `open`, `graphColumn`, `tabsChanged` and `renamed`), `tabs.ts` and `groups.ts`;
- `webview/src/Graph.tsx` (the 7cc9bb5 fit code).

The sub-agent checked every finding against the Review Triage Logs of 4.9, 4.10, 4.13 and 4.16–4.19 and against deferred-work.md. Already-recorded items are left out: bug 17, the rejected batch renames and the rejected 30 s expiry. It did not review the TestPanel and SamplePicker internals, the diagnostics, the lens, the position map or the test suites, and it ran nothing. I re-checked R-4, R-9 and R-1 against the source.

| # | Sev | Lens | Boundary | Finding | Source | Suggested disposition |
|---|---|---|---|---|---|---|
| R-1 | M | adversarial / verification-gap | 4.16 × 4.10/4.17 | Add label relinks the samples entry to the label at once, but leaves the `label:` edit unsaved. After close-unsaved (the 4.17 last-tab close) or a revert, the entry is keyed by a label the saved YAML does not have. A reopened panel then links by path and shows no samples, and the lens shows 0. No test covers this. | `panels.ts:724-727` (61b77c5, d1a6cc5); `reset()` :425; `tabsChanged` :1033 (160f6c7) | defer (user design call: relink on save, or save the YAML) |
| R-2 | L | edge-case | 4.18 × 4.7 | From previous step passes the previous output's metadata on as string literals, so typed `@` values (for example `@n + 1`) behave differently than in the pipeline | `panels.ts:587` (6ed1358); `core/bloblangRun.ts:32` | defer/accept (document it) |
| R-3 | L | edge-case | 4.17 × 4.10 | `open()` reads `processor`/`processors` before `await placement()` (up to about 2 s) and the document text after it, so an edit made during placement pairs a stale processor with new text | `panels.ts:1324-1344` (160f6c7, 6ed1358) | fix now (small) |
| R-4 | L | adversarial | 4.17 × graph registry | Two definitions of a test group: `onlyTestPanels` (test panels only) vs `isTestGroup` (test panels plus any non-text, non-graph tab). With a Markdown preview in the test group, the graph can land in it unlocked. | `graphPanel/groups.ts:41,46`; `graphPanel/panels.ts:623` (160f6c7) | fix now (one predicate) |
| R-5 | L | verification-gap | 4.17 | `newGroupNextTo` can return `undefined` after focus has moved (it handles columns 1–8 only). The fallback `Beside` plus the unshifted `returnTo` can return focus to the wrong group. Untested. | `groups.ts:56-75`; `bloblangPanel/panels.ts:1429` | defer |
| R-6 | L | adversarial | bug 15 × 4.17 | The graph's `lockLate` (it watches for up to 5 s) and the test panel's `placement`/`returnFocus` run on separate queues with no coordination. Test mapping during a late lock can race for focus. **A plausible contributor to CI-3 (Q2), not shown.** | `graphPanel/panels.ts:685,768` (535afaf); `bloblangPanel/panels.ts:1376,1403` | defer into bug 19's investigation |
| R-7 | L | edge-case | 4.17 × 4.10 | The rename collision check counts *removed* panels as staying, so a live panel moved onto a removed panel's key is closed | `panels.ts:1055,1065` (160f6c7) | defer (with bug 17) |
| R-8 | L | edge-case | 4.18 × 4.10 | From previous step reads each step's samples by `linkOfProcessor(step)`, not by an open panel's actual `ref`, which can differ after a refused save relink | `panels.ts:562` (6ed1358) | accept/defer |
| R-9 | L | edge-case | 4.18 × 4.10 | From previous step checks `isDirty` but not `frozen()`. When a saved YAML does not parse, `current()` returns the last valid state, so the chain runs stale Bloblang and saves its output. | `panels.ts:538-547` (6ed1358) | fix now (refuse while frozen) |
| R-10 | L | edge-case | 4.19 × 4.17 | A graph webview recreated after a size change restores its old-size viewport. The first ResizeObserver report is the baseline, so there is no refit until the next resize. | `webview/src/Graph.tsx:131,178-179` (7cc9bb5) | accept/defer |
| R-11 | L | adversarial | 4.10 × 4.9/4.16 | `relinkOnSave` relinks only live panels. After an insert above, the old path entry of an unlabelled processor with no open panel attaches to whichever processor now has that path (misattribution, while AD-22 says "lost") | `panels.ts:1186-1232` (d1a6cc5); AD-22 | accept; reword AD-22 |

**Duplication detail (feeds D-1):**
- `tabsChanged`: graph `graphPanel/panels.ts:325-334` vs `bloblangPanel/panels.ts:1033-1042`. Only the Bloblang one checks `pendingRenames.creating(key)`.
- `renamed`: graph `:342-403` vs Bloblang `:1050-1090`. Both have identical `onWillRenameFiles` subscriptions (graph `:238-240`, Bloblang `:1016-1018`).
- `enqueue`: identical at graph `:513-517` and Bloblang `:1311-1315`.
- The YAML-column lookup is written three times: graph `columnOf` `:588-596`, Bloblang `editorColumnOf` `:1527` and `editorColumn` `:1516`.
- `tabs.ts:72` `openDocument` is re-implemented at Bloblang `:860`, `:1324`, `:1458` and `:1476`.
- Focus return follows two policies for one job: graph `lockAndReturn` `:735-775` (one check) and Bloblang `returnFocus` `:1376-1397` (settle plus retry).
- Graph `onlyGraphs` `:69-71` re-implements `groups.ts:26` `isViewTab`.

## Behavior verification

The runtime behaviour was exercised by the user, per ticket, in the dev host with a real `rpk`. Each plan's Verification records the manual check, for example:
- 4.6 plan :107;
- 4.8 :143;
- 4.15 :141 (no `rpk` on PATH);
- 4.16 :151;
- 4.11 :154;
- 4.13 :154 (which found bug 4.19);
- 4.19 :113.

4.14 (`story-test-panel-checks-by-hand-plan.md:34-47`) records C1–C4 as passed by the user on VS Code 1.141.0 with rpk connect 4.112.0 on 2026-10-20, and C5 as checked by Claude from a CI artifact.

**Narrowing:** this retrospective did not re-run the system or the test suites. One gap is worth a quick check before acceptance: Q1 (bug 20 vs C2, the end-of-mapping marker).

## Previous-retro follow-through

Source: `epic-pipeline-graph/epic-pipeline-graph-retrospective.md` Action items (:141-154). Its verdict was re-rendered `accepted` after AI-1 and AI-4, and AI-2, AI-3 and AI-5–AI-8 were left open (:182).

| Item (owner) | Landed? | Evidence |
|---|---|---|
| AI-1 "Graph interaction fixes across tickets" story (next build) | **landed** (before this epic) | entry 3.15, f3242f4 |
| AI-2 backlog stories for the F9 minor boundary items (bmad-ticket) | **no evidence found** | No backlog file was created on or after 2026-10-12 for F9. The only F9 link is the rename-collision item, moved to backlog bug 17 by 4.13 (`deferred-work.md` :8-9) |
| AI-3 reconcile spec/architecture/UX to the E3 build, F19 (user approves, then agent) | **partly landed** | EXPERIENCE :127's "Fit to view" is now true (button built in 7cc9bb5, 4.19). Not landed: AD-1 :48 still marks `retainContextWhenHidden: false` `[ASSUMPTION]`; the AD-5 table (ARCH :76-79) still lacks `retryRequested` / `focusEditorRequested` (present at `src/shared/protocol.ts:138-140`); the EXPERIENCE `[ASSUMPTION]` markers at :53, :128, :139 remain; no "eye-closed" in DESIGN |
| AI-4 3.7 navigation check, records for 3.2/3.3 (user + bmad-ticket) | **landed** (before this epic) | E3 retro :178-180 |
| AI-5 carry over E2 A1 and A4 as backlog stories (bmad-ticket) | **no evidence found** | No backlog file was added after 2026-10-12 for the docs-less schema or the four untracked limits (backlog creation dates via `git log --diff-filter=A`) |
| AI-6 code-health story: shared ancestor walk, `errorText`, `GraphPanelsSource` with adapter unit tests (backlog) | **no evidence found** | No backlog story. The same gap recurred in this epic (G-1: `bloblangPanel/panels.ts` has no unit tests) |
| AI-7 test and review the boundaries (bmad-build plans) | **landed** | Adopted at epic :76. 15 of 19 plans mention boundaries or AI-7; suite 90 has 9 and suite 91 has 2 BOUNDARY/AI-7 tests (`grep -c`) |
| AI-8 amend docs in the deciding ticket (process) | **landed, one lapse** | Adopted at epic :77. Every feat commit touches ARCH/UX except 2a73cfa; the DESIGN tokens lapse (PD-1) |

## Action items

Decided by the user (2026-10-21). Selected: "fix bug 19 next" and "process rules". Every item is proposed; none is applied by this retrospective.

| # | Action | Kind | Owner | From |
|---|---|---|---|---|
| AI-1 | **Correct and extend backlog bug 19, raise it to P1, and build it next, before any new feature work.**<br>Corrections:<br>• remove "PLACE_WITH_GRAPH … fixed by 4.13";<br>• add runs 39354646781, 39444568138 and 39482409309 (PLACE_* `2 !== 1` / `2 !== 4` at `90-bloblang-panel.ts:2042, :2071`);<br>• fix the run 39433758016 attempt-2 description (a startup freeze, not test 3.7);<br>• name the `activeTabGroup` vs `activeTextEditor` mismatch with `returnFocus` (`panels.ts:1376-1393`);<br>• add the startup-freeze mode (CI-4) and R-6.<br>Accepted only on 8 green runs in a row on a 2-CPU-pinned machine and in CI, counting every attempt. | fix now (ticket edit, then build) | bmad-ticket, then bmad-build | C-1, C-2; CI-1–CI-4, R-6 |
| AI-2 | **Process: a runner-like gate for focus and layout tests.**<br>• A plan that adds or changes an integration test asserting focus, the active editor or group layout runs that suite N times (default 5) pinned to 2 CPUs (`taskset -c 0,1` under `xvfb-run -a`, alone) before the ticket is called built.<br>• A fix for a CI flake is accepted only on N green CI runs, counting every attempt. | process | bmad-build plans (Verification) | C-3; P1, P4, P5 |
| AI-3 | **Process: watch CI on every push, including `chore(tickets)` commits.**<br>• Record every failed run and attempt (id, test, label) in the plan or in deferred-work.md.<br>• A red run on an unchanged tree is a flake data point, not noise.<br>• Never report "green in a row" from the last attempt alone. | process | orchestrator / bmad-build | C-4; P3, P5 |
| AI-4 | **Process: a test-determinism question in every per-ticket review:** "which assertions read focus, the active editor or the layout without waiting for that same signal?" | process | review prompts in bmad-build plans | C-5; P7, CI-3 |

**Not selected by the user (recorded, deferred, re-raise at the next retro):**
- C-6, the spec reconciliation: CAP-16 graph entry point, R11 parity level, R2.
- C-7, the code-health story: panels.ts split, shared registry helpers, unit seams, the import cycle, AD-15. Merges with E3 AI-6.
- C-8, bug 20 first. It is already in the backlog.
- C-9, a CI `.vsix` assertion.
- C-10, the E3 AI-2/AI-3/AI-5 carry-over.
- C-11, the boundary fixes R-3, R-4 and R-9, and the R-1 design question.

## Acceptance verdict

**accepted-with-open-items** (human decision, 2026-10-21; criteria declared; no unfinished tickets; it matches the machine verdict).
- **Done when 1:** met in the evidence: IT91 :196-533 with a fake binary, plus the corpus parse check. Open: the end-of-mapping marker (backlog bug 20) and the one-second bound, which no test asserts.
- **Done when 2:** met. The corpus harness was green on both versions at 6695328 (run 39484337467). Parity is checked at the adapter level (C-6, not selected).
- **Done when 3 and 4:** met (the tests named in Findings).
- **Done when 5:** met as the user amended it: VS Code stable only (1.141.0), the screen reader optional, and the `.vsix` carrying the panel (C5).
- **Open items tracked:** stable CI flakiness (AI-1, backlog bug 19, to be built next) and bug 20.

## Open questions

- **Q1 (answered, 2026-10-21):** they differ by case. In 4.14 C2 the trailing ` +` made the binary report the error on the next line (Ln 14, inside the mapping), so the node was marked. Bug 20 is an error at the mapping's very last position. No contradiction. Original question: bug 20 (d43d911, 2026-10-20) and 4.14 C2 (same day: "a trailing ` +` … on the `greet` node") disagree about the end-of-mapping graph marker. Which is right, or do they differ by case (an error past the last character vs on the last line)? A quick dev-host check would settle DW1's marker half.
- **Q2:** Is the PLACE_* failure product behaviour (the graph group activating late, after `returnFocus` has confirmed) or only the test's order of reads? It decides whether bug 19's fix is in `panels.ts` or only in suite 90.
- **Q3:** Should the floor (1.100.0) keep running in CI at all, given it is non-blocking and won't-fix? It spends CI time and still turns runs red on the floor step's own status.
