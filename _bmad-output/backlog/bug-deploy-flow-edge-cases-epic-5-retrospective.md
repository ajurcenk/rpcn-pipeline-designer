---
id: 45
type: bug
title: "Deploy flow edge cases (epic 5 retrospective)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
severity: P2
estimate: ""
---

# Deploy flow edge cases (epic 5 retrospective)

## Description

The epic 5 retrospective found cases where Deploy to Redpanda Cloud and the Cloud view's actions go wrong, most where two of epic 5's stories meet, and tests that would not catch a regression in the paths involved. The clean deploy, update, start, stop and delete work as tested. The cases are a second Deploy of a file while one runs, the file tag carrying a local path, messages that do not name the secrets created, `${secrets.NAME}` written directly, Compare showing every reference as a change, two files sharing one mapping, a pipeline changed elsewhere while Deploy waits, and the Error and Stopping states. When this bug is fixed, each case behaves as its criterion says and has a test. The secret masking found with them is bug 44.

## Reproduction

Each case reproduces from the dev host or from `src/test/integration/suites/96-cloud.ts` with the fake cloud. Paths are at ce1b557.

1. **C1 Double deploy.** Deploy a file with no mapping twice before the first finishes (title button twice, or the editor's Deploy plus the row's Deploy again). Two pipelines are created, and `.cloud.json` names only one (`cloudDeploy.ts:105-114`).
2. **C3 The file tag.** Deploy a file outside every workspace folder: its absolute local path is sent as the pipeline's tag. In a multi-root workspace, `a/orders.yaml` and `b/orders.yaml` get the same tag (`cloudDeploy.ts:160`, `cloudView.ts:1198-1211`).
3. **C4 "nothing was sent".** Deploy a config that is unchanged on the cluster but has a missing secret, and create the secret. The log then says "nothing was sent" (`cloudDeploy.ts:203`, `:224-229`).
4. **C5 `${secrets.NAME}` written directly.** A config that already uses `${secrets.TOKEN}`, with no TOKEN on the cluster, is sent with no question and goes to Error there (`cloudTranslate.ts:63-65`).
5. **C6 Compare.** Compare a config that uses `${VAR}` with its deployed pipeline: every reference shows as a change, though Deploy says nothing changed (`cloudActions.ts:541-557`).
6. **C7 One mapping for two files.** Put `orders.yaml` and `orders.yml` in one folder. Both use `orders.cloud.json` (`sidecar.ts:17-23`).
7. **C8 Stale target.** Start Deploy of a mapped, stopped pipeline, and start the pipeline from the Cloud view while Deploy waits at the size pick. The update then restarts it with no confirmation and sends the old description and tags (`cloudDeploy.ts:179`, `:222-257`).
8. **C9 Old error (PLAUSIBLE).** Deploy a fixed config to a pipeline in Error. The old error may be reported against the new config if the PUT answer still says Error (`cloudDeploy.ts:646`, `follow`). Check this on the real cluster first.
9. **C10 Smaller cases:**
    - a corrupt `.cloud.json` leads to "Deploy as new" with no offer of the tagged pipeline (`cloudDeploy.ts:173-177`);
    - palette Delete with a corrupt mapping falls to the org-wide pick with no message (`cloudActions.ts:139-160`);
    - in `${A:${B}}`, B is not translated (`cloudTranslate.ts:61-76`);
    - `env(` in a YAML comment refuses the deploy (`cloudTranslate.ts:78-91`);
    - a failed create after secrets were created does not name them (`cloudDeploy.ts:711-727`);
    - a pipeline in Stopping, or in a state the extension does not know, is polled until the timeout (`dataPlane.ts:59,103`).

## Cause Hypothesis

Each story checked its own path with clean inputs. Deploy keeps no state per file (C1, C8). The tag and mapping names come from the path alone (C3, C7). The unchanged shortcut (5.3) was written before secrets were created (5.7), giving C4. The translation (5.6) skips dotted names on purpose (C5) and came after Compare's design (5.5), giving C6.

## Acceptance Criteria

