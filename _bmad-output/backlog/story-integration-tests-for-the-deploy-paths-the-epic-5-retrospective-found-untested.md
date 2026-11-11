---
id: 49
type: story
title: "Integration tests for the Deploy paths the epic 5 retrospective found untested"
parent: none
covers: []
after: [47, 48]
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Integration tests for the Deploy paths the epic 5 retrospective found untested

## Description

The epic 5 retrospective found Deploy paths that no test runs, so a break in them would go unseen. When this is done, the integration suite runs each one: Deploy again from a row through the whole flow, delete from a row with no config open, a mapping write that fails, the real pre-deploy check, and one variable set in two local sources. The product's behavior does not change.

## Acceptance Criteria

1. **Deploy again from a row runs the whole flow**
   **Given** a deployed config that uses a variable, needs a missing secret and has a check finding
   **When** Deploy again is run from its row in the Cloud view
   **Then** the test sees the translation, the missing-secret question and the check finding, as for a Deploy from the editor
2. **Delete from a row finds the mapping by its tag**
   **Given** a workspace folder holding a deployed config and its mapping, with no config open
   **When** the pipeline is deleted from its row
   **Then** the test sees the mapping found through the pipeline's tag and removed with the pipeline
3. **A mapping write that fails is reported**
   **Given** a deploy whose mapping write fails
   **When** the deploy ends
   **Then** the test sees the message about the mapping, and the pipeline was still created
4. **The mapping after a timeout**
   **Given** a deploy whose follow times out
   **When** the deploy ends
   **Then** the test checks what the mapping holds, as the flow intends today
5. **The pre-deploy check uses the real lint and version wiring**
   **Given** the extension's real lint and version wiring, not the test's replacement
   **When** one test deploys a config with a lint finding
   **Then** the check shows that finding, so a break in the wiring fails the test
6. **One name in two local sources**
   **Given** a missing secret whose name is set in two local sources
   **When** Deploy offers to keep a local value
   **Then** the value offered is the one Redpanda Connect would use, and its source is named
7. **Each test guards its path**
   **Given** each new test
   **When** the path it covers is broken on purpose during the build
   **Then** the test fails, and it passes again once the break is undone

## Boundaries

- Must not change: any product behavior or message; the existing tests' assertions; secret values staying out of logs and messages (bug 44).

## References

- parent — none
- source — _bmad-output/backlog/bug-deploy-flow-edge-cases-epic-5-retrospective.md, criterion 10
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md, Verification gaps V1, V2, V3, V5 and V6
- deferred work — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, entry "Bug 45 group D, the tests"

## Notes

- Decision: bug 45 split; group D (tests) is this ticket (user, 2026-11-10). Made from the epic 5 retrospective's recommendations (user, 2026-11-11, "use your recommendations").
- After 47 and 48: the tests are cleaner once those settle the behavior they cover (the tag and mapping names, the translation and Compare). Written before them, the tests would be rewritten.
- Code at 4fffc16: the tests go in `src/test/integration/suites/96-cloud.ts` with `src/test/helpers/fakeCloud.ts`; the real check wiring is in `src/extension.ts`; the two-source value in `src/adapters/vscode/environmentView.ts`.
- Assumption: criterion 2 needs a workspace folder, so it runs in the multi-root run, or the stable run opens a folder for it.
- Decision: no floor (VS Code 1.100.0) runs (user).
