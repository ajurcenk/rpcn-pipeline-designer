---
epic: epic-pipeline-graph
date: 2026-10-12
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective: epic-pipeline-graph (Read-only pipeline graph)

## Epic summary

**Epic:** `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-graph/` (epic 3). Done when: declared (5 items, `epic-pipeline-graph.md`). `pending_tickets`: none.

**Tickets, in build order:**

| Ref | Title | Status / state | Review | Range (baseline..next) | Commits |
|---|---|---|---|---|---|
| 3.1 | Tracer: Show graph draws a pipeline and a click selects its YAML | built / review | thorough | b787266..616ab49 | 2af8ac5, 616ab49 |
| 3.2 | Full protocol and model types with fixture models | built / review | quick | 616ab49..d2ef642 | d2ef642 |
| 3.3 | PipelineModel from the schema's component catalogue | built / review | thorough | d2ef642..61d6c64 | 61d6c64 |
| 3.4 | Groups, resources and design tokens in the graph view | built / review | quick | 61d6c64..3f0356e | deb653c, 3f0356e |
| 3.14 | Probe: group lock, focus return and restored tabs on VS Code 1.100 | built / review | quick | 3f0356e..d790381 | 7d18727, d790381 |
| 3.5 | Graph accuracy in the corpus harness | built / review | thorough | d790381..67c55cd | 67c55cd |
| 3.6 | Live updates that keep the last valid graph | built / review | quick | 67c55cd..feecd29 | 6a63fd3, feecd29 |
| 3.7 | Two-way navigation between the YAML and the graph | built / review | quick | feecd29..1c28bc3 | 77fd358, 564d517, 1c28bc3 (backlog bug 11, not E3) |
| 3.8 | Error and warning markers on nodes | done | thorough | 1c28bc3..bcc3ef4 | f2e2c53 (an E2 test fix after Red Hat 1.25.0), 8aadc20, bcc3ef4 |
| 3.9 | Empty states: no binary and nothing to draw | done | quick | bcc3ef4..126568a | 0956329, 126568a |
| 3.10 | Auto-open, the Hide graph toggle and per-file memory | done | quick | 126568a..c4ce8ce | 486441c, c4ce8ce |
| 3.11 | Keyboard and screen-reader model | done | quick | c4ce8ce..5bff044 | 8dbde83, 5bff044 |
| 3.12 | Refactor sweep | done | quick | 5bff044..fa34f24 | c668fe2 … fa34f24 (9) |
| 3.13 | Newcomer Flow 3 and reload checks by hand | done | none | fa34f24..HEAD (d54aaa3, inferred) | d54aaa3 |

**Still at `built`** (builds finished, not marked done): 3.1, 3.2, 3.3, 3.4, 3.14, 3.5, 3.6 and 3.7.

**Evidence inventory:**
- **Available:**
  - the epic file and `tickets.toml`;
  - 14 plans, each with a baseline, a Review Triage Log and Verification;
  - `spike-3-14-findings/` (findings, probe and log);
  - the `git_evidence.py` output for every range: 35 commits, 0 merges, no binary revisions;
  - the previous retro, `epic-smart-yaml-editing/epic-smart-yaml-editing-retrospective.md`;
  - this session's transcript (`~/.claude/projects/…/268853b3-….jsonl`).
- **Missing:**
  - **story files:** none were refined, so the entries plus the plans are the intent;
  - **earlier transcripts:** session transcripts from before this session's earlier summary exist only as that summary.

## Findings

Sources:
- the aggregate views (subagent, scripts in the scratchpad: `imp.py`, `fn.cjs`);
- the spec reconciliation (subagent);
- `bmad-review` over `b787266..HEAD`: adversarial (ADV), edge-case (EDGE) and verification-gap (GAP) lenses, with the boundaries between tickets weighted.

Lens ids are kept where two lenses found the same thing. Every finding marked *verified* was re-read in the code by the retro.

Dispositions: **fix now** (an action item), **defer** (a backlog story), **accept** (recorded so later runs stop flagging it).

### F1–F10: interactions between tickets (no single ticket's review saw both sides)

