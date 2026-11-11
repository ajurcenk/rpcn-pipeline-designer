---
epic: epic-deploy-to-redpanda-cloud
date: 2026-11-09
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective: Deploy to Redpanda Cloud (epic 5)

## Epic summary

- Epic: `epic-deploy-to-redpanda-cloud` (id 5), 9 tickets, all `done` (`tickets.py status`, 2026-11-09): 5.1 spike (hitl), 5.2–5.9 stories. None at `built`; `pending_tickets` empty.
- Criteria: the epic file's Done when, 5 items (`epic-deploy-to-redpanda-cloud.md:37-43`).
- User's going-in concerns: none ("go").

### Ranges (from each plan's `baseline_revision`, in history order)

| Ticket | Range | Commits | Note |
|---|---|---|---|
| 5.1 | 452ff63..0221c53 | 2 | spike, captures and `scripts/spike/cloud-probe.mjs` |
| 5.2 | 0221c53..2f01972 | 3 | |
| 5.3 | 2f01972..931d016 | 3 | |
| 5.4 | 931d016..8b6017d | 5 | |
| 5.6 | 8b6017d..7669f00 | 3 | built before 5.5 |
| 5.5 | 7669f00..c9369b6 | 2 | |
| 5.7 | c9369b6..b47b2f4 | 3 | |
| 5.8 | b47b2f4..0357b6d | 3 | cut at "story 5.8 done": epic 6 (735d93f..3e36882) landed between 5.8 and 5.9 |
| 5.9 | 3e36882..ce1b557 | 2 | inferred end (HEAD) |

Epic 5 feature work, 5.1–5.8: 452ff63..0357b6d, 24 commits, 31 files under `src`/`package.json`, +7616/−30. Largest net change: `src/adapters/vscode/cloudView.ts` +2562/−211, `src/test/integration/suites/96-cloud.ts` +2176/−58, `src/test/helpers/fakeCloud.ts` +543/−25, `src/adapters/cloud/dataPlane.ts` +355/−14 (`git_evidence.py`, no merges in either range).

### Evidence inventory

