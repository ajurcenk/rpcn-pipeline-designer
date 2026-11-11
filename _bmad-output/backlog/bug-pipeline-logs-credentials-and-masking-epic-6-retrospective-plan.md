---
title: 'Pipeline logs credentials and masking'
type: 'bugfix'
ticket: '52'
created: '2026-11-11'
status: 'done'
baseline_revision: '833ef1bbd9d69e2de4f514c81a954d06840f436f'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs-retrospective.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stored log access (a Redpanda user and password per cluster) cannot be removed by the user; Disconnect or an account change leaves it in memory and the Pipeline Logs panel reading; an access removed or replaced in another window keeps being used. Masking misses a secret inside a JSON array or string value (escaped), a `license_org` learned after earlier rows, and a password under 4 characters; a refused password masks rows for the session; Load older shows the cluster's error text in the panel (epic 6 retrospective A8, C16–C20).

**Approach:** A Forget log access command per cluster; Disconnect and an account change stop the panel and clear the accesses held in memory; the panel's source reads the current access at each sign-in; masking walks every value shape and re-masks the rows held when a new secret is learned; log passwords are masked by their own rule while kept; the panel shows its own messages only.

**Decision (user, 2026-11-11):** from the epic 6 retrospective's AI-2; Forget is per cluster; the review runs the adversarial and edge-case lenses (retrospective AI-6).

**Decisions (user, 2026-11-11, the recommended options):** Disconnect clears the accesses in memory only; the stored records stay until Forget log access. A password under 4 characters is masked by whole-value match in rows and by substring in error text.

## Boundaries & Constraints

**Always:** NO_LEAK and WRITE_FAIL pass unchanged; no password in settings, files, argv, logs, messages, the panel or an export; bug 44's sent-value masking unchanged; every other Pipeline Logs behavior as today.