| # | Finding | Source | Disposition |
|---|---|---|---|
| F1 | A status post (3.8) still in flight when `ready` posts a snapshot: the snapshot sets `sentStatus = B`, then the old post resolves and sets `sentStatus = A`. A later status A is then never sent, so stale markers stay. *Verified.* | `graphPanel.ts:119-121`, `:284-296`; ADV-1, EDGE-4, GAP-5 | fix now (AI-1) |
| F2 | Hide during a queued Show (3.10): `open()` with `auto=false` never re-checks `hidden`, so the panel opens for a file stored as hidden. *Verified.* | `panels.ts:338-372`, `:420-436`; ADV-7 | fix now (AI-1) |
| F3 | The keyboard way out (3.11 × 3.9): Esc does nothing while the first layout runs (`!laidOut` returns early), and the empty states and the loading or no-schema canvas have no Esc handler and no named, focusable region. *Verified.* | `Graph.tsx:221-223`; `main.tsx:243,281-291`; ADV-11, ADV-12, EDGE-7 | fix now (AI-1) |
| F4 | Live region repeats (3.11 × 3.6 / 3.9): the banner is announced again on every recreated webview (a tab switch back), and after a schema drop and return on an unchanged parse error. A snapshot with `model: null` leaves the error baseline empty, so the first status announces every existing error as new. | `state.ts:164-168,182-185`; `graphPanel.ts:184-192`; ADV-2, ADV-3, EDGE-2, EDGE-3 | fix now (AI-1) |
| F5 | Focus lost on remount (3.11 × 3.9): when the schema goes, Graph unmounts, focus drops to `body` and is not restored when the graph returns (the `hasFocus` ref is new). | `main.tsx:281`; `Graph.tsx:143,179-181`; ADV-13, EDGE-8 | fix now (AI-1) |
| F6 | Disposal races (3.10): a post after dispose (Hide, tab close or rename during an awaited update) logs spurious errors, and `lock()` keeps polling a disposed panel and can run `lockEditorGroup` on whichever group is active. | `graphPanel.ts:242-244`; `panels.ts:521,544`; EDGE-10, ADV-9 | fix now (AI-1) |
| F7 | Rename chains and swaps in one batch (`a→b, b→c`) dispose a panel or collapse `seen`/`hidden`/`driving`, because keys are moved one at a time. The driving editor re-keyed on rename is the old editor object, so it is dropped as invisible. | `panels.ts:281-318`, `:169-174`; EDGE-6, ADV-18 | fix now (AI-1) |
| F8 | Clicking or pressing Enter on the last valid graph under the banner does nothing, silently (3.6 × 3.7 × 3.11). | `graphPanel.ts:375-381`; ADV-10, EDGE-9 | open question (Q1) |
| F9 | Minor, at boundaries: `lastModel` built with the old catalogue is sent as current after a schema change while broken (ADV-14); `hostChanged` skips a document that is not loaded (EDGE-1); the binary listener depends on the schema store subscribing first (ADV-15); queued auto-opens can delay an explicit Show by about 1 s each (ADV-8); `hidden` is never pruned on delete (ADV-16); the webview `<title>` keeps the old name after a rename (ADV-6); a failed `openTextDocument` on `ready` leaves the view on `INITIAL_VIEW` (ADV-17). | as cited | defer (AI-2) |
| F10 | `pendingRenames` leak on an aborted rename. | `panels.ts:179-181`; ADV-4, EDGE-5 | already deferred (backlog 14) |

### F11–F13: verification gaps

| # | Finding | Source | Disposition |
|---|---|---|---|
| F11 | No combined-sequence tests: status in flight during `ready`, a rename with auto-open on, a folder rename (`renamedKey` prefix branch), Hide with no argument while the graph tab is active, `graphOpenPaths` after a rename, and selection plus node status after a late schema. Each ticket tested its own path. | GAP-1…4; ADV-19; `84-graph-auto-open.ts:231-259`; `83-graph-empty-states.ts:120` | fix now (AI-1 adds them) |
| F12 | The graph adapter (`panels.ts` + `graphPanel.ts`, 1,011 lines) has no unit tests with fakes. Epics 1–2 test their adapters behind named Source interfaces; epic 3 calls `vscode.*` directly 21 times and relies on six integration suites. | aggregate 12, 13 | defer (AI-6) |
| F13 | 3.7's manual navigation check was never passed. Its hand-off to 3.13 was not met (3.13 A–C have no click or cursor step). 3.2 and 3.3 still say "pending". Done when 2 itself is satisfied by integration tests. | 3.7, 3.2, 3.3 plans, Verification | fix now (AI-4) |

