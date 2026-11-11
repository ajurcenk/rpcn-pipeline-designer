---
id: 48
type: bug
title: "Deploy translation and Compare edge cases (epic 5 retrospective)"
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

# Deploy translation and Compare edge cases (epic 5 retrospective)

## Description

Deploy translates a config's variables into Cloud secret references before it sends it. The epic 5 retrospective found cases where the translation, or the actions around it, go wrong. A `${secrets.NAME}` written directly is sent unchecked, and the pipeline goes to Error on the cluster. Compare shows every variable as a change, though Deploy says nothing changed. A corrupt mapping hides the tagged pipeline, and palette Delete with a corrupt mapping says nothing. A nested reference is half translated, and `env(` in a comment refuses the deploy. When this is fixed, each case behaves as its criterion says and has a test.

## Reproduction

Each case reproduces from the dev host, or from the Cloud integration suite with the fake cloud.

1. **C5 `${secrets.NAME}` written directly.** Deploy a config that already uses `${secrets.TOKEN}`, with no TOKEN on the cluster. It is sent with no question, and the pipeline goes to Error there.
2. **C6 Compare.** Compare a config that uses `${VAR}` with its deployed pipeline, when Deploy says nothing changed. Every reference shows as a change.
3. **C10 Smaller cases:**
    - a corrupt mapping leads to "Deploy as new" with no offer of the tagged pipeline;
    - palette Delete with a corrupt mapping falls to the org-wide pick with no message;
    - in `${A:${B}}`, B is not translated;
    - `env(` in a YAML comment refuses the deploy.

## Cause Hypothesis

The translation (ticket 5.6) skips dotted names on purpose, so `secrets.NAME` passes through and no secret check sees it (C5). Compare (ticket 5.5) was designed before the translation and shows the raw local file (C6). The reference and `env(` scans read the text with a flat pattern, so they see neither nesting nor comments. The corrupt-mapping paths stop at the mapping and skip the tag lookup the missing-mapping path does.

## Acceptance Criteria

1. **Secret references written directly are checked**
   **Given** a config with `${secrets.TOKEN}` and no TOKEN on the cluster
   **When** it is deployed
   **Then** TOKEN is asked for as a missing secret is, with the same choices
   **And** a bad name after `secrets.` is refused with its line, and nothing is sent
2. **Compare compares what would be sent**
   **Given** a config with `${VAR}` that matches its deployed pipeline
   **When** Compare with local file runs
   **Then** it shows no change for the references, because it compares the translated text
   **And** the title says that the local side is translated
3. **A corrupt mapping still offers the tagged pipeline**
   **Given** a config whose mapping cannot be read, and a pipeline tagged with that config
   **When** the config is deployed
   **Then** the tagged pipeline is offered as it is when no mapping exists, and the message says the mapping could not be read
4. **Palette Delete names an unreadable mapping**
   **Given** the active config's mapping cannot be read
   **When** Delete is run from the palette
   **Then** a message says that the mapping could not be read, before any pick is shown
5. **Nested references are handled**
   **Given** a config with `${A:${B}}`
   **When** it is deployed
   **Then** B is translated as A is, or the reference is refused with its line and nothing is sent
6. **`env(` in a comment is ignored**
   **Given** a config with `env(` only in a YAML comment
   **When** it is deployed
   **Then** the deploy is not refused for it, and `env(` in a mapping is still refused with its line
7. **Tests cover the conditions found and fixed**
   **Given** the Cloud unit tests and the integration suite
   **When** they run
   **Then** a test that fails on the defect and passes on the fix covers each of criteria 1 to 6

## References

- parent — none
- source — _bmad-output/backlog/bug-deploy-flow-edge-cases-epic-5-retrospective.md, criteria 4, 5 and 9, Reproduction items 4, 5 and 9
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md, findings C5, C6 and C10
- prior — _bmad-output/backlog/bug-deploy-flow-edge-cases-epic-5-retrospective-plan.md, I/O & Edge-Case Matrix (the C10 cases already fixed)
- deferred work — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, entry "Bug 45 group C, translation and Compare"

## Notes

- Decision: bug 45 split; group C (translation and Compare) is this ticket (user, 2026-11-10). Made from the epic 5 retrospective's recommendations (user, 2026-11-11, "use your recommendations").
- Not in scope: two C10 cases bug 45 group A fixed: a failed create after secrets were created now names them, and Stopping or an unknown state no longer polls to the timeout.
- Code at 4fffc16: the translation and the `env(` scan are in `src/adapters/vscode/cloudTranslate.ts`; Compare in `src/adapters/vscode/cloudActions.ts`; the corrupt-mapping paths in `src/adapters/vscode/cloudDeploy.ts` (`mappedTarget`) and `src/adapters/vscode/cloudActions.ts` (`actionTarget`).
- Open question: ticket 5.5 chose an editable local right side for Compare. A translated right side may not be editable. Decide whether to keep an editable side (for example, a toggle or a second action) in the plan's checkpoint.
- Open question: whether `secrets.NAME` must follow the same name rule as the translated names. Check against the Cloud's secret name rule.
- Decision: no floor (VS Code 1.100.0) runs (user).
