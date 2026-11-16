---
title: "Deploy warns about a config's local-only parts"
type: 'feature'
ticket: '43'
created: '2026-11-16'
status: 'built'
baseline_revision: 'a7b31033f07415fa739f470f9c5987cb06822746'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A config that reads stdin, writes stdout, uses local files or programs, or serves `http_server` deploys to Redpanda Cloud with no warning about those parts, though they cannot work there as they do locally. The pre-deploy check (5.8) refuses a component only when the cluster's list leaves it out; a listed local-only part (the `http_server` input on today's clusters) or any local-only part when the components list cannot be read passes silently.

**Approach:** Deploy finds the config's local-only parts, shows each as a Warning in the Problems panel on its line (source "Redpanda Cloud"), and says so in the same prompt as the check's findings, with **Deploy anyway**. Escape sends nothing; a clean config is not asked.

**Decision (user, 2026-11-09):** moved here from epic 5's refactor sweep (5.9). No floor (VS Code 1.100.0) runs (user).

**Decisions (user, 2026-11-16, the recommended options):** the local-only list is inputs `stdin`, `file`, `csv`, `parquet`, `socket`, `socket_server`, `subprocess`, `http_server`; outputs `stdout`, `file`, `socket`, `subprocess`, `http_server`; processors `command`, `subprocess` (the catalogue's "Local" tag plus local programs and servers); a part the cluster check already flags as an error gets no second warning; one prompt lists the check's errors, then the local-only parts, with one Deploy anyway; a config with only local-only parts gets a message naming them, with Deploy anyway.

## Boundaries & Constraints

**Always:** The 5.8 check's error texts, messages and order unchanged when no local-only part is present; the step order (the check before the secrets, nothing at all sent on Escape); one components read per deploy; the Problems entries in the same `redpanda-cloud-check` collection, so they clear as the check's do (file change or close, the next deploy); secret values out of messages and logs (bug 44).

**Never:** A second prompt; refusing a local-only part outright; a warning for a part the cluster check already reports; a new setting.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| WARN_ONLY | `stdin` input, `file` output; the cluster lists both | a Warning on each line, source "Redpanda Cloud"; one message naming them with Deploy anyway | Escape: nothing sent (`checkStopped`); Deploy anyway: sent as before |
| MIXED | a missing component (5.8 error) and an `http_server` input the cluster lists | the error and the warning in Problems; one message: the error clause as today, then the local-only parts | as above |
| ALREADY_ERROR | `stdin` input the cluster leaves out | the 5.8 error only, its message as today; no warning for it | — |
| NESTED | a `command` processor in a `switch` case | a Warning on its line | — |
| CLEARED | warnings shown | gone on a change, a close, the next deploy | — |
| CLEAN | generate input, drop output | no prompt, as today | — |
| NO_CATALOGUE | no local binary and the components list fails | as today (the list-failure message); no local-only warnings, since no catalogue locates the parts | — |

</frozen-after-approval>

## Code Map

- `src/core/cloudCheck.ts` -- `ClusterComponents` :35, `CloudFinding {line, start, end, text}` :48, `findingMessage` :59 (`line N: text`), `categoryText` :181, `checkAgainstCluster(text, uses, calls, cluster, clusterName)` :190 (flags a use only when the cluster lists its category but not its name :196-197; sorted by `start`).
- `src/core/graph.ts` -- `ComponentUse {category, name, offset}` :114; `componentUses(parsed, text, catalogue)` :129 (inputs, outputs, processors nested, resources, buffer, metrics, tracer, scanners; `[]` with no catalogue or a YAML error :132).
- `src/adapters/vscode/cloudDeploy.ts` -- `DEPLOY_ANYWAY_ACTION` :52, `CHECK_SOURCE` :54, `CHECK_COLLECTION` :55, `MAX_LISTED_FINDINGS` :57; `deploy` clears the collection :163, `checkBeforeSending` :250 (before the secrets :257); `checkBeforeSending` :438-511 (one progress for lint and `getComponents` :439-453; lint errors :454-467; cluster findings from `componentUses(parseYaml(source), source, ctx.localCatalogue() ?? components.catalogue)` :468-472; merged and sorted :473-476; early return :478; Problems entries `DiagnosticSeverity.Error` :481-485 with `rangeOf` :945 / `lineRange` :955; message :486-501; `ctx.showError(message, DEPLOY_ANYWAY_ACTION)` :504; Escape returns `{kind:'checkStopped', findings, listError?}` :510).
- `src/adapters/vscode/cloudView.ts` -- `checkStopped` result type :343; collection created :562; cleared on change :578-582 and close :583; ctx `showError`/`showInfo` :412-413.
- Data: `test/fixtures/schema/json-full-4.112.0.json.gz` (catalogue "Local" tags); the real cluster's list `_bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-5-1-findings/captures/18-components-candidate.json` (no stdin/stdout/file/subprocess/command/socket; `http_server` input listed :101).
- Tests: `src/test/integration/suites/96-cloud.ts` helpers `checkEntries` :2207 (add severity), `componentReads` :2209, `STDIN` :2210, `finding()` :2211, `CONFIG` :74, `CLEAN_LINT` :101, reset :328-333; models ACCEPTANCE 8 / MISSING_COMPONENT :2213, before the secrets :2242, DEPLOY_ANYWAY :2256, nested and close :2268, LIST_FAILS :2353, VERSIONS :2374, CLEAN :2387. Fake `src/test/helpers/fakeCloud.ts` component list :103-115 (the full 4.112.0 list, stdin included), `missingComponents` :89. Unit `src/test/core/cloudCheck.test.ts` componentUses :119, MISSING :158, CORPUS :180.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/cloudCheck.ts` -- `LOCAL_ONLY` (category → names, as decided) and a pure `checkLocalOnly(text, uses, flagged)` returning `CloudFinding`s for each local-only use not at an offset `flagged` already holds; text such as "input \`stdin\` runs on this machine; on Redpanda Cloud it cannot work as it does locally"; unit tests (each listed name, nested processors, the skip of flagged offsets, a clean config, the corpus gives no surprise warnings beyond the listed names).
- [x] `src/adapters/vscode/cloudDeploy.ts` `checkBeforeSending` -- compute the local-only findings beside the cluster findings (same `componentUses` result); set them in the same collection with `DiagnosticSeverity.Warning` and `CHECK_SOURCE`; the early return needs no warnings either; the message: with errors, today's text plus a clause listing the local-only parts (capped as `MAX_LISTED_FINDINGS` caps); with warnings only, a message naming them ending "Nothing was sent." with Deploy anyway; Escape returns `checkStopped` with the warnings among the findings.
- [x] `src/test/integration/suites/96-cloud.ts` -- `checkEntries` also reports severity; new tests WARN_ONLY, MIXED, ALREADY_ERROR, NESTED, CLEARED (change, close, next deploy); the existing check tests keep their assertions (they remove `stdin` from the cluster, so ALREADY_ERROR holds there).
- [x] `README.md` -- the Deploy section names the local-only warning and the list.

**Acceptance Criteria:**
- Given the matrix rows, when the unit and integration tests run, then each row is covered and passes.
- Given compile with lint, corpus, webview, stable and multi-root runs, when they run, then all pass, and no existing 5.8 assertion changed (any change to `checkEntries`'s output format is applied to the existing tests mechanically and listed in Implementation Notes).

## Implementation Notes

- `src/core/cloudCheck.ts`: `LOCAL_ONLY`, `isLocalOnly`, `localOnlyName`, `localOnlyText` and `checkLocalOnly(text, uses, flagged)`, which returns `LocalOnlyFinding`s (a `CloudFinding` plus `part`, "input `stdin`", for the deploy message). Finding text: "input `stdin` runs on this machine; on Redpanda Cloud it cannot work as it does locally".
- `checkBeforeSending`: one `parseYaml` and one `componentUses` feed both checks; the catalogue is `localCatalogue() ?? components?.catalogue`, so with a local schema the local-only parts are also found when the components list fails (the list-failure message then gets the parts clause); with neither, nothing (NO_CATALOGUE). Flagged offsets are the cluster findings' `start`s.
- Messages: with errors, today's text then " This part runs on this machine and cannot work on Redpanda Cloud as it does locally: line 2: input `http_server`." (plural "These parts run … as they do locally"), before the versions clause and "Nothing was sent."; warnings only: "orders.yaml uses a part that runs … : line 9: processor `command`. Nothing was sent." shown as an information message (`ctx.showInfo`) with Deploy anyway, since nothing in it is an error. The parts list is capped like the findings (`MAX_LISTED_FINDINGS`). `checkStopped.findings` holds the errors' messages; `checkStopped.warnings` the warnings' (`line N: <text>`), when any. The log gets "uses N local-only parts" plus one line each; the "found N problems" line is kept unchanged whenever there are errors or no local-only parts.
- `checkEntries` (96-cloud.ts): a Warning entry is prefixed `warning `; an Error entry keeps the old format, so no existing assertion changed.
- Mechanical test change: NO_BINARY's second half ("Clean otherwise: deployed without a prompt") deployed `STDIN` with the full list, which now warns; it edits the file to `CONFIG` first. No assertion changed.
- The 96-cloud harness's `info` stub now records its actions (`infoActions`), reset per test.
- New integration tests: WARN_ONLY 43, MIXED 43, ALREADY_ERROR 43, NESTED 43 (cluster and local catalogue), CLEARED 43 (change, next deploy, close), NO_CATALOGUE 43. CLEAN is the existing CLEAN test. New unit tests in `src/test/core/cloudCheck.test.ts`: each listed name, nested, flagged skip and clean, corpus.

- Review fixes: a quoted key's range skips the quote; at most `MAX_LISTED_FINDINGS` listed in all (errors first, the parts in the room left, each list counting its rest; with no room, "N parts run … (see the Problems panel)"); "found N problems" is also logged when the list read failed; Problems entries in line order; `checkStopped` gets a separate optional `warnings` (`findings` are the errors only, as before); the corpus unit test pins eval.yaml, jira_input.yaml and awk.yaml; new integration tests LISTED 43, LINT_AND_LOCAL 43, CAPPED 43.

## Plan Change Log

## Review Triage Log

Thorough review (2026-11-16; blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Verdicts: 0 high, 2 medium, 13 low (8 patched, 5 rejected), 1 false. Routes: 10 patch, 1 defer, 0 loopback.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 1 | EC | A quoted component key gives a range starting at the quote and cutting the name | medium | patch | The range is `offset .. offset + name.length`; skip the quote. |
| 2 | VG, BH, IA | The cap on the local-only list ("and N more") untested; with both lists full the message lists twice the cap | medium | patch | No test reaches it; the total is capped, with a test of 6 parts. |
| 3 | BH, EC | "found N problems" no longer logged for a failed list with local-only parts | low | patch | The guard drops it; `listMessage` added. Log lines asserted. |
| 4 | BH | Problems entries not in line order | low | patch | Sorted by range start. |
| 5 | BH, IA | `checkStopped.findings` mixes errors and warnings | low | patch | A separate `warnings` field. |
| 6 | BH | `LOCAL_ONLY`'s doc says derived, the list is fixed | low | patch | Doc says what it is. |
| 7 | BH, IA | README "Not yet" line now stale; the warnings-only message kind unstated | low | patch | Reworded. |
| 8 | BH, EC | The corpus test is circular; a comment names a case it does not test | low | patch | Pinned expectations; comment fixed. |
| 9 | BH, EC | NO_BINARY's clean half switched configs, so "the cluster lists stdin, no error" is no longer shown alone; no lint-plus-local-only case | low | patch | Both added. |
| 10 | BH | The list misses cache `file`, Bloblang `file()`/`env()`, `http:` and `prometheus`, `wasm` | low | reject | The user decided the list (2026-11-16); the README now names what is not checked. |
| 11 | BH | No opt-out from the prompt | low | reject | A new setting is out of the plan's Boundaries ("Never: a new setting"). |
| 12 | BH | The warning gives no next step | low | reject | The text was the plan's; hints per component are new wording beyond the ticket. |
| 13 | BH | Derive the list from the catalogue's Local tag | low | reject | The tag misses programs and servers; the decision is a fixed list. |
| 14 | IA | No warnings with neither a local binary nor a readable list | low | reject | The frozen matrix (NO_CATALOGUE) decides it. |
| 15 | EC | The quoted-key range also affects the 5.8 errors | low | defer | Pre-existing in `checkAgainstCluster`; changing the errors' range is outside this ticket. |
| 16 | IA | Escape tested only through the injected prompt | false | reject | All Deploy tests use the `CloudUi` stub; a non-modal toast resolves `undefined` on dismiss, as 5.8 relies on. |

## Design Notes

On today's real clusters most local-only parts are already refused by 5.8 as missing; the warning covers what the cluster lists anyway (the `http_server` input), other cluster versions, and the fake cluster used in tests. The check needs a catalogue to locate the parts, as 5.8 does; with neither a local binary nor the cluster's list, both stay silent and the list-failure message stands.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (lint included)
- `npm run test:corpus`, `npm run test:webview` -- expected: pass
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: 0 failing
- same with `--label multiroot` -- expected: 0 failing

**Manual checks (if no CLI):**
- Dev host on the user's cluster: deploying a config with an `http_server` input shows its Warning in Problems and the Deploy anyway message; Escape sends nothing.

**Result (2026-11-16, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 385, stable 1538 passing, 1 pending, 0 failing (11 min), multi-root 15 passing; the test settings clean; no floor run.