### F14–F17: aggregate views

| # | Finding | Source | Disposition |
|---|---|---|---|
| F14 | Architecture: layering is clean (`eslint src webview` exit 0), no cycle was added (the two existing ones predate the epic), and the import edges grew from 85 to 142. graphPanel adds the first edges between adapter packages, which no lint rule orders. | aggregate 1–4; `eslint.config.mjs:129-134` | accept (record) |
| F15 | Duplication: the ancestor walk is written 6 times (`nodeAt.ts:37`, `nodeStatus.ts:61`, `layout.ts:155,265,313,409`), the id→node map is rebuilt 5 times in `layout.ts`, `e instanceof Error ? …` is inline 7 times although `errorText` exists, and the test suites re-implement "last snapshot" and per-type filters that `graphHelpers.ts` already has. | aggregate 5–9 | defer (AI-6) |
| F16 | Size: no file is over 600 lines (`panels.ts` 586, `layout.ts` 578, `graph.ts` 539). Classes: `GraphPanels` 482 lines, `GraphPanel` 391, `Builder` 297, the `Graph` component 229. Large, but cohesive after 3.12. | aggregate 10, 11 | accept, watch |
| F17 | Pattern divergence: narrow `Graph*` / `Pick<>` dependency types instead of named Source interfaces (see F12). vitest beside the sources for the webview is intended (eslint comment). The never-throw + log pattern holds. | aggregate 12, 14, 15 | defer with F12 (AI-6) |

### F18–F19: spec-to-implementation reconciliation

| # | Finding | Source | Disposition |
|---|---|---|---|
| F18 | **Accepted deviations** (user decisions, recorded so later runs stop flagging them): auto-open on the first show per session only ("keep as is now", 3.10); Save As not re-keyed ("Leave out", 3.10, backlog 12); Esc in two steps ("Both, two steps", 3.11); Retry on the no-binary state (epic Decision 2026-10-08); the roving Tab stop on the last-focused node (3.11). | the plans cited | accept |
| F19 | **Docs to reconcile to the build:** AD-1 (Save As; the `graphOpenPaths` context key; the `retainContextWhenHidden` `[ASSUMPTION]` is now settled as `false`); AD-5's message union (`retryRequested`, `focusEditorRequested`, `NodeStatus.own` / `ownMessages`); DESIGN :100 (the Hide icon `eye-closed`); CAP-1 and EXPERIENCE :52 (Retry); the EXPERIENCE `[ASSUMPTION]` markers at :53, :114 (Esc, Tab), :124, :128; EXPERIENCE :113's "Fit to view" action (only automatic fit exists); Flow 3 steps 8–9 (a curl and the first message), not part of the timed check. | spec agent A.2, A.3, A.5, A.9–A.11, A.18, A.20 | fix now (AI-3, proposed) |

## Behavior verification

**Exercised end to end by the user, by hand, in a real VS Code window.** Each check is recorded in its plan's Verification section:

