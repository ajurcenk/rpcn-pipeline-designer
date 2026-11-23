---
epic: epic-pipeline-metrics
date: 2026-11-21
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective: Pipeline metrics (epic 7)

## Epic summary

Epic 7, `epic-pipeline-metrics`: 10 tickets, all `done` (`tickets.py status`). None is still at `built`, and `pending_tickets` is empty. The user gave no going-in focus: the question went unanswered.

| Ref | Ticket | Status | Range (baseline → next baseline) | Commits |
|-----|--------|--------|----------------------------------|---------|
| 7.1 | spike: Probe the Cloud Prometheus endpoint on a real cluster | done | `ea09368..5802355` | 2 |
| 7.2 | Metrics of a local run in the Pipeline Metrics tab | done | `5802355..cc0f23c` | 3 |
| 7.3 | Figures on the graph's nodes | done | `cc0f23c..ab11e3f` | 3 |
| 7.4 | Metrics access for a cluster | done | `ab11e3f..19c8dfd` | 3 |
| 7.5 | Metrics of a Cloud pipeline in the tab and on the graph | done | `19c8dfd..529a89a` | 3 |
| 7.6 | The live window, trend lines and the full figures | done | `529a89a..780d06b` | 3 |
| 7.7 | Mark the bottleneck | done | `780d06b..d7eebfd` | 3 |
| 7.8 | The tab's empty and error states | done | `d7eebfd..36a1d13` | 3 |
| 7.9 | Entry points for metrics | done | `36a1d13..3398877` | 3 |
| 7.10 | Refactor sweep | done | `3398877..45f411a` (to HEAD, inferred) | 3 |

The whole epic's range is `ea09368..45f411a`, 29 non-merge commits and no merges. The `git_evidence.py` output for each range is in the session scratchpad and is not committed.

**Evidence inventory:**
- **Available:**
  - the epic file (Done when 1–5, R1–R9) and the initiative file
  - `tickets.toml`, with each ticket's risk
  - ten plans (frontmatter, Code Map, Decisions, Review Triage Log, Verification, Manual Check)
  - the commits and diffs of each range
  - the architecture document (AD-15, AD-17, AD-25)
  - `EXPERIENCE.md`
  - the previous retrospective (`epic-pipeline-logs/epic-pipeline-logs-retrospective.md`)
  - `deferred-work.md`
- **Session logs:** this conversation covers 7.4–7.10; the part before the context summary is known only from the summary. Session records for 7.1–7.3 were not read, so process lessons for those tickets come from their plans only.
- **Story files:** none; no ticket was refined.
- **Cycle check:** madge was not available offline. Cycles were checked by a script over the relative value imports.

## Findings

