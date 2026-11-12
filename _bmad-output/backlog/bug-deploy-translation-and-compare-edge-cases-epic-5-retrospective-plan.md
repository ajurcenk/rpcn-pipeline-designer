---
title: 'Deploy translation and Compare edge cases'
type: 'bugfix'
ticket: '48'
created: '2026-11-12'
status: 'built'
baseline_revision: '2f8472b31c65b2743582b73d0e5a7863fece8c59'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bug 48 (epic 5 retrospective C5, C6, C10). A config that already writes `${secrets.TOKEN}` is sent with no check: TOKEN is never asked for, a bad name is not refused, and the pipeline goes to Error. Compare shows every `${VAR}` as a change because it diffs the raw local file against the translated deployed config. A corrupt mapping skips the offer of the tagged pipeline; palette Delete with a corrupt mapping falls to the org-wide pick with no message. `${A:${B}}` leaves B untouched; `env(` in a YAML comment refuses the deploy.

**Approach:** `${secrets.NAME}` joins the missing-secret questions with the Cloud's name rule; Compare compares what would be sent; a corrupt mapping is said and the tagged pipeline still offered; nested references and `env(` follow the binary's rules.

**Decisions (user, 2026-11-12, the recommended options):** Compare's right side is the translated text, read-only; a nested reference `${A:${B}}` is refused with its line.

**Decision (user, 2026-11-11):** from the epic 5 retrospective's recommendations; the review runs the adversarial and edge-case lenses (epic 6 retrospective AI-6). The two C10 cases bug 45 group A fixed are out of scope.

**Facts that settle the ticket's second open question:** the name after `secrets.` is the secret id, which the Data Plane requires to match `^[A-Z][A-Z0-9_]*$` (the rule translated names already follow). The binary treats a default as literal text: `${A:${B}}` never expands `${B}` (tested on rpk connect 4.112.0). It ignores `env(` in a `#` comment.

## Boundaries & Constraints

