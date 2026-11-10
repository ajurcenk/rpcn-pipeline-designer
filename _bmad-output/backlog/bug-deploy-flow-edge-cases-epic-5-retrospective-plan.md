---
title: 'Deploy is safe against a second deploy, a stale target and old states, and says what it sent'
type: 'bugfix'
ticket: '45'
created: '2026-11-10'
status: 'built'
baseline_revision: 'e94a81ee6c900648f91169263fe43a63b40c3621'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bug 45 group A (criteria 1, 3, 7, 8; findings C1, C4, C8, C9 and two of C10). A second Deploy of a file while one waits creates a second pipeline. After a secret is created, an unchanged config logs "nothing was sent", and a failed create or update does not name the secrets created. The target is read once before the prompts, so a pipeline started or retagged meanwhile is restarted with no confirmation and gets the old description and tags; an account switch during the prompts is not noticed. An update of a pipeline in Error can report its old error against the new config; Stopping and unknown states are polled until the timeout, which then says "still starting".

**Approach:** A per-file in-flight guard at the one entry all deploys share. The created secrets travel to every result and message. The pipeline is read again just before the update is sent, and the account checked. The follow treats an update from Error, and Stopping and unknown states, per the matrix.

**Decision (user, 2026-11-10):** bug 45 split; group A built first; groups B (names), C (translation and Compare) and D (tests) are in deferred work.

**Decision (user, 2026-11-10, the recommended option):** FROM_ERROR is followed, then reported as known (no cluster check first). The plan is kept whole above the size guideline.

## Boundaries & Constraints

**Always:** every refusal or stop sends nothing more and says so, in the flow's existing style (log line plus message); secret values never appear in any message, log line or result (bug 44's masking unchanged); a declined restart keeps its created secrets with a message (5.7, DECLINED_RESTART); the clean deploy, update, start, stop and delete unchanged.

