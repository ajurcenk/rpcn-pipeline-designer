---
epic: epic-pipeline-logs
date: 2026-11-11
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective: Pipeline logs (epic 6)

## Epic summary

Epic `epic-pipeline-logs`, 9 tickets in build order, all `done`; `pending_tickets` empty; none at `built`. The user raised no going-in concerns ("go", 2026-11-11).

| Ticket | Title | Range (baseline → next baseline) | Commits |
|---|---|---|---|
| 6.1 | Probe reading the logs topic on a real cluster | 735d93f..791a901 | 1 |
| 6.2 | Tracer: set up log access and show a pipeline's live log | 791a901..b1e1505 | 3 |
| 6.3 | Read back the log's history | b1e1505..eb81bc6 | 3 |
| 6.4 | Filter and search the log | eb81bc6..291d1a3 | 3 |
| 6.5 | Open the log from the command, the row menu and an Error | 291d1a3..2f0ae49 | 3 |
| 6.6 | The log panel's empty and error states | 2f0ae49..10962d4 | 3 |
| 6.7 | Records-per-hour strip | 10962d4..2969826 | 3 |
| 6.8 | Export the shown records | 2969826..da09628 | 4 |
| 6.9 | Refactor sweep | da09628..3e36882 (cut at "chore(tickets): story 6.9 done"; later commits belong to epic 5's 5.9 and the backlog) | 3 |

Evidence inventory: the epic file, `tickets.toml`, nine plans, the 6.1 spike findings, per-range `git_evidence.py` output, the epic diff 791a901..3e36882 (31 files, +9,613 / −48 in `src`, `webview`, `package.json`) and its commit messages. Session logs were not read; the process findings come from the plans. Paths below are at HEAD (after epic 5's 5.9 split, `cloudLogs.ts` holds the log access).

## Findings

Sources: the aggregate and process analysis (A, S, P, V), and `bmad-review` with the adversarial, edge-case and verification-gap lenses over the epic diff (C, G). The orchestrator checked C1, C2, C5 and C16 against the code. Overlap between lenses is noted, not merged away.

### Aggregate views

| # | Finding | Source | Disposition |
|---|---|---|---|
| A1 | Architecture delta clean: `src/adapters/logs` has no `vscode` import; the panel reaches the Cloud only through `LogSource`; the HTML/CSP helper is reused. | `logsPanel.ts:83,152,470`; `cloudLogs.ts:11` | accept |
| A2 | AD-24 lacks rules the build fixed: the 5,000-record cap, filtering on the host, the Node 22.22 floor and NEEDS_NEWER, the two retry layers. | architecture :240-253; `platformaticReader.ts:270-286`; `logsProtocol.ts:238` | fix now (AI-3) |
| A3 | `logsPanel.ts` is a god class: 1,619 lines, one class, about 56 methods and 26 fields; it grew in every story 6.2–6.8. 6.9 was scoped to the palette merge only. The adversarial lens ties C1–C4 to its hand-reset flags (`reset` vs `clearRead`). | `r6.2–r6.8.json`; sweep plan Intent | defer to story 50 (AI-4) |
| A4 | `cloudView.ts` grew from 2,351 to 2,911 lines in the epic; resolved by 5.9's split (c59e67c). | git | accept |
| A5 | Duplication: a "N record(s)" helper six times, `pad` three times, four local-time formatters. | `export.ts:22,34`; `LogsView.tsx:65,68,74`; `logsProtocol.ts:252,370,388,676,681`; `history.ts:77` | defer to story 50 (AI-4) |
| A6 | The duplicated palette target paths were merged in 6.9. | 7c51f61 | accept |
| A7 | Pattern divergence: 6.6's webview→host messages are commands (`stopReading`, `retryNow`, …), against the "past-tense intents" convention 6.3–6.5 and 6.7–6.8 follow. | `logsProtocol.ts:492-514`; architecture :259 | defer to story 50 (AI-4) |
| A8 | No user command removes stored log access; `removeLogAccess` is a test seam. Disconnect leaves the SASL records in secret storage and does not stop the panel (adversarial #5). | `cloudLogs.ts:66-67`; `cloudView.ts:878-903`; 6.2 notes | fix now (AI-2) |

### Spec reconciliation

| # | Finding | Source | Disposition |
|---|---|---|---|
| S1 | Done when 2 / R3 reinterpreted: the Error notification opens the last 15 minutes with ERROR records highlighted, not "at the time of the error"; only the row menu's Show logs around the error does that. Never logged as a requirement change. | `cloudLogs.ts:373`; 6.5 Boundaries; `logsPanel.ts:1231` | reconcile (AI-3) |
| S2 | R5 says "records-per-hour strip"; the build is 30–60 bars sized 1 minute to 1 day (6.7 Decision). The ticket was fixed (275a422), the epic's R5 was not. | `epic-pipeline-logs.md:29` | reconcile (AI-3) |
| S3 | AD-24's open points never closed: several partitions "unproven", BYOC, a narrower grant, high volume. | architecture :247; `spike-6-1-findings/findings.md:7` | record in AD-24 (AI-3) |
| S4 | The UX docs have no Pipeline Logs surface; the design boards exist only in the external artifact. | grep `ux-rpcn-vscode-designer/` | reconcile (AI-3) |
| S5 | Built but not in the spec, each recorded in its plan: NEEDS_NEWER, the 24 h search back for the error, Load older dropping the newest and pausing Live, refusing slow regular expressions, the backoff schedule. | plans 6.2–6.6 | accept |

Met as specified: R1, R2, R4, R6, R7 (`97-logs.ts:382,421,464,831-1045,1396-1603,1944-2096`).

### Diff review: reading and state (C)

| # | Finding | Lenses | Source | Disposition |
|---|---|---|---|---|
| C1 | A retry after "Connection lost" resumes every partition from the newest timestamp seen on any partition, so records on a partition that was behind are skipped silently. Contradicts 6.6's "resumes where it stopped". **Checked.** | adv #1, edge, edge claim | `logsPanel.ts:1024,1046-1049` | fix now (AI-1) |
| C2 | A filter change, or new log access, on the live range re-reads from the time the panel opened minus 15 minutes, through the tail, with no Stop reading, while the status says "the last 15 minutes". **Checked.** | adv #2 | `logsPanel.ts:649-668,1449`; `tail` :980-993 | fix now (AI-1) |
| C3 | A filter change or Live on during the around-the-error search drops the search silently; the panel reads the last 24 hours, unmarked. | vgap #1, edge | `logsPanel.ts:636-670,784,808-836` | fix now (AI-1) |
| C4 | The around-the-error search (up to 24 one-hour windows) is never in the Reading state and cannot be stopped. | adv #4 | `logsPanel.ts:1231-1299,1400-1420` | fix now (AI-1) |
| C5 | Load older replaces `dropped` with the last batch's left-out count, so the footer, "N older left out" and the export message undercount; with the tail at the cap during Load older, a silent gap opens. **Checked.** | adv #3, edge, edge claim | `logsPanel.ts:1103-1105,1540-1611` (`this.dropped = merged.leftOut` :1595) | fix now (AI-1) |
| C6 | The row's time is the value's `time` field, but ranges, strip slots and anchors use the Kafka timestamp; Show records around and the around-the-error window are built from the shown time, so a skewed record can fall outside its own window. | adv #8, edge ×2 | `records.ts:105`; `logsPanel.ts:676-694,1287,1311-1316,1519,1533` | fix now (AI-1) |
| C7 | The strip clamps out-of-span records into the edge bars; a bounded range followed by Live piles every live record into the last bar, and clicking it misses them. | adv #9, edge | `filter.ts:103-112`; `history.ts:248-255` | fix now (AI-1) |
| C8 | The read position advances only past records at or after it; a batch with none (compacted or control batch) leaves it unchanged, so the tail spins and a range stalls. | adv #10, edge | `platformaticReader.ts:244-262` | fix now (AI-1) |
| C9 | A failed metadata re-read after a failed fetch ends the read instead of being retried. | edge | `platformaticReader.ts:286-288` | fix now (AI-1) |
| C10 | Stop reading a bounded range, then Live on: the rows read are dropped and the panel goes back to the default 15 minutes. | edge | `logsPanel.ts:829-835,1400-1419` | fix now (AI-1) |
| C11 | Show logs on another pipeline while Set up log access runs leaves the new pipeline's Set up and Use another user disabled or ignored; a second Set up request is ignored with only a log line. | edge, adv #15 | `logsPanel.ts:554-583,1427-1442`; `cloudLogs.ts:108-111` | fix now (AI-1) |
| C12 | Slow-pattern refusal misses ungrouped adjacent quantifiers (`.*.*.*x`); the webview's highlight runs the pattern on full row text with no cap. Contradicts 6.4's "patterns that could take too long are refused". | edge ×2, edge claim | `logsProtocol.ts:101-142`; `LogsView.tsx:111-133` | fix now (AI-1) |
| C13 | The partition id is taken from its array position in the metadata answer; a leader of −1 during an election is fetched as a node. | adv #11 | `platformaticReader.ts:197` | defer (AI-1, check against the client's metadata shape first) |
| C14 | LogAppendTime batches would get per-record times from meaningless deltas. | adv #12 | `platformaticReader.ts:255` | defer (only if the topic's timestamp type changes) |
| C15 | Export adds no time to a record without a `time` field and says nothing in the file or message about the filter applied. | adv #13 | `logsPanel.ts:711-756`; `export.ts:10-15` | defer (AI-1, low) |

### Diff review: credentials and masking (C)

| # | Finding | Lenses | Source | Disposition |
|---|---|---|---|---|
| C16 | A record whose value is a JSON array or string is masked as raw text, where a secret's `"` or `\` is escaped, so the mask misses it. **Checked:** `!isObject(value)` → `shown(record.value)`. | edge, edge claim | `records.ts:82-84` | fix now (AI-2) |
| C17 | Passwords: a password under 4 characters is never masked; every typed password, including refused ones, is masked for the session by substring, so a short common one garbles rows everywhere. | adv #7, edge, edge claim | `cloudLogs.ts:166`; `errors.ts:131-136` | fix now (AI-2) |
| C18 | Once another window removes or replaces the stored access, the open panel keeps signing in with the old credential. | adv #6 | `cloudLogs.ts:294`; `cloudView.ts:561` | fix now (AI-2) |
| C19 | Load older shows the reader's error text in the panel, against 6.6's "the cluster's error text goes to the output channel only". | edge claim | `logsPanel.ts:1203-1207` | fix now (AI-2, low) |
| C20 | A `license_org` value is masked only in rows shaped after it was first seen; earlier rows keep it. | adv #14 | `logsPanel.ts:1501-1503`; `records.ts:69-73` | fix now (AI-2, low) |

The verification-gap lens found the stored-password handling sound as far as it read: NO_LEAK checks every secret storage key, files, output, prompts, view items, settings and the panel; WRITE_FAIL checks masking on export (`97-logs.ts:2061-2164`).

### Verification gaps (V, G)

| # | Gap | Source | Disposition |
|---|---|---|---|
| G1 | No test for C3 (filter or Live during the around-the-error search). | `97-logs.ts:1269-1395` | with AI-1 |
| G2 | Set up log access from the tab: the return to the error search and keeping Live off (and the filter) are untested. | `logsPanel.ts:1444-1460`; `97-logs.ts:1396-1500` | with AI-1 |
| G3 | 6.9's shared palette path: the "cluster gone" branch is untested for both callers. | `cloudActions.ts:163-168`; 7c51f61 | with AI-1 |
| G4 | The export message's newer-dropped count is never non-zero in the panel's tests. | `logsPanel.ts:730,742`; `97-logs.ts:1944-2111` | with AI-1 |
| V1 | Not allowed (Done when 4) is tested on the fake only; the real authorization error was never seen. | `97-logs.ts:1444`; `findings.md:7` | manual check (AI-5) |
| V2 | Done when 2 on the real cluster: "the Error notification as available". | 6.5 plan :116 | manual check (AI-5) |
| V3 | The integration fake always has one partition; several partitions only in the reader's unit tests. C1 needs several. | `fakeLogs.ts:94`; `platformaticReader.test.ts:13-31` | with AI-1 (C1's test) |
| V4 | A 7-day read on a busy cluster is untested beyond the fake's 20,000 records (the real topic held 54 in 24 h). | `findings.md:7`; `97-logs.ts:900` | defer |
| V5 | NEEDS_NEWER runs only in the non-blocking floor job. | `ci.yml:55-58`; `97-logs.ts:2232` | accept |
| V6 | BYOC never exercised for logs. | `findings.md:7` | accept (with epic 5's BYOC item) |

### Process (P)

| # | Finding | Source | Disposition |
|---|---|---|---|
| P1 | 6.2–6.9 each had a review; every one was a single pinned quick lens, the high-risk tracer included. The quick reviews still caught a high-severity leak (6.4 triage #1). This retrospective's three lenses found 20 code issues the quick reviews did not. | plans `review:` fields | lesson (AI-6) |
| P2 | Every plan has a verification result; four put the automated counts only inside the manual-check line. | 6.2, 6.4–6.6 plans | accept |
| P3 | 6.1–6.8 have manual-check results; 6.9 says "None needed… optionally" with no result (before epic 5's AI-4). | sweep plan :100-101 | accept |
| P4 | Requirement changes went into "superseding" notes, not Plan Change Logs (only 6.8 and 6.9 have the heading, both empty); the epic file was never amended. | 6.3 :113, 6.4 :230, 6.5 :92, 6.7 :110 | lesson already adopted (epic 5 AI-4); apply S1, S2 |
| P5 | All deferred work from the epic landed: the palette merge in 6.9, the flakes in bug 41. | `deferred-work.md:130-144`; 7c51f61; fc2f467 | accept |

## Behavior verification

Not exercised end to end by this retrospective: the log panel needs the user's cluster and a log-access user. The evidence is the 6.2–6.8 manual checks on the user's cluster recorded in the plans (6.9 had none), and the integration suite against the fake reader in CI (stable green on 43046046364, 2026-11-11). C1, C2, C5 and C16 were confirmed by reading the code, not by running it.

## Previous-retro follow-through

- **Epic 5's retrospective does not apply.** Epic 6 was built 791a901 (2026-11-05) to 3e36882 (2026-11-09 09:56); epic 5's retrospective was first committed in c8fdebd (2026-11-09 13:10) and decided in c783a4a (2026-11-11), after epic 6 was built.
- **Epic 4's items carried by epic 5's retrospective:** epic 6's plans show no repeated-run gate (AI-2), one CI run recorded (AI-3, partly), no determinism question in reviews (AI-4). All three were decided on 2026-11-11 in epic 5's retrospective (AI-2 and AI-4 dropped, AI-3 adopted). Nothing carries over.

## Action items

Proposed, not applied: each needs the user's yes.

| # | Action | Covers | Owner |
|---|---|---|---|
| AI-1 | Backlog bug "Pipeline logs reading and state edge cases (epic 6 retrospective)", P2: C1–C12, C15, with C13 checked against the client's metadata shape first; its tests include G1–G4 and a several-partition fake for C1 (V3). Likely more than one build: the plan may split it (reading C1, C8, C9, C13; state C2–C5, C10, C11; time and strip C6, C7; search C12). | C1–C13, C15, G1–G4, V3 | bmad-ticket, then bmad-build |
| AI-2 | Backlog bug "Pipeline logs credentials and masking (epic 6 retrospective)", P2: a **Forget log access** command per cluster, Disconnect stopping the panel and clearing the in-memory accesses (A8); C16–C20. | A8, C16–C20 | bmad-ticket, then bmad-build |
| AI-3 | Spec reconciliation: amend Done when 2 / R3 (the notification opens the last 15 minutes, highlighted; or pass `aroundError` from it, the user's call), R5 (the strip as built), AD-24 (the cap, host filtering, the Node floor, the retry layers, its open points), and add the Pipeline Logs surface to EXPERIENCE.md. | S1–S4, A2 | the user approves; then the orchestrator |
| AI-4 | Add to backlog story 50 (code health): split `LogsPanel`'s read state into one value per range with an explicit state (tail / range / search / older), the shared plural, `pad` and time helpers, and rename 6.6's commands to past-tense intents. | A3, A5, A7 | bmad-ticket |
| AI-5 | Manual checks on the real cluster: Not allowed with a user that lacks Read on the logs topic; Show logs from a real Error notification. | V1, V2 | the user (hitl) |
| AI-6 | Process: a high-risk story's review runs the adversarial and edge-case lenses, not the quick lens alone. | P1 | bmad-build orchestrator |

## Acceptance verdict

**Machine verdict: accepted-with-open-items** (criteria declared, the epic file's Done when 1–5; all 9 tickets done, `pending_tickets` empty).

| Done when | Verdict | Evidence |
|---|---|---|
| 1 | met-with-gap | SHOW, ONLY_THIS, SWITCH `97-logs.ts:421,448`; 6.2 manual check; one-partition topic only (V3), and C1 skips records after a retry on several |
| 2 | met-with-gap | Show logs on deploy, update and start Error notifications (`cloudDeploy.ts`, `cloudActions.ts`; tests `97-logs.ts:1121,1227`, `96-cloud.ts:1621`); opens the last 15 minutes, not "at the error's time" (S1); real check unclear (V2) |
| 3 | met | LEVELS, SEARCH, FIELD_FILTER, 7 days (`97-logs.ts:831-900,1657`); 6.3, 6.4, 6.7 manual checks |
| 4 | met-with-gap | SIGN_IN, NOT_ALLOWED, CONNECTION_LOST, NO_LEAK, export MASKED (`97-logs.ts:1414,1444,1578,1944,2124`); Not allowed on the fake only (V1); C16 and C17 are masking gaps |
| 5 | met | the fake reader in the stable CI job; 6.2–6.8 manual checks on the user's cluster |

The open items are AI-1 to AI-6. None blocks use: every Done when line is met at least with a gap, and the gaps are edge cases and masking corners, not a broken flow.

Human decision (user, 2026-11-11, "use your recommendations"): **accepted-with-open-items**, the machine verdict accepted as proposed.
- AI-1: approved: backlog bug 51, "Pipeline logs reading and state edge cases (epic 6 retrospective)". Its split into groups is an open question for its plan.
- AI-2: approved: backlog bug 52, "Pipeline logs credentials and masking (epic 6 retrospective)".
- AI-3: approved and applied. Done when 2 and R3 amended to the build: the Error notification opens the last 15 minutes with ERROR records highlighted, and the row menu's Show logs around the error opens the log around the newest ERROR record. R5 amended to the strip as built. AD-24 gains the rules the build fixed and keeps its open points. EXPERIENCE.md gains the Pipeline Logs surface.
- AI-4: approved: added to backlog story 50 (code health).
- AI-5: open: the two manual checks stay with the user (hitl), for when a user without Read and a real Error are at hand.
- AI-6: adopted: a high-risk story's review runs the adversarial and edge-case lenses.
- Epic 6 closed as done.

## Open questions

- ~~Should the Error notification open the log around the error, or should Done when 2 be amended to the last 15 minutes highlighted, as built?~~ Settled (user, 2026-11-11): Done when 2 amended to the build (AI-3).
- Is the logs topic on the user's clusters ever more than one partition? C1 only skips records with several; the spike saw one cluster.
- C13: does the Kafka client's metadata answer keep partitions in index order? It decides whether C13 is a bug.
- Should AI-1 be one bug or split into reading, state, and time and strip groups before it is built?
