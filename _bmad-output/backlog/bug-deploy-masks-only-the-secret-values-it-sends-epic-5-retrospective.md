---
id: 44
type: bug
title: "Deploy masks only the secret values it sends (epic 5 retrospective)"
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

# Deploy masks only the secret values it sends (epic 5 retrospective)

## Description

Deploy to Redpanda Cloud hides secret values in its messages, log lines and results, but the masking hides too much and too little. When a secret is missing on the cluster, the local value of *every* missing secret is masked for the rest of the session, even one the user then decides not to create, so a common value such as `true` or `kafka` turns into `•••••` in pipeline names, cluster names and messages. A value under 4 characters is never masked, so a short secret echoed by an API error would show in the output channel and a message, against the rule that secret values never appear there. No test exercises the masking: removing it would fail nothing. When this bug is fixed, only the values actually sent are masked, short ones included, and a test proves an echoed value never shows. Found by the epic 5 retrospective (C2, V4); the other cases it found are bug 45.

## Reproduction

It reproduces from the dev host or from `src/test/integration/suites/96-cloud.ts` with the fake cloud. Paths are at ce1b557.

1. **C2 Masking.** A config uses `${A}` and `${B}`, both missing on the cluster, with local values `kafka` (A) and `xy` (B). The user keeps A's value and answers "Don't create it" for B. After that:
   - every later message, log line or tree label that contains `kafka` (a topic or pipeline name, for example) shows `•••••`, for the rest of the session (`cloudDeploy.ts:409-414`, `cloudView.ts:663-669`);
   - a value of 1 to 3 characters that the user kept or typed is never masked (`errors.ts:133`).

## Cause Hypothesis

Story 5.7 masks every local value of a missing secret up front, before the user's choice, to be safe, and `maskCredentials` keeps the minimum length of 4 that story 5.2 chose for the client secret and tokens, where masking a short value would hide ordinary text. The 5.7 tests check that values are absent where none could appear, so the masking itself never runs in a test.

## Acceptance Criteria

1. **Only sent values are masked, short ones too**
   **Given** two missing secrets with local values, one kept and one not created
   **When** the deploy runs and a later message contains the value that was not created
   **Then** that message shows the value as it is, and the kept value is masked in every message, log line and result, whatever its length (base64 included)
   **And** a fake secret-create error that echoes the sent value shows it masked in the error and the output channel (V4)

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md, findings C2 and V4, action item AI-1
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-create-the-missing-cloud-secrets-plan.md (5.7, the masking and the secrets questions)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-refactor-sweep-plan.md (5.9, the module layout)
- related — _bmad-output/backlog/bug-deploy-flow-edge-cases-epic-5-retrospective.md (bug 45, the other cases)

## Notes

- Decision: build this bug next (user, 2026-11-09); split from the retrospective's deploy-flow findings, the rest in bug 45 (user, 2026-11-09).
- Open question: how a short value is masked without hiding ordinary text (for example only in text that comes from the Cloud API, such as an error body, or by field rather than by value). The plan settles it.
- Decision: no floor (VS Code 1.100.0) runs (user).