1. **One deploy per file at a time**
   **Given** a deploy of a file waiting at a prompt
   **When** a second Deploy of the same file is asked for
   **Then** it is refused with a message, nothing more is sent, and the first deploy goes on
2. **The tag names the file without local paths**
   **Given** a multi-root workspace, and a file outside every folder
   **When** each is deployed
   **Then** the tag includes the workspace folder name, and a file outside every folder sends no absolute path (its base name, or Deploy refuses with the reason)
   **And** the row's file, Compare and Deploy again resolve the tag to that folder only
3. **The messages say what was sent**
   **Given** an unchanged config with a missing secret that is created, or a create that fails after secrets were created
   **When** the deploy ends
   **Then** the log and the message name the secrets created, and never say "nothing was sent" after a secret was sent
4. **Secret references written directly are checked**
   **Given** a config with `${secrets.TOKEN}` and no TOKEN on the cluster
   **When** it is deployed
   **Then** TOKEN is asked for as a missing secret is, and a bad name after `secrets.` is refused with its line
5. **Compare compares what would be sent**
   **Given** a config with `${VAR}` that matches its deployed pipeline
   **When** Compare with local file runs
   **Then** it shows no change for the references (it compares the translated text), and the title says so
6. **One mapping per file**
   **Given** `orders.yaml` and `orders.yml` in one folder
   **When** each is deployed
   **Then** each keeps its own pipeline. Either the mapping names the file, or a mapping found for another file is not used, with a message
7. **The target is read again before sending**
   **Given** a deploy that waits at a prompt while the pipeline is started, stopped or retagged elsewhere
   **When** the update is sent
   **Then** the pipeline is read again just before. A pipeline now running asks for confirmation, and the current description and tags are kept
   **And** a change of service account during the prompts stops the deploy with a message
8. **Error, Stopping and unknown states**
   **Given** a deploy to a pipeline in Error, or a pipeline in Stopping or an unknown state
   **When** the update is followed
   **Then** the result is the new config's state, not the old error, and an unknown state ends the follow with its name instead of waiting until the timeout
9. **The smaller cases**
    **Given** each case in Reproduction item 9
    **When** it runs
    **Then**:
    - a corrupt mapping still offers the tagged pipeline;
    - palette Delete says that the mapping could not be read;
    - nested references are translated or refused with their line;
    - `env(` in a comment does not refuse the deploy.
10. **The tests the retrospective found missing**
    **Given** the integration suite
    **When** it runs
    **Then** it covers:
    - Deploy again from a row with variables, a missing secret and a check finding (V1);
    - delete from a row with no config open, finding the mapping by its tag in a workspace folder (V2);
    - a mapping write that fails, and the mapping after a timeout (V3);
    - the real lint and version wiring of the pre-deploy check, run once (V5);
    - one name set in two local sources, offering the value Redpanda Connect would use (V6).

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md, findings C1, C3–C10, V1–V3, V5 and V6, action item AI-1
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-create-the-missing-cloud-secrets-plan.md (5.7, the masking and the secrets questions)
- prior — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-refactor-sweep-plan.md (5.9, the module layout)
- related — _bmad-output/backlog/bug-deploy-masks-only-the-secret-values-it-sends-epic-5-retrospective.md (bug 44, the masking)

## Notes

- Decision: split from bug 44 (the masking), which is built first (user, 2026-11-09).
- Accepted, not in scope: secrets created before a declined Replace and restart stay, with a message (5.7's decision and its DECLINED_RESTART test). Mapping files are written with plain file calls (retrospective C11, C12).
- Open question: the size. Ten criteria in four groups (deploy robustness 1, 3, 7, 8; names 2, 6; translation and Compare 4, 5, 9; tests 10) may be more than one build; the plan may split again, with the user's yes.
- Open question: C9 depends on the Data Plane's answer to a PUT for a pipeline in Error. Check it on the real cluster before changing `follow`.
- Assumption: in criterion 2, the base name is used for a file outside every folder, unless the plan's checkpoint picks refusal.
- Decision: no floor (VS Code 1.100.0) runs (user).