Sources: two sub-agents (the aggregate views; `bmad-review` with the adversarial, edge-case and verification-gap lenses over the epic's diff, weighting the boundaries between tickets). I re-checked every finding routed to *fix now* against the source, as the "re-check" line says. Findings the reviewers did not trace themselves are marked *unverified*.

### Cross-ticket defects (bmad-review)

| # | Finding | Source | Boundary | Disposition | Upstream lesson |
|---|---------|--------|----------|-------------|-----------------|
| C1 | When Show metrics does not start (not signed in, pipeline missing, no Prometheus URL, a pick escaped), `showMapped` still returns `true`, so `showFor` never reaches its documented last step ("the file itself, Not running with Run"). The user gets a message, and the tab stays unbound or shows a stale source. | `metricsPanel.ts:479-481`, `:504-517`; `cloudMetrics.ts:311-339` | 7.9 resolver ↔ 7.5 Show metrics ↔ 7.8 Not running | fix now (AI-1) | A command used as a step of a resolver must report whether it bound anything. The 7.9 plan's matrix covered the gone and not-signed-in cases as "the message Show metrics gives" and never said what the tab then shows. |
| C2 | Show metrics loads a cluster's pipelines but never the cluster list, which loads only when the Cloud view's account node is expanded (`cloudView.ts:1118-1121`, `:1197-1199`). So the command, the tab's opening and the tab's Show button, used before the Cloud view was expanded in this session, say "That pipeline is no longer in the Cloud view" about a pipeline that exists. | `cloudMetrics.ts:320-329`; `cloudView.ts:1030` | 7.9 / 7.8 entry points ↔ 7.5 | fix now (AI-1) | Re-checked: the clusters are loaded only on expand or Connect. The manual checks always had the Cloud view open, so they could not catch it. |
| C3 | `stillWanted` is checked only once, before the Cloud command. A bind the tab starts when it opens can therefore overwrite a Show or pick made meanwhile, so the last choice does not win. Also, `mappingTriedFor` blocks a retry after a transient failure (signed out, then connected). No test reaches `showCloud` through the resolver: the fake `executeCommand` only records the call. | `metricsPanel.ts:290`, `:512-516`; `metricsPanel.test.ts:85-88` | 7.9 bindOnOpen ↔ 7.5 binding ↔ 7.8 | fix now (AI-1) | A unit fake that swallows a command hides an ordering bug between tickets. |
| C4 | When the Cloud feed's access is set or replaced, it clears `refusedMessage` and `failures` but not `notServed` or `noSeriesReads`. After new credentials a pipeline stays "No figures yet" or not served until the user presses Read again, which contradicts the file's header (L30). | `metricsFeed.ts:293-304` | 7.5 access following ↔ 7.8 notServed | fix now (AI-2) | — |
| C5 | Forget metrics access, from the row or the palette, ignores a Set up that is still running (`SetUpGuard.has` is never consulted). The set-up then stores the access again, so the "removed" message is false. Only the tab's button checks this, and no test does. | `cloudShared.ts` `forgetAccess`; `metricsPanel.ts:407` | 7.10 guard ↔ 7.8 ↔ 7.4 | fix now (AI-3), low | — |
| C6 | The `window` handler decides whether the feed emitted by comparing `posted.length`, but `posted` is capped at 200 (`:670-672`). Past the cap, every window change posts twice and fires `onDidChange` twice. | `metricsPanel.ts:336-341` | 7.6 ↔ 7.2 test seam | fix now (AI-3), low | A test seam (a capped log) must not decide behaviour. |
| C7 | The status bar rate is the summary's output rate, which is the average over the tab's window (1, 5 or 15 min), not the current rate. It is `null` for a `broker` output. The tests compare `null` with `null`. | `metricsPanel.ts:307-312`; `core/metrics.ts:407-411` | 7.9 ↔ 7.6 ↔ 7.7 | accept, record: it is the window's rate, like the tab's | Name the window in the status bar's tooltip if it confuses anyone. |
| C8 | *Unverified.* The panel resolves the file through `.cloud.json`, but Show metrics resolves it again from the pipeline's tag (`metricsFileOf`). When the two disagree, the tab binds another feed. | `cloudMetrics.ts:336`; `metricsPanel.ts:516` | 7.8 / 7.9 ↔ 7.5 ↔ 7.3 | defer to bug 57 (same root: two mapping lookups) | — |
| C9 | *Unverified.* The graph does not know its feed is Cloud-bound. After the tab is closed or rebound, the file's feed can stay on the Cloud, read every 10 s while the graph is visible. | `graphPanel.ts:176-228`; `metricsPanel.ts:582-596` | 7.3 ↔ 7.5 | defer (AI-8): settle with a test that closes the tab after Show metrics and counts reads with the graph open | — |
| C10 | *Unverified.* With 3+ feeds on one cluster, each read downloads the whole cluster's body, and the 5 s floor makes the reads queue up behind "read every 10 s". | `metricsFeed.ts:596-640`; `cloudMetrics.ts:374-387` | 7.3 ↔ 7.4 ↔ 7.5 | defer (AI-8) | — |
| C11 | *Unverified.* When `new URL` fails, `cloudAddress` returns the raw Prometheus URL as the host, which is shown and logged unmasked. | `src/adapters/metrics/source.ts:180-186` | 7.4 ↔ 7.5 | defer (AI-8): settle with a unit test on a URL carrying userinfo | — |
| C12 | *Unverified.* Several smaller seams: masking depends on the tab's source (`metricsPanel.ts:297`, `:412-416`); Set up from the tab after a disconnect says "cluster gone" instead of offering Connect (`cloudMetrics.ts:227-229`); the tab keeps a renamed file's old URI (`graphPanel.ts:164-169`); `configFor` re-parses on every reading (`extension.ts:286-297`); a port rebind takes a Cloud-bound feed back to local (`metricsFeed.ts:486-492`); an untitled graph's button offers the pick (`metricsPanel.ts:474`). | as cited | various | defer (AI-8) | — |

### Aggregate views

| # | View | Finding | Source | Disposition |
|---|------|---------|--------|-------------|
| A1 | Architecture delta | AD-15 holds: `src/core` imports no adapters or `vscode`; the webview imports only `src/shared/metricsProtocol`; `metricsProtocol.ts` imports one type from `protocol.ts`; no value cycle. Type-only cycles exist (`cloudView` ↔ `cloudMetrics`, `cloudShared`, `cloudLogs`); they predate the epic's pattern. | greps at HEAD; scripted cycle check | checked and clean |
| A2 | Size growth | `metricsFeed.ts` is 843 lines: two classes, one of them with about 45 methods and 22 fields holding both read loops. `metricsPanel.ts` is 678 lines: one class doing the webview, resolver, pick, state actions and status-bar rate, touched by 8 of the 10 tickets. `cloudView.ts` is now 1515 lines (+105). `run.ts` is 744 (+216, about 97 lines of it metrics). | `wc -l`; `range-epic.json` | defer (AI-8): split `MetricsPanel`'s resolver and pick out, and the feed's Cloud loop, the next time either is touched |
| A3 | Duplication | Not merged by 7.10: the Set up test-and-store flow (`cloudMetrics.ts:236-290` vs `cloudLogs.ts:205-262`), `maskError` (`:170` vs `:117`), `parseMetricsAccess` vs `parseLogAccess` (`:405` vs `:508`), the two "active config → mapped pipeline → pick" resolvers (`cloudLogs.ts:419-435` vs `metricsPanel.ts`), the 9th copy of `isObject` (`metricsProtocol.ts:497`), `clockText`'s padding vs `logsText.ts:21`, and two styles of quick-pick seam. Left by decision: the feed's loops, the two `StatePanel`s, the mapping lookup (bug 57). | as cited | defer (AI-8) |
| A4 | Pattern divergence | Ticket-tag comments: 7.8 and 7.9 wrote "Ticket 8" / "Ticket 9" (board numbers; 73 and 60 lines), while 7.6 and 7.7 wrote "7.x". The tags already collide: `61-run-real.ts:28` "ticket 9" is an older ticket. No `as any`, `eslint-disable` or `@ts-ignore` was added. Two `as unknown as` on `fetch` (`source.ts:77`, `:189`). Silent catches: `metricsPanel.ts:453`, `:508`; `cloudMetrics.ts:413`; `source.ts:178`. | `git diff ea09368..45f411a`; greps | fix now (AI-5), convention |
| A5 | Spec ↔ build | Every R1–R9 and Done when 1–5 has an implementation and a test (detail in the Acceptance verdict). Recorded deviations accepted by the user's Decisions: AD-25's bottleneck moved from p50 to the share of time (7.7); the feed reads while the graph is visible even with the tab closed (7.3, R4 / R7); Trend is not sortable (7.6); a config's own `http` is always overridden (7.2), so R9's "moves them" case cannot happen; R8 has no terminal entry point, the status bar was chosen (7.9). | plans' Decisions | accept, record |
| A6 | Spec ↔ docs | Not reconciled: the architecture's Deferred list still names "metrics" as a later phase (arch L393); the spec's Non-goal "metrics" is not amended (epic Notes); `EXPERIENCE.md` has a Pipeline Logs section (L209) and no Pipeline Metrics one; the epic file is still `status: in-progress`. | as cited | fix now (AI-6), spec reconciliation |

### Verification and process

| # | Finding | Source | Disposition |
|---|---------|--------|-------------|
| V1 | The only real-binary metrics test is 7.2's shape (`61-run-real.ts:288`: rows, rates, two ports; the sleep's p50 only). The slowest mark, the window and the states are tested on fakes, plus the manual checks. "Listens on 127.0.0.1 only" is asserted from argv, not from the socket. | `61-run-real.ts:288`, `:322`, `:340` | defer (AI-7); the behaviour check below covers it once |
| V2 | Weak tests reached review: 7.6 rows 1–2 (a WINDOW check that could never fail, a circular footer check) and 7.8 row 3 (UNREACHABLE passed with no read) were caught and patched. 7.9 row 5 (the empty NO_EDITOR case asserts nothing) was rejected. | the plans' triage logs | accept: caught by the quick lens |
| V3 | Full-run flakes cost re-runs: in 7.9, a late secret-storage delete after a sign-out undid the next test's stored access (fixed in 99b's teardown with a 1 s settle, after two full stable runs failed). In 7.10, the Environment view's "ticket 39 VALUE_DEFAULT" failed again, though bug 41 has been `done` since `b270ac4`. | `story-entry-points-for-metrics-plan.md:107`; `story-refactor-sweep-plan.md:92` | fix now (AI-4) |
| P1 | Epic 6's AI-6 ("a high-risk story's review runs the adversarial and edge-case lenses") was not applied. The two high-risk tickets, 7.1 (`tickets.toml:15`) and 7.5 (`:61`), ran only `['quick']`, because bmad-build's review is pinned to quick and nothing changed that setting. This retro's three lenses found C1–C6 across the boundaries of tickets that each passed a quick review. | each plan's `lenses_ran`; epic 6 retro L135, L157 | fix now (AI-9), process |
| P2 | Plan size: 7.9's plan was about 1,800 tokens (the guideline is 1,600), kept whole by the user, and its implementer made one decision of its own (the palette `when` removed) that the review then had to chase (7.9 rows 2, 6). 7.10's plan said the merge would save 80–100 lines; it added a net 17. | 7.9 plan Decisions and triage; 7.10 triage row 5 | accept, lesson: a resolver story with five entry points is two stories |
| P3 | In 7.7, a scope decision was written into the plan before the user had answered; I caught it, asked, and recorded the answer. | this session (7.7) | accept, lesson already applied in 7.8–7.10 |