**Always:** every refusal names its line and sends nothing; a secret value never appears in a message, log line or argv (bug 44's masking unchanged); the idempotence and corpus tests of the translation pass; bug 47's mapping lookup unchanged; every other Deploy and Compare behavior as today.

**Never:** a change to which `${NAME}` references are translated; a new dependency; a floor (1.100.0) run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SECRETS_REF | `${secrets.TOKEN}`, no TOKEN on the cluster | TOKEN is asked for with the same choices as a missing translated secret (a default makes it optional); created as chosen; the config sent as written | as today |
| SECRETS_PRESENT | `${secrets.TOKEN}`, TOKEN on the cluster | nothing asked; sent as today | none |
| SECRETS_BAD | `${secrets.my_x}`, `${secrets.A.B}` | refused with its line, as a bad translated name is; nothing sent | none |
| SAME_SECRET | `${TOKEN}` and `${secrets.TOKEN}` in one config | asked once | none |
| COMPARE | a config with `${VAR}` that matches its deployed pipeline | the right side is the text Deploy would send, read-only, titled as translated (as Deploy sends it): no change shown for the references; edit the file in its own editor | a refused translation is shown as Deploy shows it |
| BAD_MAPPING_DEPLOY | a mapping that cannot be read, and a pipeline tagged with the config | the message says the mapping could not be read; the tagged pipeline is offered as when no mapping exists | none |
| BAD_MAPPING_DELETE | palette Delete (and Start, Stop) with the active config's mapping unreadable | a message says the mapping could not be read, before any pick | none |
| NESTED | `${A:${B}}` | refused with its line (a nested reference is not read: a default is literal text); nothing sent | none |
| ENV_COMMENT | `env(` only in a `#` comment | not refused; `env(` in a mapping still refused with its line | none |

</frozen-after-approval>

## Code Map

- `src/core/envUsage.ts:15` -- `REFERENCE` (matches anywhere, comments included; the default part swallows one inner `${…}`, so `${A:${B}}` is one match named A).
- `src/core/cloudTranslate.ts` -- header :4-5; `SECRET_ID = /^[A-Z][A-Z0-9_]*$/` :16, applied :66-67; `CloudSecretUse = {name, required}` :26-30, listed by first use :69-75; the skip `if (name.includes('.')) continue;` :63-65 (strip `secrets.`, check `SECRET_ID`, push the use; other dotted names stay skipped); the rewrite :102 (dotted spans pass through as written); the `env(` scan `/(?<![.\w])env\(/g` :78-91 over the raw text (no comment awareness); nested :61-76.
- `src/adapters/vscode/cloudDeploy.ts` -- `savedAndTranslated` :411-420; `ensureSecrets` :528 (called :254; missing :546; choices keep-local / enter-another / use-default, or Add now); `showDiff` :96-108 and `sentConfigUri` :967-970 (the translated text under `.local.yaml`, title "(as sent)") — reuse for Compare; bad mapping :217-222 calls `newTarget(..., false)` (no tagged offer :686-716; the no-mapping path :216 passes `true`).
- `src/adapters/vscode/cloudShared.ts` -- `findMapping` :91-129 (`{kind:'own', read:{kind:'bad', reason}}`); `deployedConfigUri` :37.
- `src/adapters/vscode/cloudActions.ts` -- Compare :565-581 (left `deployedConfigUri`, right `Uri.file(file)` editable, title :578); `actionTarget` :100-104 (no `pickAfterGone`); `paletteTarget`'s bad-mapping branch :161 guarded by `pickAfterGone`, so Delete, Start and Stop fall silently to the org-wide pick :190-213; `cloudLogs.ts:482` (Show logs, says it).
- `src/adapters/vscode/cloudView.ts:677` -- the content provider serving `ctx.deployedConfigs`.
- `src/adapters/cloud/dataPlane.ts:302` `createSecret` (no check); `src/test/helpers/fakeCloud.ts:367` checks the id rule.
- Tests: unit `src/test/core/cloudTranslate.test.ts` (DEFAULT :23-27 pins the nested output; UNTOUCHED :37 asserts `${secrets.X}` is not listed; ENV_CALL :54, :66; idempotence :79 and corpus :88 keep passing); integration `src/test/integration/suites/96-cloud.ts` (ACCEPTANCE 5.6 :1044, BAD_NAME/ENV_CALL :1058, UNCHANGED 5.6 :1120, DIFF 5.6 :1130, ACCEPTANCE 5.7 :1187, ALL_PRESENT :1220, ADD_MANUAL :1279, BAD_SIDECAR :907 with TAGGED :927 as the model, PALETTE :1715, PALETTE delete :1755, COMPARE :1897 — asserts an editable file right side and `notStrictEqual(..., VARS_SENT)`, changes with COMPARE).

## Tasks & Acceptance

**Execution:**
- [ ] `cloudTranslate.ts` -- SECRETS_REF / SECRETS_BAD / SAME_SECRET in the secret uses; NESTED; ENV_COMMENT.
- [ ] `cloudDeploy.ts`, `cloudActions.ts` -- BAD_MAPPING_DEPLOY (the message and the tagged offer), BAD_MAPPING_DELETE (the message before the pick); COMPARE (the translated, read-only right side).
- [ ] tests per matrix row (unit and integration); the existing assertions that pin the defects (UNTOUCHED, DEFAULT, COMPARE, BAD_SIDECAR) changed, recorded in the Plan Change Log.
- [ ] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when a matrix row's fix is removed, then its test fails.
- Given the translation's idempotence and corpus tests and the 5.7 secrets tests, when the suites run, then they pass.

## Implementation Notes

- `cloudTranslate.ts`: a `${secrets.NAME}` strips the prefix (`CLOUD_SECRET_PREFIX`, `isCloudSecretName` from `envUsage.ts`), checks `SECRET_ID` on NAME (refused as `secrets.my_x (line N): …`), and merges into the secret uses by NAME, so `${TOKEN}` and `${secrets.TOKEN}` are one use (required if either has no default). Other dotted names stay skipped; the rewrite is unchanged. NESTED: a default holding a `${…}` other than `${!…}` (a Bloblang interpolation in a default is literal text that Bloblang still runs, so it stays allowed) is refused for any name. ENV_COMMENT: `inComment` scans the `env(` line for a `#` at the line start or after whitespace outside a double-quoted string (YAML's and a mapping's comments both); a `"` in a single-quoted scalar can hide a comment, and then `env(` is refused as before (conservative).
- `cloudShared.ts`: `sentConfigUri` moved here (re-exported from `cloudDeploy.ts`, as `cloudView.ts` exports it) and `refusedText` (Deploy's refusal text) shared with Compare.
- `cloudDeploy.ts`: the bad-mapping message now says "could not be read as a deploy mapping"; its action is **Deploy without it** (`DEPLOY_WITHOUT_ACTION`, bug 47's) and calls `newTarget(..., true)`. `DEPLOY_AS_NEW_ACTION` ("Deploy as new") is removed: it promised a new pipeline, while the tagged offer can now lead to an update.
- `cloudActions.ts`: `paletteTarget`'s bad-mapping branch no longer needs `pickAfterGone`, so Delete, Start and Stop say "<mapping> could not be read: <reason>." before the pick (Show logs unchanged). Compare translates the file first (an unsaved editor's text when the file is dirty, as Deploy would save it; else the file on disk): refused → Deploy's text plus "Nothing was compared.", nothing requested, `notStarted`; else the right side is `sentConfigUri` with the translated text, title "<name> (deployed) ↔ <file> (as sent)".
- Review fixes (2026-11-12): ENV_COMMENT no longer uses a per-line heuristic. An `env(` passes only inside a YAML comment token (the `yaml` CST) or a Bloblang `#` comment of a Bloblang field or `${! }` region. The region is scanned from its start with `bloblang.ts`'s string state (`"…"`, `"""…"""` across lines; the new `endsInBloblangComment`). A scalar that folds its lines (all but `|`) must be a comment with and without its line breaks; `Region` gained `literalBlock`. A text with YAML errors refuses every `env(` as before. Dotted non-`secrets.` names are skipped before NESTED. A reference reports all its problems (nested and bad name). A bad written name now says `A.B, the secret name, must match …`. Compare has its own right-side URI (`compareConfigUri`, `.compare.yaml`), finds the dirty document by `Uri.toString()`, and logs a read failure; its log says whether unsaved edits were used. One wording for an unreadable mapping everywhere: "<mapping> could not be read as a deploy mapping: <reason>.". The local-value test found a real gap: the Environment view's `localValues` offered only the names the config's `envUsage` lists, and a written `${secrets.X}` is not one of them. It now takes the missing secrets' names (`localValues(uri, names)`; Deploy passes them), so a written `${secrets.X}` is offered a local `X` as `${X}` is.

## Plan Change Log

- UNTOUCHED (`cloudTranslate.test.ts`): still asserts `${secrets.X}` is sent as written; its secrets list stays `[X]` (now from the written `${secrets.X}` and `$${X}` both), message added.
- DEFAULT: the nested `${HOST:${HOST}}` case is now NESTED's refusal; DEFAULT keeps a `${!…}` in a default instead. New NESTED, SECRETS_REF, SAME_SECRET, SECRETS_BAD, ENV_COMMENT unit tests.
- ENV_CALL (second test): its `# c: env("Y")` line was the defect (ENV_COMMENT); removed there, covered by ENV_COMMENT.
- idempotent: `twice.secrets` was asserted `[]` (the written `${secrets.…}` were not uses); now asserted equal to `once.secrets` (`A`, `B`, `C`). Text idempotence unchanged; the corpus test unchanged and passing (`eval.yaml`'s `${MQTT_BROKER_HOST:${MQTT_BROKER_HOST}}` is now refused, which that test allows).
- BAD_SIDECAR (`96-cloud.ts`): the message "is not a deploy mapping … as a new pipeline?" and `DEPLOY_AS_NEW_ACTION` became "could not be read as a deploy mapping … without it?" and `DEPLOY_WITHOUT_ACTION`; new BAD_MAPPING_DEPLOY 48 (the tagged offer after it) and BAD_MAPPING_DELETE 48 (Delete, Start, Stop: said before the pick).
- OLD_MAPPING_GONE 47: the same message and action change; it now also asserts the tagged offer (its script already answered it).
- COMPARE: asserted an editable `file` right side and `notStrictEqual(..., VARS_SENT)`; now COMPARE 48: a read-only `redpanda-cloud:` right side equal to `VARS_SENT`, the "(as sent)" title, unsaved edits compared, a refused translation said. Multi-root `cloud.ts` (MULTI_ROOT, OLD_TAG_TWO, OLD_TAG_ONE) checked the right side's `fsPath`; it now marks each file with its own last line and checks the right side's text.
- New integration tests: SECRETS_REF / SAME_SECRET / SECRETS_PRESENT 48, SECRETS_BAD / NESTED 48, ENV_COMMENT 48.
- Review fixes, changed assertions:
  - SECRETS_BAD, unit and integration: the written-name messages are now `secrets.my_x (line N): my_x, the secret name, must match …`, and for an empty name `…the secret name after secrets. is empty; it must match …`.
  - ENV_COMMENT, unit: `root.b = a#env("B")` in a mapping is now a Bloblang comment (allowed), so the refused case is `url: a#env("B")` outside any Bloblang field. A new unit test covers a `#` in a single-quoted flow and block scalar, a multi-line double-quoted scalar, a `"""…"""` string, YAML and Bloblang comments, and a text with YAML errors.
  - NESTED, unit, new: deeper nesting (`${A:${B:${C}}` is the span matched), `${my_x:${B}}` with both problems, and `${a.b:${C}}` sent as written.
  - BAD_MAPPING_DELETE 48 (`96-cloud.ts`), DEPLOY_AGAIN (`96-cloud.ts`, was `is not a deploy mapping (it is not JSON`) and the bad-mapping Show logs test (`97-logs.ts`, was `could not be read: it is not JSON`) now expect "could not be read as a deploy mapping: …".
  - New integration tests: SECRETS_REF 48 with a local value (`${secrets.BROKER}` offered the stored BROKER) and COMPARE_APART 48 (a Compare leaves a Deploy diff's right side unchanged). COMPARE 48 gained the unreadable-file case (POSIX, skipped as root).

## Review Triage Log

Thorough review (2026-11-12; blind-hunter, edge-case-hunter, verification-gap, intent-alignment): 0 high, 3 medium and 13 low patched, 4 rejected.

| # | Finding | Lenses | Verdict | Route |
|---|---------|--------|---------|-------|
| 1 | `inComment` tracks double quotes per line only: a `#` in a single-quoted flow scalar or on a continuation line of a multi-line string, then a real `env(`, is let through and errors on the cluster | blind, edge ×2, intent | medium | patch (YAML comments by the `yaml` CST; Bloblang scalars scanned with string state across lines; refuse when unsure) |
| 2 | Compare and Deploy's restart diff share `sentConfigUri`: Compare overwrites the text Deploy asks to confirm | blind, edge | medium | patch (Compare's own URI) |
| 3 | Deploy again still says "is not a deploy mapping"; its test pins it | vgap | medium | patch (one wording everywhere) |
| 4 | `${a.b:${C}}`, a dotted name sent as written, is refused | blind, edge, intent | low | patch |
| 5 | `${my_x:${B}}` reports one of its two problems | blind, edge | low | patch |
| 6 | The bad written-secret message reads as if `secrets.` is the problem | blind | low | patch |
| 7 | Deeper nesting untested | intent | low | patch (test) |
| 8 | The dirty-document lookup by `path.resolve` misses case-only differences | blind, edge | low | patch (`Uri.toString()`) |
| 9 | Compare's read error is not logged and untested | blind | low | patch |
| 10 | The unreadable-mapping wording differs between surfaces | blind | low | patch |
| 11 | CHANGELOG: bug 47's entry names the removed "Deploy as new"; the new entry lacks the prefix and packs five changes | vgap, blind | low | patch |
| 12 | README "Missing secrets" paragraph stale for a written `${secrets.NAME}` | blind | low | patch |
| 13 | A written `${secrets.X}` is offered the local `X`: untested and undocumented | blind | low | patch (test, README) |
| 14 | Compare's right side is a snapshot; nothing says so | blind | low | patch (README) |
| 15 | Compare uses the unsaved text, while Deploy saves first (format-on-save may differ) | edge (claim) | low | patch (README says unsaved edits are used); the save is not run by Compare |
| 16 | A `${secrets.X}` in a comment triggers a secret question | intent | low | reject: the same as `${NAME}` (comments included, the translation's rule) |
| 17 | Palette Delete with a corrupt mapping keeps the org-wide pick instead of offering the tagged pipeline | intent | low | reject: the frozen BAD_MAPPING_DELETE row asks for the message before the pick |
| 18 | The fake does not show the pipeline avoiding Error for `${secrets.TOKEN}` | intent | low | reject: the fake models no lint; the secret now exists before the create |
| 19 | The new idempotence assertion lists secrets on a second pass | blind | low | reject: intended (a written `${secrets.X}` is a use); text idempotence unchanged |

## Verification

**Commands:**
- `npm run compile` -- expected: 0, lint included.
- `npm run test:corpus`; `npm run test:webview` -- expected: pass.
- `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); then `--label multiroot` -- expected: all pass. No floor run.

**Results (2026-11-12, implementation):** `npm run compile` 0 (lint included); `test:corpus` 182 passed; `test:webview` 381 passed; stable (VS Code 1.146.0 from `.vscode-test`) 1469 passing, 1 pending, 0 failing; multiroot 14 passing. No floor run. Manual checks not run yet; the review (adversarial and edge-case lenses) not run yet.

**Result (2026-11-12, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 381, stable 1473 passing, 1 pending, 0 failing, multi-root 14 passing; the test settings clean; `test/multiroot` clean; no floor run.

**Manual checks:**
- Dev host 1.143.1 on the user's cluster: Compare with local file on a deployed config that uses `${VAR}` shows no change for the references; a config with `${secrets.NEW_X}` asks for NEW_X on Deploy.

