---
epic: epic-smart-yaml-editing
date: 2026-10-08
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective — epic-smart-yaml-editing (E2)

## Epic summary

- **Epic:** `epic-smart-yaml-editing`, "Smart YAML editing and local run" (risk medium). Done when has 5 declared criteria (`epic-smart-yaml-editing.md`, section Done when).
- **Tickets:** 21 in build order. 2.12 is `done`; the other 20 are at `built` (state `review`), finished by the build and not yet called done. `pending_tickets` is empty, so no unfinished ticket was retro'd over.
- **Scope growth:** the inception planned 12 tickets (2.1–2.12). Nine more (2.13–2.21) were added mid-epic at the user's request after manual checks (E2 Notes, Decisions dated 2026-10-07 and 2026-10-08).
- **Going-in concerns:** none (user, 2026-10-08).

### Tickets and ranges

Ranges run from each plan's `baseline_revision` to the next baseline in history order. The last one runs to `HEAD` (058a527), marked inferred. No range contains a merge (`merge_count` 0 throughout).

| Ticket | Title | Status | Review | Range | Commits | Lines added |
|---|---|---|---|---|---|---|
| 2.1 | Detected config gets completion and hover from the binary's schema | built | quick | 11565f1..8795d9b | 1 | 976 |
| 2.2 | Complete file detection | built | quick | 8795d9b..b712737 | 2 | 545 |
| 2.3 | Spawn site: caller environment and a streaming child handle | built | full | b712737..63e71f7 | 2 | 570 |
| 2.4 | Lint on save shows diagnostics | built | full | 63e71f7..554095e | 1 | 1346 |
| 2.5 | Quick Fix for unknown fields | built | full | 554095e..990a6dc | 1 | 888 |
| 2.6 | Diagnostics parity in the corpus harness | built | quick | 990a6dc..10da87e | 1 | 305 |
| 2.7 | Run and Stop in a per-file terminal | built | full | 10da87e..98c0d96 | 1 | 1267 |
| 2.13 | Schema completion fixes: incomplete components and value options | built | quick | 98c0d96..5619a4e | 1 | 330 |
| 2.14 | Quick Fix for invalid option values | built | quick | 5619a4e..d371572 | 1 | 499 |
| 2.15 | Hover lists a field's options | built | quick | d371572..c1002a6 | 1 | 165 |
| 2.16 | Completion where Red Hat returns none | built | full | c1002a6..29a239c | 1 | 732 |
| 2.17 | Required fields item in a new component block | built | quick | 29a239c..e287d7c | 1 | 253 |
| 2.18 | Completion for empty list items inside a component | built | quick | e287d7c..c3150a5 | 1 | 173 |
| 2.8 | Feedback when the schema or binary changes | built | quick | c3150a5..e46568c | 1 | 196 |
| 2.9 | Bloblang highlighting | built | quick | e46568c..23b9119 | 1 | 625 |
| 2.19 | Bloblang function and method completion and hover | built | full | 23b9119..623ebf9 | 1 | 693 |
| 2.20 | Bloblang completion of names already written | built | quick | 623ebf9..161f324 | 1 | 435 |
| 2.21 | Bloblang methods narrowed by a known type | built | quick | 161f324..acb91aa | 1 | 267 |
| 2.10 | Pipeline snippets | built | quick | acb91aa..abae6f9 | 1 | 429 |
| 2.11 | CI runs the suite against VS Code 1.100 | built | quick | abae6f9..98c8b82 | 1 | 79 |
| 2.12 | Refactor sweep | done | quick | 98c8b82..058a527 (inferred) | 11 | 1765 |

Epic-wide: 11565f1..058a527, 33 commits, 113 files, +11,140 / −124 (68 files and +8,348 in `src`, `syntaxes`, `test` and `package.json`).

### Evidence inventory