## Behavior verification

Exercised end to end with the real binary (`redpanda-connect` 4.100.0) and the built core model (`out/core/prometheus.js`, `out/core/metrics.js`). A script ran `.vscode-test/story-7-2/metrics_a.yaml` with the Run's arguments (`--set http.enabled=true --set http.address=127.0.0.1:41987`) and read `/metrics` four times, 2.5 s apart. Observed:

- **Rates:** in and out about 10.1/s for each processor and out 10.1/s for the input, matching the config's 100 ms interval (Done when 1).
- **Slowest mark:** `root.pipeline.processors.0` (`slow_one`, the 5 ms `sleep`) had p50 5.164 ms and a share of 99.7%, and was the slowest leaf. The `branch` (`processors.1`) is not a leaf, and its inner `mapping` has 0.1% (Done when 2, R6).
- **Address:** the server listened on `127.0.0.1:41987` only (`ss -ltn`), and a request to the machine's LAN address got no answer (R1).

Not exercised by me: the VS Code UI, the Cloud endpoint and the states. Those rest on the integration tests (stable: 1719 passing) and the user's manual checks in the dev host for each ticket (7.4, 7.5 and 7.8 on the user's own cluster).

## Previous-retro follow-through

From `epic-pipeline-logs/epic-pipeline-logs-retrospective.md`:

- **AI-1** (bug 51, masking groups): landed. Group A in `4f88554`; groups B and C became bugs 53 and 54, both done (`fcc5b43`, `a7b3103`).
- **AI-2** (bug 52, forget log access): landed in `65f4198`. Its pattern was reused for metrics in 7.4, then merged in 7.10.
- **AI-3** (EXPERIENCE.md Pipeline Logs, AD-24): landed in `9a4f70b`. The same gap repeats for metrics (A6).
- **AI-4** (story 50 and its groups): landed. `91148f6`; stories 55 (`2e4d05c`) and 56 (`a7b3103`).
- **AI-5** (manual checks on the real cluster: Not allowed, a real Error), owner the user: no evidence found; still open.
- **AI-6** (adversarial and edge-case lenses for high-risk stories), owner the bmad-build orchestrator: not followed (P1).

## Action items

Proposed, not applied: the human decides what runs. The code fixes would go through `bmad-ticket` (a bug) and `bmad-build`.

| # | Action | Kind | Owner | From |
|---|--------|------|-------|------|
| AI-1 | One bug, "Show Pipeline Metrics' Cloud step": (a) when Show metrics binds nothing, fall through to the file (Not running); (b) Show metrics loads the cluster list when the cluster isn't held yet; (c) the tab-open bind re-checks `stillWanted` after its awaits and doesn't block a retry after a transient failure. Each part gets a test through the real command, not the swallowing fake. | remediation | user → `bmad-ticket`, `bmad-build` | C1, C2, C3 |
| AI-2 | Bug: a Cloud feed's access change clears `notServed` and the no-series count (as the header says). | remediation | user → `bmad-ticket` | C4 |
| AI-3 | Small bug: Forget metrics/log access waits for, or refuses during, a running Set up of that cluster; the `window` handler stops reading the capped `posted` log. | remediation | user → `bmad-ticket` | C5, C6 |
| AI-4 | Reopen bug 41, or file a new one, for the VALUE_DEFAULT flake that recurred after it closed. Also add a note on the secret-storage settle (the 7.9 fix and the 7.4 wait) to the integration-test memory or AGENTS.md. | remediation, process | user | V3 |
| AI-5 | Convention: ticket-tag comments name the full ref (`7.9`, not `ticket 9`), recorded in AGENTS.md; the existing "Ticket 8/9" tags in the metrics files are rewritten in the next sweep. | process | user (`bmad-project-context`) | A4 |
| AI-6 | Spec reconciliation: remove "metrics" from the architecture's Deferred list and point AD-25 at the epic; add a Pipeline Metrics section to `EXPERIENCE.md` (the tab, the states, the entry points); note in the spec that the Non-goal was lifted by epic 7 (offer `bmad-spec`); close the epic with `bmad-ticket` after this retro. | spec reconciliation | user (`bmad-architecture`, `bmad-ux`, `bmad-spec`, `bmad-ticket`) | A6 |
| AI-7 | A real-binary integration test for the slowest mark, `sleep` in `61-run-real.ts`, as this retro's script did, plus a socket check of 127.0.0.1. | remediation | next metrics ticket | V1 |
| AI-8 | Backlog story for the next sweep: split `MetricsPanel` (resolver and pick) and the feed's Cloud loop; merge the Set up test-and-store flow, `maskError`, the access parsers and `isObject`; settle C9–C12 with tests (each names what would settle it). | deferred cleanup | user → `bmad-ticket` | A2, A3, C9–C12 |
| AI-9 | Make epic 6's AI-6 enforceable: customize `bmad-build` (via `bmad-customize`) so that a ticket with `risk = "high"` runs the adversarial and edge-case lenses, and only low and medium risk stay pinned to quick. | process | user (`bmad-customize`) | P1 |