- Available: the epic file, the initiative Requirements, the 9 `tickets.toml` entries, 9 plans (all with baselines and verification; 5.2's has no review and no triage log), the 5.1 findings folder, the commits and diffs above, and the previous retrospective (`epic-bloblang-check-and-test-retrospective.md`, epic 4).
- No story files: no ticket was pulled for refinement.
- Session logs: not read. Process lessons come from the plans' triage logs and Plan Change Logs only.
- Analyses run: architecture delta, duplication, size and pattern views (import graph by script at 452ff63, 0357b6d and HEAD; madge not run); spec reconciliation (R1–R11, Done when 1–5); `bmad-review` lenses adversarial, edge-case-hunter and verification-gap over the 5.2–5.8 feature diff (8,159 lines), weighted to the boundaries between stories; the epic 4 retrospective's follow-through. Each finding below was re-checked against the code at HEAD (ce1b557) by the orchestrator before routing; one marked PLAUSIBLE could not be settled without the real API.

## Findings

Ids: C correctness, V verification gap, S spec, A aggregate, P process. Lens tags: adv (adversarial), edge (edge-case-hunter), vgap (verification-gap), agg (aggregate views), spec (reconciliation). Paths are HEAD paths after 5.9's split.

### Correctness (bmad-review, cross-story)

| # | Finding | Source | Lens | Disposition |
|---|---|---|---|---|
| C1 | Deploy has no in-flight guard: two Deploys of one file (title button twice, editor Deploy plus the row's Deploy again) run two full flows; with no mapping, two pipelines are created and the last mapping write wins, orphaning the other. Log access has a guard; deploy does not. | `cloudDeploy.ts:105-114`; guard pattern at `cloudLogs.ts:38,109` | adv 3, edge | defer → backlog bug (AI-1) |
| C2 | Secret-value masking is too wide and too narrow. The local value of *every* missing secret is added to the session-wide mask before the user chooses, never cleared, so a common value (`true`, `kafka`) masks ordinary text in names and messages for the session. Values under 4 characters are never masked, so a short secret echoed by an API error would show in the log and a message. | `cloudDeploy.ts:369-374,409-414`; `errors.ts:133`; `cloudView.ts:663-669` | adv 10–11, edge | defer → backlog bug (AI-1), first |
| C3 | The pipeline's file tag is `asRelativePath(uri, false)`: in a multi-root workspace the same relative path in two folders gives one tag (the tagged offer, the row's file, Compare and Deploy again can resolve to the other folder's file), and a file outside every folder sends its absolute local path, user name included, as a Cloud tag. | `cloudDeploy.ts:160`; `cloudView.ts:1198-1211`; `sidecar.ts:72-85` | adv 8, edge | defer → AI-1 |
| C4 | On the unchanged path, missing secrets are created and the log then says "nothing was sent". | `cloudDeploy.ts:203` before `:224-229` | edge | defer → AI-1 |
| C5 | A `${secrets.NAME}` already written in the config is passed through unchecked: no missing-secret question, so the pipeline goes to Error on the cluster. | `cloudTranslate.ts:63-65` | adv 4, edge | defer → AI-1 |
| C6 | Compare with local file shows the raw local file beside the translated deployed config, so every `${VAR}` shows as a change although Deploy says nothing changed. 5.5 chose an editable local right side; the translation (5.6, built before it) was not considered there. | `cloudActions.ts:541-557` against `cloudDeploy.ts:90-102` | adv 6, edge | defer → AI-1 |
| C7 | `orders.yaml` and `orders.yml` in one folder share `orders.cloud.json`, so deploying one updates the other's pipeline. | `sidecar.ts:17-23` | edge | defer → AI-1 |
| C8 | The update target is read once, before the size pick, the check and the secrets questions; a Start, Stop or tag change made meanwhile is not seen (the Replace confirmation uses the old state; the PUT sends the old description and tags). Switching accounts mid-prompt is not checked either. | `cloudDeploy.ts:179,222-257` | adv 2, edge | defer → AI-1 |
| C9 | PLAUSIBLE: an update of a pipeline in Error has no `change`, so the PUT answer counts as final at once; if the cluster still reports the old Error in that answer, the old error is reported against the new config. Depends on the API's answer, not seen in the spike. | `cloudDeploy.ts:646`, `follow` `:672-681` | edge | defer → AI-1, check on the real cluster |
| C10 | Smaller boundary cases: a bad mapping's "Deploy as new" skips the tagged-pipeline offer (`cloudDeploy.ts:173-177`); palette Delete on a bad mapping falls to the org-wide pick with no message (`cloudActions.ts:139-160`); nested `${A:${B}}` leaves B untranslated (`cloudTranslate.ts:61-76`); `env(` is refused in comments too (`cloudTranslate.ts:78-91`); a failed create after secrets were created does not name them (`cloudDeploy.ts:711-727`); STOPPING and unknown states poll to the timeout (`dataPlane.ts:59,103`). | as listed | adv 5,9,12,13; edge | defer → AI-1 (each a line in the bug) |
| C11 | Missing secrets are created before the user confirms Replace and restart, and stay when the user declines. | `cloudDeploy.ts:203,243-247`; test DECLINED_RESTART `96-cloud.ts:1329` | adv 1 | accept: 5.7's decision that created secrets stay, with a message, and its test |
| C12 | Mapping files are written and removed with raw `fs`, not atomically. | `cloudDeploy.ts:598-611`; `cloudActions.ts:404-420` | adv 14 | accept as-is: a torn write is read as a bad mapping, which is reported |

### Verification gaps (bmad-review)

| # | Finding | Source | Disposition |
|---|---|---|---|
| V1 | Deploy again from a row (5.5) is tested only with a config that needs no translation, no secret and passes the check, so the row path could skip 5.6–5.8 unnoticed. | DEPLOY_AGAIN `96-cloud.ts:1839-1892` | defer → AI-1 |
| V2 | Delete from a row with no config open, finding the mapping through the tag in the workspace folders, never runs (the stable run opens no folder). | DELETE_MAPPED `96-cloud.ts:1595-1625`; `cloudActions.ts:302-317` | defer → AI-1 |
| V3 | No test makes the mapping write fail, or checks the mapping after a deploy that timed out. | `cloudDeploy.ts:598-611`; `96-cloud.ts:508-518` | defer → AI-1 |
| V4 | Masking of the 5.7 values is never exercised: no fake error echoes a value, so removing `maskValue` breaks no test (NO_LEAK asserts absence where nothing could appear). | NO_LEAK `96-cloud.ts:2114-2146`; `cloudDeploy.ts:369-374` | defer → AI-1, with C2 |
| V5 | The check's real lint and version wiring is replaced in every test's setup; a break in it would silently skip the local lint. | `96-cloud.ts:214-216,306-308`; `extension.ts:320-325` | defer → AI-1 |
| V6 | No test sets one name in two local sources, so which value "Keep the value from …" offers is untested. | `environmentView.ts:467-478`; 5.7 tests `96-cloud.ts:1167-1361` | defer → AI-1 |

Covered across stories (checked and clean): the check before the secrets (`96-cloud.ts:1959`), secrets then a declined restart (`:1329`), translation into the unchanged comparison and the diff (`:1100`, `:1110`), Start/Stop in the view's menus for every state (`:1699`), the mapping driving the palette (`:1627`), delete removing the mapping through the active editor (`:1595`), a hand-written mapping kept byte for byte (`:940`).

### Spec reconciliation

| # | Finding | Source | Disposition |
|---|---|---|---|
| S1 | R3 says a pipeline is created "with a display name, description, resources and tags"; create sends no description (only an update carries the deployed one). No plan records the drop. | `dataPlane.ts:202-208` | spec to reconcile (AI-2) |
| S2 | Only a Dedicated cluster was ever exercised (the spike and every manual check). AD-23 marks BYOC "expected, unverified", yet Done when 1, the Outcome and the README say BYOC or Dedicated. | `epic-deploy-to-redpanda-cloud.md:15,19,39`; AD-23 | spec to reconcile and a BYOC check (AI-2, AI-3) |
| S3 | R6 (size from a setting) superseded: the size is picked on every deploy and the setting removed, recorded in a plan outside the epic folder. | `plan-cloud-size-pick-on-every-deploy.md`, 7af904d | accepted deviation; epic text not amended (AI-2) |
| S4 | R7 two-thirds built: resource files and local-only warnings moved to backlog stories 42 and 43; ticket 6's verify ("a resource file") was never met. | 5.6 Decisions; `deferred-work.md` | accepted deviation (user, 2026-11-09) |
| S5 | R8 "one confirmation that names them" became one question per secret. | 5.7 Approach and Decisions | accepted deviation |
| S6 | Done when 3 names argv; no test asserts it. It holds by construction: no cloud code spawns a process and lint gets only the file path. | `extension.ts:243`; no `child_process` in `cloud*.ts`, `adapters/cloud/` | accept, record in the epic (AI-2) |
| S7 | The initiative's out-of-scope list still names "BYOC deploy" and the spec's Non-goals exclude Cloud deployment; the epic's `covers` is empty. | `initiative-rpcn-vscode-designer.md:31`; epic Notes :65 | spec to reconcile with `bmad-spec` (AI-2) |
| S8 | AD-23 says a cluster whose pipeline list fails shows "no pipeline API"; the view shows an error row in that cluster. | VIEW_REFRESH `96-cloud.ts:544` | spec to reconcile (AD-23 text, AI-2) |

Added and not specified (accepted, each in its plan's Decisions): bad-name and `env(` refusals (5.6); Deploy anyway, local lint findings, the Bloblang call check, the version note (5.8); the tagged-pipeline offer and re-creating a gone pipeline (5.3); Copy pipeline ID, Deploy again, click to open (5.5); delete removes the mapping (5.4); one retry after a 401.

### Aggregate views

| # | Finding | Source | Disposition |
|---|---|---|---|
| A1 | `cloudView.ts` is still 1,318 lines after 5.9 (the account, caches, tree, content provider, ~15 delegations) and its `CloudContext` has ~45 members. | `cloudView.ts:362-417,458-1300` | accept: 5.9's triage rejected narrowing the context for no behaviour gain |
| A2 | Two poll loops with one skeleton (deadline, failure cap, 404) and the "still … after N s" text three times. | `cloudDeploy.ts:665-711,729`; `cloudActions.ts:278,347-370,394` | defer → code-health story (AI-5) |
| A3 | Offset-to-line helper three times: `cloudCheck.ts:185` is a copy of `bloblangNames.ts:38`; `cloudTranslate.ts:44` adds a third. `LITERAL_ARG` near-copies `ENV_CALL`. | 7006d33, 10f03fb; `envUsage.ts:17` | defer → AI-5 |
| A4 | Mapping-to-target resolution (cluster by id, data plane address, gone) solved twice with near-identical text. | `cloudDeploy.ts:558-590`; `cloudActions.ts:154-170` | defer → AI-5 |
| A5 | 5.9 made a type-only cycle (the siblings `import type` from `cloudView.ts`); no runtime cycle; documented in its header. | `cloudView.ts:97-101`; `cloudShared.ts:8` | accept |
| A6 | Presentation helpers (`pipelineStateText`, `sizeChoices`) live in the HTTP adapter. | `dataPlane.ts:137,343` | defer → AI-5 |
| A7 | Cloud unit tests are named by feature (`lifecycle`, `update`, `secrets`), not by module, and their suites by "Cloud …" rather than the path; cloud secret keys use dots where older keys use colons. | `src/test/adapters/cloud/`; `cloudLogs.ts:20` vs `secretEnv.ts:28` | accept as-is (renaming keys would lose stored credentials) |

Checked and clean: `src/core` stays pure; `src/adapters/cloud` imports no vscode; no new layering violation; HTTP, the 401 retry and error normalising each exist once; quick picks all go through the `CloudUi` seam; credentials and log access are only in secret storage, with no setting added.

### Process

| # | Finding | Source | Disposition |
|---|---|---|---|
| P1 | 5.5 was marked done with no manual check result ("push and mark 5 done" after the dev host opened). | 5.5 plan :104 | lesson → AI-4 |
| P2 | 5.2 (the tracer, the epic's largest single change: `cloudView.ts` +944) ran with no review. | 5.2 plan frontmatter `review: ''` | lesson → AI-4 |
| P3 | No plan has a Plan Change Log entry; decisions that changed requirements (R6, R7, R8) were recorded in the frozen Intent or outside the epic folder, so the epic file never shows them. | the 9 plans; `plan-cloud-size-pick-on-every-deploy.md` | lesson → AI-2, AI-4 |
| P4 | Epic 4's three process rules were not applied (below). | Previous-retro follow-through | AI-6 |

## Behavior verification

Not re-exercised end to end in this run: a real deploy needs the user's service account, which stays out of this session. The evidence is recorded, not observed here:
- Manual checks on the 1.143.1 dev host against the user's real Dedicated cluster, recorded passed for 5.2 (48aff4e), 5.3 (c98bbfa), 5.4 (4ba83e5), the size pick (8b6017d), 5.6 (b14724c), 5.7 (937bc79) and 5.8 (41b0381). None for 5.5 (P1); 5.9's was optional and skipped.
- At ce1b557 (5.9's verification): stable 1358 passing (1 pending, the 80-test `96-cloud.ts` among them, against the fake Control and Data Plane), multi-root 10, corpus 156, webview 378. CI runs the same stable suite (`.github/workflows/ci.yml`).
- No BYOC cluster was ever exercised (S2).

## Previous-retro follow-through

From `epic-bloblang-check-and-test-retrospective.md` (epic 4) :317-334, and its own open carry-overs from epic 3 (:302-315):

- Epic 4 AI-1, "Correct and extend backlog bug 19, raise it to P1, and build it next" (bmad-ticket, bmad-build): **landed**. 0f04195, ada9853, a3afe50; 8/8 pinned local runs; CI 7/8, its remaining failure split to bug 21 by the user, so the "8 green in CI" criterion was waived.
- Epic 4 AI-2, "a runner-like gate for focus and layout tests" (bmad-build plans): **not landed in epic 5**. 5.5 added focus assertions (`activeTextEditor`, `activeTabLabel()` in `96-cloud.ts`) verified by one stable run; no epic 5 plan mentions `taskset` or N runs.
- Epic 4 AI-3, "watch CI on every push, including `chore(tickets)` commits" (orchestrator): **partly landed**. Failed runs were recorded (`deferred-work.md:128,144`, now bug 41), but no epic 5 plan records a CI run.
- Epic 4 AI-4, "a test-determinism question in every per-ticket review": **no evidence found** in any epic 5 triage log.
- Epic 3 carry-overs still open: AI-2 (F9 backlog stories), AI-3 (reconcile spec, architecture and UX to the E3 build: `architecture-rpcn-vscode-designer.md:49` and `EXPERIENCE.md:53,129,140` still marked `[ASSUMPTION]`), AI-5 (E2 A1 and A4 as backlog stories), AI-6 (code-health story; `bloblangPanel/panels.ts` still 1,817 lines with no unit test): **no evidence found** for any.

## Action items

Proposed, not applied: each needs the user's yes.

| # | Action | Covers | Owner |
|---|---|---|---|
| AI-1 | Backlog bug "Deploy flow edge cases (epic 5 retrospective)", P2, with C2 (masking) first and its V4 test, then C1, C3, C4–C10, and the tests V1–V3, V5, V6; C9 checked on the real cluster first. | C1–C10, V1–V6 | bmad-ticket, then bmad-build |
| AI-2 | Spec reconciliation (remediation proposal, applied only on approval): amend the epic's R3 (description), R6, R7 (stories 42, 43), R8, Done when 1 (BYOC unverified) and 3 (argv by construction); AD-23's BYOC and "no pipeline API" lines; the initiative's out-of-scope list and the spec's Non-goals, with `bmad-spec`, giving the epic its `covers`. | S1–S3, S5–S8, P3 | the user approves; then bmad-spec / the orchestrator |
| AI-3 | A BYOC deploy check (Connect, Deploy, Start/Stop, Delete) when a BYOC cluster is available; until then the README says Dedicated is the verified type. | S2 | the user (hitl) |
| AI-4 | Process: every story's plan ends with a review (`review` never empty) and a manual check result or an explicit "skipped by the user"; a decision that changes a requirement is a Plan Change Log line naming the R-id. | P1–P3 | bmad-build orchestrator |
| AI-5 | Backlog story "Cloud code health": one poll helper, one offset-to-line helper, one mapping-to-target resolution, presentation helpers out of `dataPlane.ts`. Merge with the open epic 3/4 code-health item (AI-6 / C-7) or keep separate, the user's call. | A2–A4, A6 | bmad-ticket |
| AI-6 | Decide epic 4's AI-2–AI-4 and epic 3's four open items: re-commit each with an owner, or drop it with a Decision line so later retros stop carrying it. | P4 | the user |

## Acceptance verdict

**Machine verdict: accepted-with-open-items** (criteria declared, `epic-deploy-to-redpanda-cloud.md:37-43`; all 9 tickets done, `pending_tickets` empty).

- DW1 met for Dedicated, the only type available; BYOC unverified (S2, AI-3).
- DW2 met: UPDATE_RUNNING, UPDATE_STOPPED; 5.3's manual check.
- DW3 met: ACCEPTANCE 5.6 and 5.7, NO_LEAK; argv by construction (S6). The masking gaps (C2, V4) are open items against its spirit, not a shown leak.
- DW4 met: the row, the palette and delete tests; 5.4's manual check.
- DW5 met: the fake-cloud suite runs in CI's stable job; real deploys passed on the user's Dedicated cluster.

No blocking finding: C1–C10 are edge cases outside the paths the criteria name. The open items are AI-1, AI-2 and AI-3.

Human decision (user, 2026-11-09): **accepted-with-open-items**, the machine verdict accepted as proposed. AI-1 taken up (user, 2026-11-09) and split: backlog bug 44 (the masking, C2 and V4, built first) and bug 45 (C1, C3–C10, V1–V3, V5, V6); the other action items are not yet decided.

Human decisions (user, 2026-11-11, "use your recommendations"):
- AI-1: done. Bug 44 (masking) and bug 45 group A (one deploy per file, the messages, the target re-read, the states) are built and done; bug 45's groups B, C and D are backlog bug 47 (names), bug 48 (translation and Compare) and story 49 (the missing tests).
- AI-2: approved and applied: the epic's R3 (the description dropped), R6, R7, R8 and Done when 1 and 3, AD-23's BYOC and "no pipeline API" lines, the initiative's out-of-scope list and the spec's Non-goals amended to the build.
- AI-3: the README says Dedicated is the verified cluster type. The BYOC check (Connect, Deploy, Start/Stop, Delete) stays open for when a BYOC cluster is available (the user, hitl).
- R3: the pipeline description is dropped from R3; Deploy does not ask for it.
- AI-4: adopted. Every build plan ends with a review and a manual check result or an explicit "not run" or "skipped by the user"; a decision that changes a requirement is a Plan Change Log line naming it. Applied since bug 41.
- AI-5: backlog story 50, "Code health for the Cloud adapter and the panels", merged with epic 3's AI-6 code-health item.
- AI-6: epic 4 AI-2 (a runner-like gate for focus and layout tests) dropped: superseded by bug 41's waits and CI passing on the first attempt. Epic 4 AI-3 (watch CI on every push) adopted: done on every push since bug 41. Epic 4 AI-4 (a determinism question in every review) dropped: a flake gets its own ticket when it appears, as bug 41 did. Epic 3 AI-2 (F9 minor boundary stories) and AI-5 (epic 2's A1 and A4) dropped: not met again in three epics; a ticket is made if one recurs. Epic 3 AI-3 (reconcile the documents) applied with AI-2. Epic 3 AI-6 (code health) merged into story 50. Later retrospectives no longer carry these.
- C9: settled by design. Bug 45 group A follows an update from Error through the grace period and says when the error may be from before the deploy, so it is right whatever the Data Plane answers.
- Epic 5 closed as done.

## Open questions

- Is BYOC still in scope as a claim? If no BYOC cluster will be available, should Done when 1 and the README say Dedicated (AI-3)?
- Should the pipeline description (R3) be asked for, defaulted (for example to the file path), or dropped from R3?
- Does the Data Plane's PUT answer for a pipeline in Error report the old state (C9)? Only the real cluster can say.
- Should the Cloud code-health story merge with the long-open epic 3/4 code-health item (AI-5)?