| Flow | Version | Result | Source |
|---|---|---|---|
| Show graph, the readable size, clicking a node | 1.103.2 | passed | 3.1 plan; commit 616ab49 |
| Groups, routes, resources, theme tokens | 1.103.2 | passed | 3.4 plan; 3f0356e |
| Lock, focus return and reload probe | 1.141.0 and 1.100.0 (automated probe); 1.103.2 and 1.100.0 (reload by hand) | answered | `spike-3-14-findings/findings.md` |
| Live updates and the banner, including a locked group | 1.103.2 | passed | 3.6 plan; feecd29 |
| **Two-way navigation (3.7)** | 1.103.2 | **not confirmed**: the user said "continue" without a result | 3.7 plan; 564d517 |
| Error and warning markers, the roll-up, clear on edit | 1.103.2 | passed | 3.8 plan; bcc3ef4 |
| The no-binary state, Set path, Retry, nothing to draw (with PATH stripped) | 1.103.2 | passed | 3.9 plan; 126568a |
| Auto-open, one graph group, Hide across a reload, tab close, rename | 1.103.2 | passed (auto-open is on the first show only; the user decided to keep that) | 3.10 plan; c4ce8ce |
| Keyboard only: Tab, the arrows, Space, Enter, two-step Esc, the focus ring | 1.141.0 | passed (Orca not reported) | 3.11 plan; 5bff044 |
| Flow 3, from an empty file to a running pipeline | 1.141.0, clean profile | **under 10 minutes**, no issues | 3.13 plan; d54aaa3 |
| Reload with a graph open and a stored Hide | 1.141.0 and 1.100.0 | passed | 3.13 plan |
| Marker contrast on a selected node | 1.141.0: Dark, Light, High Contrast | passed | 3.13 plan |

**Exercised by the retro (2026-10-12):**
- **The packaged artifact:** `npx vsce package` into the scratchpad (not published) produced 13 files, 747.68 KB. It holds `dist/webview.js`, `webview.css`, `codicon.ttf` and `extension.js`, plus `NOTICE`. `NOTICE` names elkjs 0.12.0 (EPL-2.0, with its source URL), React 19.3.0, @xyflow/react 12.12.0, its d3 and zustand dependencies, and @vscode/codicons (CC-BY-4.0 font, MIT CSS). That is Done when 5's second half.
- **Automated suites at HEAD:** 627 integration tests passing on 1.141.0, 1.140.0 (one-off run) and 1.100.0; 128 webview tests (14 in happy-dom); 123 corpus tests. CI was green on every push.

**Not exercised:**
- a screen reader (Orca);
- Save As, deliberately out of scope (backlog 12);
- the two automated reload paths: an empty locked group reused, and a failing `lockEditorGroup`. Each was observed only once, by hand, and reported as "no issues".

## Previous-retro follow-through

From `epic-smart-yaml-editing/epic-smart-yaml-editing-retrospective.md` (actions A1–A8):

| Action | Status | Evidence |
|---|---|---|
| A1: a docs-less schema is cached as complete | **not done** | `src/adapters/redpandaConnect/schema.ts:253-266` only logs. No ticket or backlog story tracks it. |
| A2: a Quick Fix against other findings | done (before E3) | 2.22 "Fix all" (0e1a35e); backlog 10 (5c94ce6) |
| A3: E2 spec, architecture and UX reconciliation | done | 2c4fbb4, before b787266 |
| A4: track the untracked limits | **not done** | no backlog stories for no_color on Windows, the block-scalar fix, detection false positives and flow mappings, or Run in a remote window. Backlog 7 and 9 predate the retro. The stale `story-literal-glob-characters-in-resource-files.md` has no status, while its plan says `dropped`. |
| A5: code health (`errorText` duplicated; `fieldsAt`/`optionsAt` not on `nodesAt`; swallowing `catch {}`) | **not done** | `redhatYaml/contributor.ts:15` vs `redpandaConnect/text.ts:4`; `schemaFields.ts:30,79,104`. 3.12 covered E3 items only. |
| A6: review depth follows risk | partly | medium-risk 3.1, 3.3, 3.5 and 3.8 ran thorough; medium-risk 3.10 ran `quick` (pinned). The quick reviews still found 3 medium findings each in 3.10 and 3.11. |
| A7: probe first, and amend the docs in the deciding ticket | partly | probe first: spike 3.14 before 3.10. Amended in the same ticket: AD-20 in 3.3 only. AD-5 and AD-1, CAP-1 and EXPERIENCE were not (F19). |
| A8: record every manual check's outcome | mostly | all E3 plans except 3.2 and 3.3 ("pending") and 3.7 (not passed) |

## Action items

All of these are proposed. The human decides what to run, and nothing here was applied.

