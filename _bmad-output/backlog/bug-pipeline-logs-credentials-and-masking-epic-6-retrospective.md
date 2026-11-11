---
id: 52
type: bug
title: "Pipeline logs credentials and masking (epic 6 retrospective)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
severity: P2
estimate: ""
---

# Pipeline logs credentials and masking (epic 6 retrospective)

## Description

The epic 6 retrospective found gaps in how the Pipeline Logs panel keeps log access and masks secrets. The user cannot remove a stored log access, and Disconnect leaves it stored and the panel reading. An open panel keeps signing in with an access another window removed or replaced. Some secrets are shown unmasked: in a record whose value is a JSON array or string, a short password, and a license value in rows shaped before it was seen. A refused password garbles rows for the rest of the session, and Load older shows the cluster's error text in the panel. When this bug is fixed, each case behaves as its criterion says and has a test.

## Reproduction

Each case reproduces from the dev host with a log-access user, or from the logs integration suite with the fake reader. Line numbers are the retrospective's, at c783a4a.

1. **A8 No Forget, and Disconnect leaves the panel.** Set up log access for a cluster. No command removes it; `removeLogAccess` is a test seam only (`src/adapters/vscode/cloudLogs.ts:66-67`). Open a pipeline's log and Disconnect. The stored access stays in secret storage, and the panel goes on reading (`src/adapters/vscode/cloudView.ts:878-903`).
2. **C16 A value that is not an object.** Show a record whose value is a JSON array or string holding a secret with a `"` or `\` in it. The value is masked as raw text, where the secret is escaped, so the mask misses it (`src/adapters/logs/records.ts:82-84`: `!isObject(value)` → `shown(record.value)`).
3. **C17 Short and refused passwords.** Set up log access with a password of 3 characters: it is never masked. Type a common short password that the cluster refuses: it is masked by substring for the rest of the session, so rows everywhere are garbled (`cloudLogs.ts:166`; `src/adapters/cloud/errors.ts:131-136`).
4. **C18 A change in another window.** Open a pipeline's log in one window. In a second window, remove or replace the cluster's log access. The open panel keeps signing in with the old credential (`cloudLogs.ts:294`; `cloudView.ts:561`).
5. **C19 Load older shows the error text.** Let Load older fail. The reader's error text is shown in the panel, though 6.6 says the cluster's error text goes to the output channel only (`src/adapters/vscode/logsPanel.ts:1203-1207`).
6. **C20 `license_org` in earlier rows.** Show rows before a `license_org` value is first seen, then a row that carries it. Only rows shaped after it was seen are masked; the earlier rows keep it (`logsPanel.ts:1501-1503`; `records.ts:69-73`).

## Cause Hypothesis

Log access was built as set-up only: removal exists as a test seam, and the panel does not listen to the Cloud view's session or to secret storage changes (A8, C18). Masking works on the parsed object and falls back to the raw text for any other shape, where escaping changes the secret's bytes (C16). The session's password list takes every typed password and skips short ones by a length rule (C17). Masking is applied when a row is shaped, so a value learned later does not reach rows shaped before (C20). Load older has its own error path that skipped 6.6's rule (C19).

## Acceptance Criteria

1. **Log access can be forgotten per cluster**
   **Given** stored log access for one or more clusters
   **When** the user runs Forget log access and picks a cluster
   **Then** that cluster's stored access is removed from secret storage, the others stay, and an open panel on that cluster stops reading and offers Set up log access
2. **Disconnect and an account change end the session's log access**
   **Given** an open Pipeline Logs panel and log access held in memory
   **When** the user disconnects, or the Cloud account changes
   **Then** the panel stops reading and says why, and no access held in memory is used again
3. **The panel uses the stored access as it is now**
   **Given** an open panel, and a log access removed or replaced in another window
   **When** the panel next signs in
   **Then** it uses the current stored access, or offers Set up log access when there is none, and never the old credential
4. **Every secret is masked whatever the record's shape**
   **Given** a record whose value is a JSON object, array or string, or plain text, and a secret seen in any row, before or after
   **When** the row is shown or exported
   **Then** the secret is masked in its raw and escaped forms, in every row the panel holds
5. **Passwords are masked by length and only while they are kept**
   **Given** a log-access password of any length, and a password the cluster refused
   **When** rows, the output channel or an export are written
   **Then** a kept password never appears, whatever its length, and a refused password is not used to mask rows after it is refused
6. **The cluster's error text goes to the output channel only**
   **Given** any read that fails, Load older included
   **When** the panel shows the failure
   **Then** it shows the panel's own message, and the cluster's error text is written to the output channel only
7. **Tests cover the conditions found and fixed**
   **Given** the logs unit tests and the integration suite
   **When** they run
   **Then** a test that fails on the defect and passes on the fix covers each of criteria 1 to 6, and NO_LEAK still passes unchanged
8. **Or: no change is needed, with proof**
   **Given** a case's reproduction
   **When** it is run on the current code
   **Then** the expected behavior already holds, or the finding was mistaken, with the evidence recorded in Notes — this supersedes that case's part of criteria 1 to 7

## Boundaries

- Must not change: the stored-password handling NO_LEAK checks (every secret storage key, files, output, prompts, view items, settings and the panel); export masking as WRITE_FAIL checks it; bug 44's masking of the values Deploy sends.
- Not in scope: the reading and state cases (bug 51).

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs-retrospective.md, finding A8 (Aggregate views), findings C16–C20 (Diff review: credentials and masking), action item AI-2
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-tracer-set-up-log-access-and-show-a-pipeline-s-live-log-plan.md (6.2, log access and its notes)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-the-log-panel-s-empty-and-error-states-plan.md (6.6, error text to the output channel)
- related — _bmad-output/backlog/bug-deploy-masks-only-the-secret-values-it-sends-epic-5-retrospective.md (bug 44)
- related — _bmad-output/backlog/bug-pipeline-logs-reading-and-state-edge-cases-epic-6-retrospective.md (bug 51)

## Notes

- Decision: made from the epic 6 retrospective's AI-2 (user, 2026-11-11, "use your recommendations").
- Decision: Forget log access is a command per cluster, and Disconnect or an account change stops the panel and clears the accesses held in memory (user, 2026-11-11).
- Code at c783a4a: log access is in `src/adapters/vscode/cloudLogs.ts`; Disconnect in `src/adapters/vscode/cloudView.ts`; masking in `src/adapters/logs/records.ts` and `src/adapters/cloud/errors.ts`; NO_LEAK and WRITE_FAIL in `src/test/integration/suites/97-logs.ts:2061-2164`.
- Open question: whether Disconnect also removes the stored access, or only the accesses held in memory. AI-2 names the memory only; the plan's checkpoint decides.
- Open question: how a short password is masked without garbling rows that merely contain its characters (for example, by whole value or field). The plan decides.
- Decision: no floor (VS Code 1.100.0) runs (user).