## Acceptance verdict

**accepted-with-open-items** (criteria declared in the epic file). Human decision (the user, 2026-11-21): accepted as rendered. AI-1, AI-2 and AI-3 were filed on 2026-11-21 as bugs 58, 59 and 60 in `_bmad-output/backlog/`. AI-4 was filed on 2026-11-23 as bug 61, a new bug rather than bug 41 reopened. Its note on the secret-storage settle is not filed yet. AI-5 to AI-8 stay proposed. AI-9 was applied on 2026-11-21 in `_bmad/custom/bmad-build.toml`: review is set to thorough, and the four extra lenses run only when the ticket has `risk = "high"`.

- **Done when 1, met:** local rows with rates, latency and errors (`61-run-real.ts:288`), two runs on two ports, the server on 127.0.0.1 (argv at `:322`; the socket in the behaviour check), and 7.2's manual check.
- **Done when 2, met:** the `sleep` is the slowest in the tab and on its node (`metrics.test.ts:312`, `98-metrics.ts:429`), with the real binary in the behaviour check and 7.7's manual check.
- **Done when 3, met:** only the pipeline's components (`99b-cloud-metrics.ts:254`), the mapped file's graph (`:291`), and 7.5's manual check on the user's cluster.
- **Done when 4, met:** the 1/5/15 minute trend lines (`98-metrics.ts:191`) and no negative rate after a restart (`metrics.test.ts:68`, `98:126`).
- **Done when 5, met, with a gap:**
  - Each state shows what to do (`98:246`; `99b:335-402`, `:483-651`).
  - No password leaks (`99-metrics-access.ts:422`, `99b:455`).
  - CI is green on every ticket's push.
  - Manual checks ran on the user's cluster (7.4, 7.5, 7.8).
  - The gap: no manual check names a wrong password or an unreachable endpoint specifically; those rest on the integration tests.
- **Open items, none blocking use:** AI-1 to AI-3 are defects in uncommon paths (the Cloud view not expanded yet, a failed Cloud step, an ordering race on opening the tab, a stale state after new credentials). No ticket is unfinished.

## Open questions

- Answered: the user accepted the verdict (2026-11-21).
- Answered: AI-1's failed Cloud step falls through to the file's Not running state (user, 2026-11-21; bug 58).
- Does C9 matter in practice: does a file's feed stay on the Cloud after the tab closes with the graph open? A test would settle it (AI-8).