**Never:** the reading and state cases (bug 51); a change to how access is set up or stored; a new dependency; a floor (1.100.0) run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FORGET | access stored for clusters A and B; Forget log access on A (row menu, and the palette with a cluster pick) | A's record removed from secret storage and memory; B's stays; A's row loses "logs: user"; an open panel on A stops reading and shows No log access | Escape: nothing changes |
| DISCONNECT | open panel reading; Disconnect | the panel stops and says the account was disconnected; the accesses in memory are cleared and not used again; the stored records stay (Forget removes them), so reconnecting the same account reads them again | none |
| ACCOUNT_CHANGE | open panel; another service account connected, or the account changed in another window | as DISCONNECT, saying the account changed | none |
| STALE_REMOVED | open panel; the access removed in another window | the next sign-in shows No log access, not Connection lost; the old password is never sent | none |
| STALE_REPLACED | open panel; the access replaced in another window | the next sign-in uses the new access | none |
| MASK_SHAPES | a record value that is a JSON object, array, string or number, or plain text, holding a secret raw or with `"` / `\` | masked in every form in the row and the export | none |
| MASK_LATER | a secret (a `license_org`, a new password) learned after rows are held | the held rows are masked again and reposted; an export after it is masked | none |
| SHORT_PASSWORD | a kept password of 1–3 characters | masked where a whole value, field or raw message equals it, and by substring in error text (bug 44's rule); a row that only contains its characters is shown as is | none |
| REFUSED | a password the cluster refused | masked in that attempt's own messages; not used to mask rows afterwards | none |
| OLDER_ERROR | Load older fails | the panel shows its own message; the cluster's text goes to the output channel only | none |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudLogs.ts` -- key prefix :20, `logAccessKey` :21; `readLogAccess` :47-65 (adds the password to `seenSecrets` :56; sets or deletes `logUsers` :35 and `logAccesses` :37); `removeLogAccess` :67-77 (the test seam: `writing++`, `ctx.removeStored`, both maps, `fire()`; never the panel); set up :166 (password into `seenSecrets` before the test read), write :184; `openLogs` :256-271 (no access → `show` of a noAccess source :262-265); `logSource` :290-312 (`current()` :294 falls back to the captured `target.access`; `noAccess`/`username` fixed :300-304; `reader()` sync, throws → connection kind :308; `mask` :312).
- `src/adapters/vscode/cloudView.ts` -- `SET_UP_LOG_ACCESS_COMMAND` :153, registered :644, `logAccess` :1292 (the pattern for a Forget command); row texts and context values :1154-1178; `seenSecrets` :499 (shared: client secret, deploy values, log passwords; never cleared), `sentSecrets` :501, `secrets()`/`mask` :671-678; storage handler :556-564 (another window: `readLogAccess` :561-562, `readAccount` :723-750); `resetData` :709-716; `connect` :789-863; `disconnect` :878-903; `options.logs` exposes only `show` :441.
- `package.json` -- Set up log access command :287-291, palette hidden :432-434, row menu :673-676 (`viewItem =~ /^cloudCluster( logs)?$/`); Forget's row menu matches `/^cloudCluster logs$/`.
- `src/adapters/vscode/logsPanel.ts` -- `show` / No log access :795; `setUpAccess` :1427-1466 (stopAll, swap source, reset, postShow, start — the pattern); `stopAll` :1482-1494 (private); `newReader` :972, Load older reader :1144; `failed` :1369-1391 (6.6's pattern: reason to the output channel, panel gets its own title); `olderError` :1203-1207 (reader text, prefix :105); rows shaped in `take` :1513 and `newestError` :1311; `noteOrgs` :1323-1330, :1500; `kept` :249 (`Kept` holds the row and ts :194); `postShow` :855; `exportShown` :711.
- `src/adapters/logs/records.ts` -- `maskOrgs` :55-63; `toLogRow` :69-110 (non-object values masked as raw text :82-84; objects through `maskDeep` :85-89). `src/adapters/logs/export.ts` :10-20 (takes the row's masking).
- `src/adapters/cloud/errors.ts` `maskCredentials` :130-141 (minLength 4, substring); bug 44's `sentSecrets` with minLength 1 on API error text only (`http.ts:79`) — the precedent for a value-specific rule.
- Tests: `src/test/integration/suites/97-logs.ts` setup :245-272, `setUpAccess` :175-179, NO_ACCESS :401, 6.6 suite :1396, SIGN_IN :1414 (password rotated via `topic.password` :1417), NOT_ALLOWED :1444, LOAD_OLDER failure :737-749 (asserts the reader text in `olderError` :742 — changes by design), WRITE_FAIL :2061, NO_LEAK :2124-2164; "another window" as in `96-cloud.ts:696-716` (an in-memory store with a `changed` emitter); `src/test/helpers/fakeLogs.ts` :59-97, sign-in check :165-172; unit `src/test/adapters/logs/records.test.ts` (:48, :78, NO_LEAK :94), `export.test.ts`, `src/test/adapters/cloud/errors.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `cloudLogs.ts`, `cloudView.ts`, `package.json` -- Forget log access (row menu on a cluster with access, palette with a pick); Disconnect, connect of another account and the account change from another window stop the panel and clear the in-memory accesses; the source reads the current access at each sign-in (none → No log access); log passwords kept in their own set, removed when refused.
- [x] `logsPanel.ts` -- a public way to stop and show No log access, or a stated reason, for a source; re-mask the held rows and repost when a new secret or org is learned; Load older's failure shows the panel's own message.
- [x] `records.ts`, `errors.ts` -- every value shape masked value by value; the short-password rule (whole-value match in rows, substring in error text).
- [x] tests per matrix row (unit and integration), the LOAD_OLDER failure assertion changed to the panel's message (Plan Change Log), NO_LEAK and WRITE_FAIL unchanged.
- [x] `README.md`, `CHANGELOG.md` -- Forget log access, Disconnect's effect on log access.

**Acceptance Criteria:**
- Given the change, when a matrix row's fix is removed, then its test fails.
- Given NO_LEAK, WRITE_FAIL and bug 44's MASK_SENT, when the suites run, then they pass unchanged.

## Implementation Notes

- Forget log access: `FORGET_LOG_ACCESS_COMMAND` (`redpandaConnect.cloud.forgetLogAccess`), `CloudLogs.forgetLogAccess`; the row menu on `cloudCluster logs` only (`1_actions@3`), the palette always (connected first, then a `pickCluster` of the clusters with access; `pickCluster` gained an optional placeholder). It shares `removeLogAccess` (the test seam), which now also stops an open tab on the cluster.
- The panel's public way: `LogsPanel.revoke(which, reason?)`. No reason: the source becomes a no-access copy (its `setUpAccess` kept) and the same range is reset into No log access. A reason: a new panel state `stopped` (`logsProtocol.ts`, label "Stopped", the reason as title, `STOPPED_BODY`, no button, no Load older row); the rows stay, nothing is read until another range (then No log access) or Show logs. `LogSource` gained `clusterId`, `hasAccess` (read in `newReader` and before Load older), `maskError` and `exact`.
- The account: `CloudView.accountGone` (Disconnect with an account, connect of another client ID, `readAccount` seeing the stored account change or go) clears `CloudLogs`' in-memory maps and revokes with `accountDisconnectedReason(name)` / `ACCOUNT_CHANGED_REASON`. `loadClusters` reads the log accesses only for the current generation (a stale load would refill the cleared maps).
- Another window: `readLogAccess` that finds no record where one was held revokes the tab at once (No log access); a replaced record replaces the map entry, which the source reads at the next sign-in (no fallback to the captured access any more).
- Passwords: `CloudLogs.kept` (own set, out of `seenSecrets`), in the view's `secrets()` (substring from 4), `exact` for rows (`maskWhole`, whole value / key / raw text), `maskError` for reader error text (substring from 1). A set-up attempt masks its own messages with its password (`attempt`); the password is kept on success, or on a failure that is not a refused sign-in. The set is never shrunk (Forget, Disconnect), so rows shaped again later stay masked.
- Re-mask: `Kept` holds its `LogRecord`; `noteOrgs` learning a new org, and `CloudLogs.keep` learning a new password (`remask`), shape the kept rows again and post `show`.
- `toLogRow`: a parsed JSON array or string is masked value by value and re-written only when something was masked (else the text as written); numbers and booleans holding a secret become the mask (in fields and the JSON).
- Test seams: `CloudView.forgetLogAccess`, `storeAsAnotherWindow(key, value|undefined)` (a secret-storage write this window did not make, so its change event is handled as another window's); `FakeLogs.signInMessage`.

## Plan Change Log

- LOAD_OLDER failure (`97-logs.ts`): its assertion of the reader's text in `olderError` is now the panel's message ("Could not load older records: logs-reader may not read the logs topic.", 6.6's state title) plus the reader's text in the output channel, as the plan said (OLDER_ERROR).
- REFUSED is applied to the set-up's test read only: a stored password the tab's sign-in is refused with (SIGN_IN) stays masked while it is held, since it is still a password the user typed; the matrix row names "that attempt's own messages".
- STALE_REMOVED: besides the sign-in check, another window's removal stops the tab at once (No log access), as Forget does here.
- Review fixes (2026-11-11): DISCONNECT's own test was wrong: it expected Live on in Stopped to go to No log access. In Stopped, Live, a range, a filter change and Show records around now do nothing (the webview disables Live and the range menu), so the test expects it to stay Stopped. Also: the level is masked before it is upper-cased; a log access read that fails keeps what is held; `loadClusters` checks the generation after the read too; another window's log access change is not taken in while disconnected; the short-password substring rule applies to the cluster's text only, not the composed message; `remask` applies the filter again (counts follow, nothing read); Forget on a cluster with no access says so and changes nothing; Disconnect's unreachable `else` (no account) was removed. Tests added for these, for a short password in a tail's and a Load older's error line, Forget when the store's delete throws, Forget on another cluster than the tab's, and Forget during the around-the-error search.

## Review Triage Log

Thorough review (2026-11-11; blind-hunter, edge-case-hunter, verification-gap, intent-alignment): 0 high, 5 medium and 9 low patched, 9 rejected, 1 deferred. The orchestrator checked rows 1–3 against the code.

| # | Finding | Lenses | Verdict | Evidence | Route |
|---|---------|--------|---------|----------|-------|
| 1 | `level` is masked after it is upper-cased: a lowercase password or `license_org` as a level shows unmasked | blind, edge | medium | `records.ts:136` | patch |
| 2 | An account change during `loadClusters`' `readLogAccess` await refills the cleared accesses | blind, edge | medium | the generation check precedes the await, `cloudView.ts:974-981` | patch |
| 3 | The `LOG_ACCESS_PREFIX` change handler refills in-memory access while disconnected | blind | medium | no account guard, `cloudView.ts:581-583` | patch |
| 4 | Stopped is lost on Live or a range change: rows cleared, No log access shown though the record is stored; the DISCONNECT test asserts it | blind | medium | `setLive` → `chooseRange`; the webview enables Live in Stopped | patch (the test corrected) |
| 5 | The 1–3 character substring rule runs over the whole composed message, garbling the cluster name and fixed words | blind | medium | `attempt`, `maskError` | patch (the cluster's reason text only) |
| 6 | A thrown `store.get` drops the held access and stops the tab | edge | low | `readLogAccess` else branch | patch |
| 7 | `remask` does not filter again or recount | blind, edge | low | `logsPanel.ts:920-928` | patch |
| 8 | Forget on a stale row says it removed access that was not there | blind, edge | low | `forgetLogAccess` node path | patch |
| 9 | `disconnect`'s `else { clear() }` branch looks unreachable and does not stop the tab | blind | low | `accountName` falls back to `clientId` | patch |
| 10 | No test for a short password in a tail, range or Load older reader error (`maskError`) | vgap, blind, intent | low | grep `maskError` in `src/test`: none | patch (tests) |
| 11 | No test: Forget during a pending around-the-error search, then Set up | vgap | low | FORGET/STALE/DISCONNECT start with `showLogs` | patch (test) |
| 12 | No test: Forget when the delete throws; Forget on cluster A with the tab on cluster B | blind | low | none found | patch (tests) |
| 13 | CHANGELOG lists the new command under "Fixed:" in one long line | blind | low | `CHANGELOG.md` | patch |
| 14 | A correct password refused for another reason (wrong mechanism or user) is not masked afterwards | blind | low | `keep` skipped on a refused sign-in | reject: the frozen REFUSED row asks for exactly this; the password stays masked in that attempt's messages |
| 15 | A stored password the cluster now refuses stays masked for the session | edge (claim) | low | `kept` is never shrunk | reject: masking more than needed, no leak (Plan Change Log, REFUSED) |
| 16 | Forgotten and disconnected passwords stay in the masking set (intent reading F2, not F1) | intent | low | the Implementation Notes say so | reject: safer; rows shaped later stay masked. Told to the user |
| 17 | "Another window" relies on the change event, not a storage read at each sign-in; tested with a same-window hook | intent, edge | low | `storeAsAnotherWindow` | reject: VS Code fires the event across windows; the plan's Code Map named this mechanism |
| 18 | A change event during this window's own write (`writing > 0`) is dropped | edge | low | the shared counter | defer (a per-key write set; rare, a window writing while another changes the same cluster) |
| 19 | Stored records outlive the account: Forget needs a connection and lists only the current account's clusters; records are keyed by cluster, so another account reuses them | blind | low | `forgetLogAccess` needs `connectedFirst` | reject: the user's decision (memory only on Disconnect); documented in the README |
| 20 | Forget has no confirmation and does not stop a running Set up | blind | low | no modal | reject: re-entering a password is the only cost; a Set up started after Forget is the user's choice |
| 21 | A numeric secret over 2^53 or not canonical is not matched; two keys masked to the same text collapse | blind, edge | low | `maskDeep` number branch, `Object.fromEntries` | reject: secrets as long JSON numbers, or two secret keys in one object, are not met in practice |
| 22 | Kept rows hold their raw `LogRecord`, about doubling memory at the 5,000 cap | blind | low | `Kept` | reject: bounded by the cap; needed to shape rows again |
| 23 | Load older's failure text has no matching action buttons | blind | low | `olderError` only | reject: the tab's own states keep their actions; Load older can be pressed again |
| 24 | Deploy values and the client secret added to `seenSecrets` do not trigger a remask | edge (claim) | low | `remask` on `keep` and `noteOrgs` only | reject: they are masked in rows read after; the tab's rows rarely hold Deploy values |

## Verification

**Commands:**
- `npm run compile` -- expected: 0, lint included.
- `npm run test:corpus`; `npm run test:webview` -- expected: pass.
- `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); then `--label multiroot` -- expected: all pass. No floor run.

**Result (2026-11-11, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 379, stable 1419 passing, 1 pending, 0 failing (the bug 52 tests, NO_LEAK, WRITE_FAIL and MASK_SENT among them), multi-root 11; the test settings clean; no floor run.

**Manual checks:**
- Dev host 1.143.1 on the user's cluster: Forget log access on the cluster with an open log panel (the panel shows No log access; Set up log access works again); Disconnect with the panel open (it stops and says so).

**Result (2026-11-11, implementation):** `npm run compile` 0 (lint included); `test:corpus` 182 passed; `test:webview` 379 passed; stable 1411 passing, 1 pending, 0 failing (NO_LEAK, WRITE_FAIL and MASK_SENT unchanged and passing; the 15 bug 52 tests pass); multiroot 11 passing. No floor run. Manual checks on the user's cluster: not run (the user's).