**Never:** groups B, C, D; a change to the tag or mapping format; a change to which secrets are asked about; a new dependency; a floor (1.100.0) run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DOUBLE | a deploy of a file waits at a prompt; Deploy of the same file again (title, palette or row) | the second is refused with a message naming the file; nothing sent by it; the first goes on and ends as alone | none |
| OTHER_FILE | a deploy of A waits; Deploy of B | B runs as today | none |
| SENT_UNCHANGED | unchanged config, a missing secret created | the log and message name the secret created; never "nothing was sent" | none |
| SENT_FAILED | secrets created, then the create or update is rejected or fails | the message names the secrets created, with the API's message | as today otherwise |
| STARTED_MEANWHILE | mapped, stopped pipeline; started elsewhere while Deploy waits | re-read before the update: the restart confirmation is asked; declined keeps created secrets as today | none |
| RETAGGED | description or tags changed elsewhere while Deploy waits | the update keeps the current description and tags | none |
| GONE | the pipeline deleted while Deploy waits | handled as a mapped pipeline that no longer exists today | as today |
| ACCOUNT | the account changes (connect, disconnect, another service account) during the prompts | the deploy stops before sending, with a message; created secrets named | none |
| FROM_ERROR | update of a pipeline in Error; the answer still says Error | the answer is not final: the follow waits for the state to leave Error or for the restart grace period; still Error after that: the result says the pipeline is still in Error and that the error shown may be from before this deploy; a state left Error is reported as that state | none |
| UNKNOWN | the follow sees a state the extension does not know | the follow ends at once with a result naming that state | none |
| STOPPING | the follow sees Stopping until the timeout | the timeout message names the last state seen, not "still starting" | none |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudDeploy.ts` -- `deploy` :105-114 (every entry meets here; the uri is resolved in `deployFile` :117-120, guard after it); refusal style `log` + `showInfo('… Nothing was sent.')` + `NOT_STARTED` (:166-168); `mappedTarget` :574 read at :179; size pick :186, check :198, `ensureSecrets` :203 (`created` :456-457, stop results :402, :447, :466); unchanged shortcut :222-229 ("nothing was sent" :226); restart confirm :230-248 (`REPLACE_ACTION`, `createdSecrets` :243-247); description :253, tags :256, `wasRunning` → `restart` :259, :646; `createAndFollow`/`updateAndFollow` :610, :630; `follow` :661-702 (final at once :674, `change` + `restartGraceMs`, timedOut :680); `report` :705-743 (rejected :712-718, failed :719-723, timedOut "still starting" :725-727, final with error :731-735).
- `src/adapters/vscode/cloudLogs.ts` :39, :108-114 -- the in-flight Set pattern to copy ("…is already running…; this request was ignored.").
- `src/adapters/vscode/cloudView.ts` -- `DeployResult` :310-322; `CloudContext` :375 (`account`), `readPipeline` :404 / :1052 (re-read; updates the cache; shows non-404 errors); private `accountGeneration` :500, bumped :740, :811, :877 (expose it on the context, or compare `account.clientId`).
- `src/adapters/cloud/dataPlane.ts` -- final states :59, `isRunning` :103, `KNOWN_STATES` :114, `getPipeline` :232.
- `src/test/helpers/fakeCloud.ts` -- sequences :144-150 (per GET :66-67, :454), `failures` :154, `delay` :156, `requests` :132, PUT keeps a non-running state and old error :493-499.
- `src/test/integration/suites/96-cloud.ts` -- UI seam :228-262, `duringUnits` :108 (runs while the size pick is open; EDIT_DURING_PROMPTS :1083); neighbours to keep passing: DEPLOY :440, DEPLOY_ERROR_STATE :493, timeout :512, UPDATE_RUNNING :755, UNCHANGED :817, UPDATE_STOPPED :840, EDIT_DURING_PROMPTS :1083, CHANGE_LOCAL :1232, DEFAULT_NONE/LOCAL :1286, DECLINED_RESTART :1333, CONFLICT :1346, STATES :1487, STALE state :1580, DEPLOY_AGAIN :1910, NO_LEAK :2185.

## Tasks & Acceptance

**Execution:**
- [x] `cloudDeploy.ts` -- per-file in-flight guard (released in `finally`); created secrets carried to the unchanged, rejected, failed and stop messages and logs; re-read the target and check the account just before the update; the follow per FROM_ERROR, UNKNOWN, STOPPING.
- [x] `cloudView.ts` -- whatever the account check needs on `CloudContext` (the generation, read only); `DeployResult` carries the created secret names where a message needs them.
- [x] `96-cloud.ts` -- one test per matrix row (DOUBLE driven from `duringUnits`; STARTED_MEANWHILE, RETAGGED, GONE and ACCOUNT from `duringUnits` changing the fake or the account; states from fake sequences).
- [x] `CHANGELOG.md` -- one "Fixed:" line.

**Acceptance Criteria:**
- Given the change, when the 96-cloud suite runs, then every matrix row's test passes and the neighbours listed in the Code Map pass unchanged.
- Given the guard, when a deploy ends by any path (result, refusal, Escape, thrown error), then the same file can be deployed again.

## Implementation Notes

- Guard: `deployFile` resolves the document, then a `Set` of URIs (released in `finally`) wraps the new `deployDoc`; the refusal is a log line plus "A deploy of <file> is already running; this request was ignored. Nothing was sent."
- Re-read: a running pipeline is still confirmed on the first read (so UPDATE_RUNNING's cancel sends and reads exactly what it did before); the pipeline is then read again (`readPipeline`) before the PUT. The fresh read decides unchanged, a restart confirmation not yet asked (STARTED_MEANWHILE), the description and tags (RETAGGED), the restart follow, and the Error follow. A 404 goes to `goneTarget` (split out of `mappedTarget`, the same offer or strict refusal). A pipeline offered by its tag with no mapping that is gone is said so and nothing is sent.
- Account: the connected `account?.clientId` at the deploy's start against the current one (a disconnect or another service account is a change; a failed or superseded Connect is not; `accountGeneration` is not exposed). It is checked after the size pick, after the check's prompt, before each secret create, before the create, before the re-read and after a late restart confirmation. A disconnect during the size pick would otherwise surface as a failed components read.
- Created secrets: `DeployResult` `notStarted`, `rejected`, `failed` and `unchanged` carry an optional `createdSecrets`. `report` appends "Created X on C; they stay." to rejected and failed. An Escape at a later secret now also shows the kept message.
- Follow: an unknown state ends it at once (start and stop too, since they share `follow`); `timedOut` carries the last `state` and the deploy's timeout message uses it; an update from Error follows with `change: { from: 'STATE_ERROR' }`, and still Error after the grace period gives `final` with `errorFromBefore: true` ("…is still in Error: <reason>. The error shown may be from before this deploy.").

## Plan Change Log

- Review fixes (2026-11-10): "unchanged" is decided on the re-read only (CHANGED_MEANWHILE test); a gone pipeline's refusal after secrets were created says "Created …; they stay. Nothing more was sent." in one message; the account check compares the client ID; ACCOUNT covers a switch to another service account and a failed Connect; DOUBLE covers the row's Deploy again; README's timeout sentence and the CHANGELOG line corrected. `fakeCloud.ts` gains `otherClients`.

- MASK_SENT (bug 44, not in the Code Map's neighbour list) changed its expected failed-create text: it now ends with "Created B_44, C_44 on rpc-vilnius; they stay." (SENT_FAILED's intended behaviour); the failed log line is now the message text exactly.
- `src/test/helpers/fakeCloud.ts` (listed in the Code Map, not in Tasks): `errorUpdateSequence`, so FROM_ERROR's "a state left Error" can be driven; reset in the suite's setup.

## Review Triage Log

Quick review (2026-11-10): 0 high, 2 medium, 5 low patched, 1 low rejected, 0 false.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | "Unchanged" decided on the stale first read: a pipeline changed elsewhere while Deploy waited is reported "nothing changed" and not updated (C8) | medium | `if (same(first)) return unchanged(first)` runs before the re-read; the re-read only runs when the first read differs | patch (a same first read is read again; only a same re-read is unchanged; a test) |
| 2 | Re-read 404 after secrets were created: "…Nothing was sent." then "Created S on C; they stay." | low | `goneUnmapped` and strict `goneTarget` say "Nothing was sent" before `keptSecrets` runs | patch ("Nothing more was sent" when secrets were created) |
| 3 | A failed or superseded Connect during the prompts stops the deploy as an account change | medium | `CloudView.connect` bumps `accountGeneration` at the start of every attempt, before the token request | patch (compare the connected account's client ID) |
| 4 | ACCOUNT 45 exercises only a disconnect | low | the row names connect, disconnect, another service account; both parts of the test disconnect | patch (a switch stops; a failed Connect does not) |
| 5 | DOUBLE 45 never uses the row's Deploy again as the second request | low | the test drives the command by URI and from the active editor only | patch (the row's path added) |
| 6 | README:86 still says the timeout message is "still starting" | low | the timeout now names the last state seen | patch |
| 7 | The CHANGELOG line says a deleted pipeline is offered to be created anew, true only for a mapped Deploy | low | `goneUnmapped` and strict `goneTarget` refuse with nothing sent | patch |
| 8 | `errorFromBefore` is also set on a Start's follow result, which ignores it | low | `follow` is shared with Start (`cloudActions.ts:262`); no message changes | reject (no user-visible effect; a fix adds a parameter) |

## Verification

**Commands:**
- `npm run compile` -- expected: 0, lint included.
- `npm run test:corpus`; `npm run test:webview` -- expected: pass.
- `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); then `--label multiroot` -- expected: all pass. No floor run.

**Results (2026-11-10):** compile and lint 0; corpus 156 passed; webview 378 passed; stable 1371 passing, 1 pending (the 11 new 45 tests among them); multiroot 10 passing. No floor run.

**Result (2026-11-10, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 156, webview 378, stable 1372 passing (1 pending; the 12 bug 45 tests, MASK_SENT and NO_LEAK among them), multi-root 10; `git diff --stat e94a81e -- src/extension.ts webview/src` empty; the test settings clean; no floor run.

**Manual checks:** (pending: the user's cluster)
- Dev host 1.143.1 on the user's cluster: Deploy a file twice quickly (the second refused); start a stopped mapped pipeline in the Cloud UI while Deploy waits at the size pick (the restart is confirmed).