- **Available:**
  - the epic file and its Notes;
  - the initiative Requirements (E2 R1–R11);
  - `tickets.toml` entries;
  - 21 plans, all with a baseline, Implementation Notes, a Review Triage Log and Verification;
  - git history for every range;
  - CI run history;
  - the E1 retrospective;
  - session logs: 2 Claude Code transcripts under `~/.claude/projects/-home-aleksejjurcenko-projects-clients-personal-rpcn-vscode-byoc-plugin/`, the current one `268853b3-….jsonl`.
- **Missing:**
  - story files (no ticket was refined; `refined: false` on every row);
  - `## Code Review` dated blocks (reviews were recorded in each plan's Review Triage Log instead).

## Findings

Sources:
- three read-only subagent analyses: aggregate views (by script and by reading), spec and process reconciliation, and the `bmad-review` lenses (adversarial, edge-case, verification-gap) over `11565f1..058a527`, with esbuild-bundled probes of `src/core`;
- the parent's behaviour check (above).

The parent re-checked every finding marked ✓ against its primary source before routing it. Dispositions: **fix** (action item), **defer** (tracked, with context), **accept** (recorded so later retros stop re-flagging).

### Cross-ticket code findings (bmad-review lenses)

| # | Finding | Sev | Tickets (boundary) | Source | Disposition |
|---|---|---|---|---|---|
| F1 ✓ | A schema built without docs (`list --format json-full` failed or timed out) is written under the normal cache key and served on every later start. Since E2 this silently removes the Bloblang catalog, the option enums, the option Quick Fixes, the gap value items and the `Options:` hover line, not only descriptions. The log still says only "the schema has no descriptions or defaults", and later starts say only that the cached schema is used. Recovery needs Refresh Schema or a new binary version. | medium | E1 1.6 ↔ 2.13–2.15, 2.19–2.21 | `src/adapters/redpandaConnect/schema.ts:248-268`; `src/core/schema.ts:117-129` | fix → A1 |
| F2 ✓ | Applying one Quick Fix is a content edit, so the R3 first-edit rule clears every other lint finding in the file and their fixes, until the next save. Several fixes in a row, or Auto Fix across findings, cannot work. R3 required the clear; no ticket weighed it against the Quick Fixes. | medium | 2.4 ↔ 2.5, 2.14 | `src/adapters/vscode/diagnostics.ts:89-93`; R3 (epic Requirements) | decide → A2 |
| F3 | On a nested `processors:` list item (for example in a switch case), gap completion and snippets both answer: `log` / `log processor`, `mapping` / `mapping processor`, `switch` / `switch processor`. The 2.16 NO_DUPLICATES guard was changed in 2.10 to filter snippet items out, so nothing asserts the merged list the user sees. | low | 2.18 ↔ 2.10 | `src/core/gapCompletion.ts:133-138`; `src/core/snippets.ts`; `src/test/integration/suites/20-gap-completion.ts:21-25` | fix → A5 |
| F4 | In a YAML double-quoted value, `${! … }` is not un-escaped. In `"${! \"a\". }"` the scanner sees `\"` as an open string and offers nothing, and `${! "}" }` ends the region early. Bloblang field regions are un-escaped; interpolation regions are not. Confirmed by probe. | low | 2.19 ↔ 2.21 | `src/core/bloblang.ts:148`, `:218-221` | defer → A5 |
| F5 | The region scanner and the TextMate injection disagree about where Bloblang is: `${! }` inside a YAML comment gets completion and hover but no highlighting; the continuation line of a multi-line plain value, flow mappings and quoted keys get completion but no highlighting. The sync test checks only the field-name list. | low | 2.9 ↔ 2.19 | `src/core/bloblang.ts:135`; `syntaxes/bloblang.injection.tmLanguage.json`; `src/test/bloblang.test.ts:48` | accept (cosmetic; recorded) |
| F6 | Lint findings from the previous binary stay published after Set path, Retry or Refresh Schema until the next edit or save; nothing re-lints on a binary change. | low | 2.8 ↔ 2.4 | `src/extension.ts:28-38`; `src/adapters/vscode/diagnostics.ts` | defer → A5 |
| — | Checked and clean: the shared parse cache (no consumer mutates the parse; keyed by URI and version; cleared on close); no snippets inside Bloblang values; no Bloblang outside its regions; detection changing during lint or Run; Run's auto-save triggering lint; transform version 6 in the cache key. | — | — | bmad-review report; 2.12 review | — |

### Aggregate views

**Architecture delta** (by script; import graph of non-test `src` at 11565f1 vs HEAD):
- Modules went from 11 to 31.
- New edges: redhatYaml→core, redhatYaml→redpandaConnect (type-only), vscode→core, vscode→redpandaConnect (`run.ts`, `diagnostics.ts`), and extension→redhatYaml/vscode.
- No layering violation: no `vscode` or adapter import in core; `yaml` only in `core/{yamlPath,gapCompletion,bloblang}.ts` (AD-2); `child_process` only in `process.ts` (AD-15).
- New type-level cycle `core/schema.ts` ↔ `core/bloblangCatalog.ts` (the catalog side is `import type`; 1a55e6a); E1's `notify.ts` ↔ `binary.ts` remains.
- `core/lint.ts:10` imports Node's `path` (2.4); E1 already had `crypto` in core.

Disposition: **accept** (no violation; the type cycle and `path` are recorded).

**Duplication map** (by reading):

| # | Finding | Sev | Source | Disposition |
|---|---|---|---|---|
| D1 ✓ | The same schema-walk loop (`expand`, then `items` / `properties[step]`) appears three times, written in three tickets. `fieldsAt` and `optionsAt` could use `nodesAt`. | medium | `src/core/schemaFields.ts:30-39`, `:79-89`, `:104-113` (2.5, 2.14, 2.16) | fix → A5 |
| D2 | Five hand-written YAML tree visitors | low | `yamlPath.ts` `collect` :166, `collectValues` :109; `gapCompletion.ts` `allItems` :259, `allPairs` :282; `bloblang.ts` `regions.visit` :113 | defer → A5 |
| D3 | Offset-to-line lookups written three times; the parse's `LineCounter` is not reused | low | `gapCompletion.ts:64-67`, `:244-248`; `bloblangNames.ts:38` | defer → A5 |
| D4 | Snippet escaping and shape switches repeated | low | `gapCompletion.ts:193`, `:220`, `:171`, `:202`; `bloblangCatalog.ts:129`; `snippets.ts:142` | defer → A5 |
| D5 | Four interfaces over `DetectionRegistry`, and the "detected and has a schema" guard repeated in each provider (twice in the Bloblang provider) | low | `contributor.ts:40`; `diagnostics.ts:35`; `run.ts:80`; `completion.ts:20-22`; `vscode/bloblang.ts:25-27`, `:86-88`; `snippets.ts:68` | defer → A5 |
| D6 ✓ | `errorText` copied byte for byte | low | `src/adapters/redhatYaml/contributor.ts:15` vs `src/adapters/redpandaConnect/text.ts:4` | fix → A5 |
| D7 | Top-level keys computed twice (regex scan vs parse) | low | `core/detection.ts:40`; `core/yamlPath.ts:30` | accept (detection must work without a parse; AD-18) |
| D8 | Test helpers duplicated: the cursor-marker parser in four test files (`|` in one, `§` in three), `applied()`, `tick`, `waitFor` | low | `src/test/core/{bloblang,bloblangNames,gapCompletion,snippets}.test.ts`; `quickFix*.test.ts`; `diagnostics.test.ts:80`; `run.test.ts:56` | defer → A5 |

**Size growth** (net churn by script; each file read before flagging):

| Net | File | Read | Disposition |
|---|---|---|---|
| +419 | `src/adapters/vscode/run.ts` (2.7 only) | `RunController` spans about 240 lines (:178-416), covering sessions, terminals, context keys, saving and logging; `RunPty` and the text helpers are in the same file | defer → A5 (split `RunPty` and the text helpers) |
| +300 | `src/core/bloblang.ts` | already split once (1a55e6a): regions, lexer, context, items, hover | accept |
| +299 | `src/core/gapCompletion.ts` | context, items, snippet text and three walkers | defer → A5 (with D2 and D4) |
| +252 | `src/adapters/vscode/diagnostics.ts` | `LintDiagnostics` is about 160 lines | accept |
| +219 / +209 / +187 / +185 | `schemaFields.ts` / `bloblangNames.ts` / `yamlPath.ts` / `detection.ts` | the growth in `schemaFields.ts` is mostly D1 | covered by D1 |
| (process) | `src/test/extension.test.ts` | grew from 220 to 1,066 lines over 16 ranges before the split in c742d9e | accept (fixed in 2.12) |

**Pattern divergence** (by reading):

| # | Finding | Sev | Source | Disposition |
|---|---|---|---|---|
| P1 | E2 providers wrap their whole body in `try { … } catch { return [] }` with no log, and core functions swallow errors too. E1 code uses typed results plus `log`. A provider bug becomes silently missing completions. | medium | `completion.ts:46`; `snippets.ts:35`; `vscode/bloblang.ts:79`, `:97`; `quickFix.ts:44`; `yamlPath.ts:42`, `:68`, `:104`, `:148`; `gapCompletion.ts:108`; `bloblang.ts:255`, `:297` | defer → A5 (log once per failure to the output channel; keep "never throws") |
| P2 | `String(err)` where E1 has `errorText`; the `LogLine` type restated inline; `LintQuickFix` takes a bare function where the other providers take an options object; a module-level mutable `Map` in `parseCache.ts` | low | `diagnostics.ts:44`, `:153`; `lint.ts:40`; `run.ts:103`, `:245`; `quickFix.ts:24`; `parseCache.ts:8` | defer → A5 |
| P3 | Test layout drifts from E1's mirror of `src`: `src/test/bloblang.test.ts` sits at the root, `quickFixCore.test.ts` is named after no module, and `yamlPath.ts`, `schemaFields.ts`, `suggest.ts` and `bloblangCatalog.ts` have no test file of their own (they are covered through other suites). The vscode `completion`, `snippets` and `bloblang` providers are tested only by integration suites. | low | `src/test/**` | defer → A5 |

**Spec-to-implementation reconciliation** (by reading; the parent re-checked S1, S2 and S4 in the spec and architecture text):

| # | Divergence | Source | Disposition |
|---|---|---|---|
| S1 ✓ | CAP-4 says "no Bloblang completion or diagnostics are provided", and the Non-goals list "Bloblang LSP, completion or diagnostics". 2.19–2.21 built completion and hover. AD-14 was amended (memlog) but the spec was not. | `spec-rpcn-vscode-designer.md:37`, `:102` | spec reconciliation → A3 |
| S2 ✓ | AD-10's transform rule lists only `$schema`, interpolation and doc merge, and says "no own `HoverProvider`". As built, the transform also drops `required`, keeps `x-rpcn-required`, adds value options, adds the `Options:` hover line and carries the Bloblang catalog, and a Bloblang `HoverProvider` is registered. | `architecture-…md:111-114`; `src/core/schema.ts`; `src/extension.ts` | spec reconciliation → A3 |
| S3 | R5 and CAP-3 say "one Quick Fix type", but two are built (2.14 adds invalid option values; recorded only in an epic note). | epic R5; `quickFix.ts:15-16`; epic Notes | spec reconciliation → A3 |
| S4 ✓ | AD-12 says "our own providers add only lint diagnostics, Quick Fixes and snippets", leaving out gap completion and Bloblang completion and hover. AD-14 "Binds" names only `syntaxes/`. AD-11 has no wording for the required-fields item (2.17). AD-14's amendment does not cover names already written (2.20) or type narrowing (2.21). | `architecture-…md:126`; memlog :75-77 | spec reconciliation → A3 |
| S5 | R6, CAP-4 and Done when 3 say "`mapping`, `check`"; the build covers 26 fields and highlights in every YAML file, not only detected ones (2.9 decision). | epic R6; `src/core/bloblangCatalog.ts`/`bloblang.ts` `BLOBLANG_FIELDS` | spec reconciliation → A3 |
| S6 | CAP-2 and EXPERIENCE:82 promise live schema errors and "completion offers only valid keys and values"; AD-12 (amended) and 2.13 (no `required`, free-string options) contradict this. | `spec…md:29`; `EXPERIENCE.md:82` | spec reconciliation → A3 |
| S7 | EXPERIENCE Run control does not mention SIGKILL after 10 s, the second Stop, "Pipeline stopped", Ctrl+C, or Run following each editor; Flow 3 still picks `kafka_franz` (deprecated; the snippets use `redpanda`). | `EXPERIENCE.md:107-109`, `:178` | spec reconciliation → A3 |
| S8 | R10 is narrowed: parity feeds recorded stderr through the pure parser and does not check the published, deduplicated VS Code diagnostics (the 2.6 Never). Done when 5's "the CI `.vsix` carries it" has no clear referent (`.vscodeignore` excludes `test/**`). | `test/corpus/corpus.test.ts:19-22`, `:204`; 2.6 plan | accept (recorded) + wording → A3 |
| S9 | The epic Boundaries' ownership list leaves out the new modules (`adapters/vscode/{completion,bloblang,parseCache}.ts`, `src/core/{gapCompletion,schemaFields,suggest,bloblang*,yamlPath}.ts`). "No webview" holds. | epic Boundaries | spec reconciliation → A3 |

### Process lessons (from the plans and session logs)

| # | Lesson | Source | Disposition |
|---|---|---|---|
| L1 ✓ | Review depth did not follow risk. Medium-risk 2.18 and 2.20 got a quick review with `review_source: 'risk'`, and 2.1 was pinned to quick. Nine quick reviews were done inline by the building session, each "No findings": 2.8, 2.9, 2.10, 2.11, 2.15, 2.17, 2.18, 2.20, 2.21. The full reviews (2.3, 2.4, 2.5, 2.7, 2.16, 2.19) each found high or medium findings. F3 and F4 sit exactly in quick-reviewed extensions of full-reviewed code (2.10 / 2.18 over 2.16; 2.21 over 2.19). | `tickets.toml` risk; plan frontmatter; E1 retro A6 | action → A6 |
| L2 | Red Hat's behaviour was assumed and then disproven by probe five times: `'{}'` needed (2.1), empty value (2.13), empty component block, `http.tls` (2.16 bad_plan), list items. The binary's behaviour was found by real-binary checks four times: lint globs targets and `yaml: line N` names the wrong line (2.4), exit 0 on SIGINT (2.7), `kafka_franz` deprecated (2.10). Probes before the plan froze would have saved the bad_plan and the renegotiations. | 2.1, 2.4, 2.7, 2.10, 2.13 and 2.16 plans; epic Notes :84, :87 | action → A7 |
| L3 | Scope grew from 12 to 21 tickets through user requests after manual checks. Each was anchored in a decision note, but the spec and architecture text were not amended in the ticket that decided the change (S1–S7). E1's F10 prevention ("reconcile upstream docs in the same ticket that decides the change") was not followed. | epic Notes; E1 retro F10 | action → A3, A7 |
| L4 | Manual checks listed in Verification were not recorded as done for 2.1, 2.2, 2.4, 2.13 and 2.16 (2.7's was explicitly not run and is now backlog 9). | plans' Verification sections | action → A8 |
| L5 ✓ | Known limits recorded in plans but not tracked anywhere: the block-scalar option value gets no fix (2.14); detection line-scan false positives and top-level flow mappings not detected (2.1); free-key maps (`headers:`) and string-valued components (`inproc:`) that neither side completes (2.16 sweep); Run's `when` clause untried in a remote window (2.7 A4); lowercase `no_color` on Windows (2.3 A6, not in the Windows story). Also, backlog `story-literal-glob-characters-in-resource-files.md` is still open although its plan is `status: dropped`. | 2.1, 2.3, 2.7, 2.14 and 2.16 plans; `_bmad-output/backlog/` | action → A4 |
| L6 | Wins: every Red Hat assumption was probed and every probe result was recorded. Full reviews caught the real highs (2.4 lint target glob, 2.16 duplicates with Red Hat and a vacuous guard, 2.19 double-quoted Bloblang). AD-2 and AD-15 held over 20 new modules. CI ran green on both VS Code versions from 2.11 on. The corpus parity check and snippet lint-clean tests run on both binaries. | above; CI history | accept (win) |

## Behavior verification

**Exercised end to end (2026-10-08).** A throwaway mocha suite, not committed, ran in the extension host: VS Code 1.141.0, real YAML by Red Hat 1.24.0, and the real pinned Redpanda Connect **4.112.0** binary (`.cache/redpanda-connect/4.112.0`, set as `binaryPath`, with `rpk`/`redpanda-connect` filtered out of PATH). It ran from a scratch git worktree at 058a527, which was then removed. 3 of 3 checks passed in two runs; the observations are the logged values.

| Flow (Done when) | Observed |
|---|---|
| Binary and schema (DW1) | Binary state `ok` 4.112.0. Schema generated from the real binary (`Schema: generated for Redpanda Connect 4.112.0 …`). |
| Schema completion and hover (DW1) | 10 items after `input:`. Hover on `stdout` shows "Prints messages to stdout as a continuous stream of data." |
| Gap completion (2.16) | 9 items in an empty `socket:` block, including `address` and `network`. |
| Bloblang (DW3, 2.19/2.21) | 122 method items after `"a".`, including `uppercase` and excluding `sum` (narrowed to string). Hover on `now()` answers. |
| Snippets (DW3) | A blank YAML file offers "Redpanda Connect pipeline" and the input, output and pipeline sections (filter text `rpcn-…`). |
| Lint on save and Quick Fix (DW2) | Real lint reported `value tpc is not a valid option for this field` (line 3) and `field intervall not recognised` (line 5), both Errors on whole lines. "Change to `tcp`" was preferred. Applying it cleared the findings on edit, and re-saving left only line 5. `intervall` under `socket_server` gets no fix, since the component has no close field. In the first run, `intervall` under `generate` got "Change to `interval`" (preferred). |
| Run and Stop (DW4) | Run started the real binary: a `generate` → `file` pipeline wrote ≥3 lines while running. Stop ended it in 52 ms with no further output. Run again resumed writing and reused the single "Redpanda Connect: run.yaml" terminal. |

**Not exercised here:**
- terminal *rendering* (the Pseudoterminal's text is not readable through the VS Code API, so streaming was observed through the pipeline's own file output);
- the status-bar text;
- Set path through the notification UI;
- the 1.100.0 floor with the real binary;
- 4.100.0 with the real binary (the corpus harness covers lint parity on both binaries in CI);
- the `.vsix` install (covered by CI packaging, DW5).

The user checked Run, completion, enum values and Bloblang by hand in the Extension Development Host during the epic (session log `268853b3-….jsonl`; E2 Notes "2.7 manual check").

## Previous-retro follow-through

The previous retrospective is `epic-foundation/epic-foundation-retrospective.md`. Its Action items section has A1–A6:

| E1 item | Owner | Landed? | Evidence |
|---|---|---|---|
| A1: decide and specify feedback for user-triggered commands with no visible effect (Refresh Schema with no binary; Retry with nothing changed) | product owner, at E2 inception | **Landed for Refresh Schema; no evidence for Retry** | Decision in the epic Notes (2026-10-06); built in 2.8 (`REFRESH_NO_BINARY_LINE`, `src/extension.ts`; test `src/test/integration/suites/70-feedback.ts:49`). The 2.8 plan routes Retry through the same refresh path but specifies no feedback for a Retry that changes nothing. |
| A2: reconcile the architecture with the as-built test setup and the Node pin | architect | **Landed** | a7b6b77 (architecture Tests convention and Stack; memlog line) |
| A3: reconcile upstream docs (spec Open Questions, CAP-14 corpus, AD-9 and R4 flags, the 1.6 `defaultSnippets`) | bmad-spec / architecture / ticket | **Landed** | a7b6b77 |
| A4: run the suite against VS Code 1.100 in CI | E2 | **Landed** | 98c8b82 (2.11); `.vscode-test.mjs` `floor` label; CI green on both from then on |
| A5: settle cross-cutting decisions at E2 inception, before the first build | E2 inception | **Partly** | The validation source (AD-12 amended), the range rule and resource files were decided at inception or in 2.2 (epic Notes). Review still renegotiated intent in 2.5 (2 intent gaps, 3 bad_plan) and 2.7 (4 intent gaps) (L2). |
| A6: review depth per ticket risk; the full lens set for medium/high risk | user, per build | **Partly** | Full lens set on 2.3, 2.4, 2.5, 2.7, 2.16 and 2.19. Quick on medium-risk 2.1 (pinned), 2.18 and 2.20 (L1). |

## Action items

Everything here is **proposed**. Remediation goes to the normal dev loop, and spec reconciliation awaits the human, who applies it through `bmad-spec` / `bmad-architecture` / `bmad-ticket`. Nothing was applied by this retrospective.

| # | Action | Owner | Kind | From |
|---|---|---|---|---|
| A1 | Don't serve a docs-less schema as if it were complete. Either don't cache it (or cache it under a key that is retried on the next activation), and make the log line say which features are missing (Bloblang completion, option values, `Options:` hover). Add a test for the persistence. | dev loop (bug story) | remediation | F1 |
| A2 | Decide what a Quick Fix edit does to the other lint findings. **Decided (user, 2026-10-08): "go with D now, add a backlog story for B".** D, a "Fix all" action applying every clear-winner fix as one edit, is ticket 2.22 in this epic. B, keeping findings on untouched lines and moving them with the edit, is backlog story 10 (`_bmad-output/backlog/story-keep-lint-findings-on-lines-an-edit-did-not-touch.md`). The R3/AD-17 rule is unchanged for now. | product owner (user) | decided → ticket 2.22 + backlog 10 | F2 |
| A3 | Reconcile the spec, architecture, UX and epic text with the as-built: CAP-2, CAP-3 (two fix types), CAP-4 and the Non-goal (Bloblang completion and hover), AD-10 (transform steps, own hover), AD-11 (required-fields item), AD-12 (own providers list), AD-14 (names already written, type narrowing, Binds), R5, R6 and Done when 3 (the field list, every YAML file), R10 and Done when 5 wording, the Boundaries ownership list, and EXPERIENCE Run control and Flow 3 (`redpanda`, not `kafka_franz`). Each with a memlog line. | architect / pm (bmad-spec, bmad-architecture, bmad-ticket) | spec reconciliation | S1–S9, L3 |
| A4 | Track the untracked limits as backlog stories or epic notes: block-scalar option fix; detection false positives and flow-mapping configs; free-key maps and string components with no completion; Run `when` in a remote window; add lowercase `no_color` to the Windows story; close or drop the stale literal-glob backlog story. | ticket owner (bmad-ticket) | backlog hygiene | L5 |
| A5 | A code-health story (the next refactor sweep or a backlog story): `fieldsAt` / `optionsAt` on `nodesAt` (D1); one `errorText` (D6); the gap vs snippet overlap on nested processor items, with a guard test over the merged list (F3); `${! }` un-escaping in double-quoted values (F4); re-lint or clear on a binary change (F6); log swallowed provider errors once (P1); a shared detection interface and guard (D5); shared test helpers (D8); the low items D2–D4, P2, P3 and the `run.ts` split as capacity allows. | dev loop | remediation (deferred) | F3, F4, F6, D1–D8, P1–P3 |
| A6 | Review depth follows risk without exceptions: medium and high risk get the full lens set. A quick review is done by a fresh subagent, not inline by the building session. A ticket that extends code a full review found highs in gets the full set too. | user, per build | process lesson | L1; E1 A6 |
| A7 | Probe external behaviour (Red Hat, the binary) before the plan freezes, and amend the spec or architecture in the same ticket that decides a change. | ticket planning (bmad-build plan step) | process lesson | L2, L3; E1 F10 |
| A8 | Record each manual check's outcome (done, by whom, the result) in the plan's Verification section, or move it to an automated or backlog check. | builder, per ticket | process lesson | L4 |

## Acceptance verdict

**Machine verdict: accepted-with-open-items.** The criteria are **declared**: the epic file's Done when 1–5.

| Done when | Met? | Evidence |
|---|---|---|
| 1. Completion and hover from the user's binary via Red Hat in a detected config; appear after Set path without reopening | met | Behaviour check with the real 4.112.0 binary; `10-schema.ts` DETECTED / SCHEMA_CHANGES; `70-feedback.ts` SET_PATH_OPEN_FILE |
| 2. Lint findings inline on save, deduplicated against schema diagnostics, Quick Fixes as minimal-range edits | met (F2 open) | Behaviour check (real lint, preferred fixes, clear on edit); `50-lint.ts`; `diagnostics.test.ts` |
| 3. Bloblang in `mapping`, `check` and `${! }` highlighted; snippets scaffold pipeline sections | met (wider than written, S5) | `src/test/bloblang.test.ts` (grammar tokens); behaviour check (snippets in a blank file); corpus snippet lint-clean tests |
| 4. Run auto-saves, streams logs to a per-file Pseudoterminal, Stop interrupts; untitled files cannot Run | met | Behaviour check (real pipeline output, Stop in 52 ms, terminal reused); `60-run.ts` RUN / STOP / RERUN, DIRTY, untitled |
| 5. Diagnostics match `rpk connect lint` for every corpus config, checked in CI; the CI `.vsix` carries it | met as built (narrowed, S8) | `test/corpus/corpus.test.ts` parity on 4.100.0 and 4.112.0 (89 tests) in CI; CI packages the `.vsix` |

- All 21 tickets are finished (`pending_tickets` empty). No finding is blocking.
- The open items are F1 and F2 (medium), the spec reconciliation (A3) and the deferred low code items (A5).
- 20 tickets are still at `built` (state `review`). Closing the epic and marking them done is `bmad-ticket`'s job, confirmed by the user.

**Human decision:** none yet on the verdict. After the retrospective, the user added ticket 2.22 for F2 (2026-10-08). It is unfinished, so the epic cannot be closed until it is built; the machine verdict above was rendered before it was added.

## Open questions

- ~~F2 / A2: should applying a Quick Fix keep the other lint findings visible?~~ Answered (user, 2026-10-08): "Fix all" now (2.22), keeping findings on untouched lines later (backlog 10).
- F1 / A1: should a schema built without docs be cached at all, or regenerated on the next activation?
- S8: what did Done when 5's "the CI `.vsix` carries it" mean? The harness is excluded from the `.vsix` by design.
- Whether A3's spec reconciliation is done before E3 starts. E3's inception reads CAP-4, AD-10 and AD-12, which are currently stale.