| # | Action | Owner | Covers |
|---|---|---|---|
| AI-1 | **New story: "Graph interaction fixes across tickets".** Fix F1–F7 and add the combined-sequence tests of F11 (host-side scenarios through the `posted` seam and `idle()`; reducer chains such as snapshot → hostStatus(none) → hostStatus(ok) → model → parseError, with the live output asserted). Thorough review. | next build (bmad-build) | F1–F7, F11 |
| AI-2 | **Backlog stories** for the minor boundary items in F9. One grouped story is enough. | bmad-ticket | F9 |
| AI-3 | **Reconcile spec, architecture and UX to the build** (F19), as A3 did for E2: amend AD-1 and AD-5, DESIGN :100, CAP-1, the EXPERIENCE markers, the Fit to view line and the Flow 3 scope. Add a memlog line in each. | user approves, then agent | F19 |
| AI-4 | **Close the manual-check gaps:** the user runs 3.7's navigation check (click → YAML selected and centred; cursor → node highlighted, focus stays in the editor), and 3.2 and 3.3 are recorded as covered by 3.4's check. Then mark 3.1–3.7 and 3.14 done. | user + bmad-ticket | F13 |
| AI-5 | **Carry over E2 A1 and A4** as backlog stories (the docs-less schema; the four untracked limits; mark the glob story dropped). | bmad-ticket | follow-through A1, A4 |
| AI-6 | **Code-health story** (merges with E2 A5): a shared ancestor walk and id map for the model, `errorText` everywhere, a `GraphPanelsSource` with adapter unit tests, and shared test filters. | backlog | F12, F15, F17, E2 A5 |
| AI-7 | **Process lesson: test and review the boundaries.** Each plan names the earlier tickets its code meets (the `after` list) and adds at least one combined-sequence test for each such boundary. Its review weights those boundaries. Evidence: F1–F7 were all found only at the epic level; the per-ticket quick reviews still found medium bugs (3.10, 3.11). | process (bmad-build plans) | F1–F11 |
| AI-8 | **Process lesson: amend docs in the deciding ticket** (E2 A7 again). A plan that adds a protocol message, a context key or a user decision updates the AD or UX line in the same commit. | process | F19, follow-through A7 |

## Acceptance verdict

**Machine verdict: accepted-with-open-items.** The criteria were declared (Done when 1–5).

| Done when | Status | Evidence |
|---|---|---|
| 1. Auto-open, lock, focus, Hide across reloads | met | AUTO, HIDE and SHOW tests; 3.10 manual check; 3.13 B on 1.141.0 and 1.100.0 |
| 2. 100% of the corpus on v4.100.0 and v4.112.0; click and cursor in integration tests | met | `test/corpus/corpus.test.ts:352-377` (15 configs × 2); CLICK and CURSOR tests in `81-graph-navigation.ts` |
| 3. Per-keystroke updates with the banner; empty states; draws after Set path | met | 3.6 and 3.9 manual checks; MISSING, SET_PATH, RETRY and NOTHING tests |
| 4. Markers from the deduped diagnostics, never colour alone | met | 3.8 manual check; 3.13 C contrast |
| 5. Flow 3 under 10 minutes; the `.vsix` with the graph and the elkjs notice | met | 3.13 A ("under 10 minutes"); the retro's `vsce package` and CI `ci.yml:51-56` |

**Open items:**
- **Real but tolerable bugs at ticket boundaries** (F1–F7). None breaks a Done when item. They show up under races or for keyboard and screen-reader users.
- **Docs to reconcile** (F19).
- **Manual-check records** for 3.2, 3.3 and 3.7 (F13).
- **Epic 2 actions not done:** A1, A4 and A5.

There are no unfinished tickets; eight are at `built`.

**Human decision:** _pending_.

## Open questions

- **Q1 (F8):** what should a click or Enter on a node do while the YAML is broken? (a) Nothing, as now, but say so (the node names gain "navigation unavailable while the YAML has errors"); (b) select the parse error, as the banner does; (c) reveal the node's last known range. The answer changes AI-1's scope.
- **Q2:** should AI-1 be done before the next epic starts, or alongside it?
- **Q3:** does the user accept the verdict **accepted-with-open-items**, or want **accepted** once AI-1 and AI-4 land?
