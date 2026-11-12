---
title: 'Integration tests for the Deploy paths the epic 5 retrospective found untested'
type: 'chore'
ticket: '49'
created: '2026-11-12'
status: 'built'
baseline_revision: 'b3e37d84cb70bb8417ad48fbdb7b8d48c992ac4f'
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

**Problem:** The epic 5 retrospective found Deploy paths that no test runs (V1, V2, V3, V5, V6): Deploy again from a row with a translation, a missing secret and a check finding; Delete from a row with no config open; a mapping write that fails and the mapping after a follow timeout; the real lint and version wiring (every test replaces it); one name in two local sources. A break in any of them would go unseen.

**Approach:** Add integration tests, one per path, using the existing fake cloud, the fake binary and the test seams; each test is shown to fail when its path is broken on purpose and to pass once the break is undone. No product code changes.

**Decision (user, 2026-11-11):** from the epic 5 retrospective's recommendations; tests written after bugs 47 and 48. No floor (VS Code 1.100.0) runs (user).

## Boundaries & Constraints

**Always:** Tests only (`src/test/**`); product code and messages unchanged; existing assertions unchanged; secret values never asserted in logs or messages beyond what bug 44's masking tests already do; every changed setting, PATH, file mode and seam restored in `finally`/teardown.

**Never:** A product test seam added for these tests; a real Redpanda Cloud or a real `rpk` binary; making the sidecar path a directory (it changes the flow to a bad mapping).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| AGAIN_FULL | Deployed config with `${VAR}`, a missing secret, a lint finding; Deploy again from its row | Sent config has `${secrets.VAR}`; missing-secret question asked; check finding shown | Test cancels at the check or accepts; no secret value in output |
| DELETE_NO_EDITOR | Folder with `orders.yaml` + `orders.yaml.cloud.json`, no editor open, Delete from row | Mapping named in the confirm, then removed with the pipeline | — |
| MAP_WRITE_FAILS | Folder read-only after save; first Deploy | Pipeline created and followed; error "Could not write …" shown | Skipped on Windows and as root |
| FOLLOW_TIMEOUT | Create stays STARTING past `timeoutMs` | Mapping holds the new pipeline's ids; timeout message shown | — |
| REAL_WIRING | Fake binary 4.120.0 with a lint finding, real `lint`/`localVersion` | Check shows the finding and the version line | binaryPath reset after |
| TWO_SOURCES | NAME in `redpandaConnect.env` and in the env file (or secret storage), missing in the Cloud | Offer labelled from `redpandaConnect.env`; the secret created with that value | — |

</frozen-after-approval>

## Code Map

- `src/test/integration/suites/96-cloud.ts` -- the stable suite; `originalLint`/`originalLocalVersion`/`originalLocalCatalogue` (:91-93, captured ~:229-231, replaced ~:322-324, restored ~:347-349); `CLEAN_LINT` :95; `sidecarFile()` :179. Models: FIRST_DEPLOY :742, "DEPLOY: still starting after the timeout" :528 (`fake.createSequence = [{state:'STATE_STARTING'}]`, `cloud().timeoutMs = 200`), ACCEPTANCE 5.6 :1063, ACCEPTANCE 5.7 with `withLocal`/`openForSecrets` :1187-1206, DEFAULT_LOCAL :1375 (`rc().update('env', …)`), DELETE_MAPPED :1756 (no-active-config part :1768-1772), `cloud().workspaceFolders` seam used at :1872, :2910, chmod guard :2021-2031, DEPLOY_AGAIN :2064, MISSING_COMPONENT :2155, LINT_ERROR :2255, VERSIONS text :2316, DOUBLE 45 :2357 (runs `DEPLOY_AGAIN_COMMAND` :2384), STOPPING 45 :2678.
- `src/test/integration-multiroot/suites/cloud.ts` -- multi-root suite (folders `a`, `b` from `test/multiroot/multiroot.code-workspace`); lint capture :134, clean lint :140; UI stub with `confirm`/`confirms` :166; MULTI_ROOT :205 with `deployNew`.
- `src/test/helpers/fakeCloud.ts` -- `failures` :161, `delay` :163, `*Sequence` :146-157, per-cluster `secrets`, `missingComponents` :81-91.
- `src/test/helpers/fakeBinary.ts` -- `writeFakeBinary` :11, `connectScript` :111, `fixtureBodies` :247; usage model `src/test/integration/suites/50-lint.ts:57-87`.
- Product (read, do not change): `cloudActions.ts` `deployAgain` :612, `mappingsOf` :310-330, `deleteTarget` :332; `cloudShared.ts` `findMapping` :106; `cloudDeploy.ts` `ensureSecrets` :255, `mapTo` :261-265, `writeMapping` :769-782, `createAndFollow` :794, `follow` :837-917, `keepValueAction`/`localSourceText` :57-73; `environmentView.ts` `localValues` :476-487; `environmentModel.ts` `PRECEDENCE` :18; `extension.ts` real `lint`/`localVersion`/`catalogue` :343-345.

## Tasks & Acceptance

**Execution:**
- [x] `src/test/integration/suites/96-cloud.ts` -- add AGAIN_FULL (criterion 1): deploy a config with `${VAR}`, then Deploy again from its row with a missing secret and a check finding (`missingComponents` or a lint finding via `cloud().lint`); assert the translated config sent, the question, the finding -- V1.
- [x] `src/test/integration-multiroot/suites/cloud.ts` -- add DELETE_NO_EDITOR (criterion 2) in a real folder: deploy `a/…yaml`, close all editors, Delete from its row; assert the confirm names the mapping and the file is gone with the pipeline -- V2 with real `workspaceFolders`.
- [x] `src/test/integration/suites/96-cloud.ts` -- add MAP_WRITE_FAILS (criterion 3) with `chmod 0o555` on the config's folder after save, restored in `finally`, guarded as at :2021-2031; assert the error text, the pipeline created, no mapping file -- V3.
- [x] `src/test/integration/suites/96-cloud.ts` -- extend or add FOLLOW_TIMEOUT (criterion 4): after the timeout, the mapping holds the new pipeline's ids -- V3.
- [x] `src/test/integration/suites/96-cloud.ts` -- add REAL_WIRING (criterion 5): fake binary 4.120.0 with a lint finding as in 50-lint, `cloud().lint = originalLint`, `cloud().localVersion = originalLocalVersion`; assert the finding and the version line; reset `binaryPath` (and PATH if changed) -- V5.
- [x] `src/test/integration/suites/96-cloud.ts` -- add TWO_SOURCES (criterion 6): same name in `redpandaConnect.env` and in the env file (set and clear `envFile`); assert the offer's label names `redpandaConnect.env` and the created secret's value is that one -- V6.
- [x] Criterion 7 -- break each path on purpose in a scratch edit of the product code (e.g. `deployAgain` skips `ensureSecrets`, `mappingsOf` ignores folders, `writeMapping` swallows silently, `mapTo` skipped before follow, `extension.ts` lint wired to a no-op, `localValues` keeps the last source), run the test, see it fail, undo; record each in Implementation Notes. Never commit a break.

**Acceptance Criteria:**
- Given the stable and multi-root runs, when they run on this change, then all tests pass, the new tests among them, and the test settings, PATH and file modes are clean afterwards.
- Given each new test, when its path is broken on purpose, then it fails, and it passes once the break is undone (recorded per test).

## Implementation Notes

Tests added (no product change): in `src/test/integration/suites/96-cloud.ts`, a block "ticket 49" before NO_LEAK with AGAIN_FULL 49, MAP_WRITE_FAILS 49, REAL_WIRING 49 and TWO_SOURCES 49, and FOLLOW_TIMEOUT as extra assertions at the end of "DEPLOY: still starting after the timeout" (the mapping equals the created `slow` pipeline's ids); in `src/test/integration-multiroot/suites/cloud.ts`, DELETE_NO_EDITOR 49. The new secret values (`again49`, `setting49`, `envFile49`) are in `SECRET_VALUES`, so NO_LEAK checks them.

- AGAIN_FULL: `inWorkspace()`, deployed with `${BROKER}` (present), then `${AGAIN_49}` added and saved, editors closed; a lint finding through `cloud().lint`; Deploy again from the row: Deploy anyway at the check, Add it now with a typed value, Replace and restart. The finding is the only error, one "Add AGAIN_49 now?" question, the secret created, the PUT's `config_yaml` has `${secrets.BROKER}` and `${secrets.AGAIN_49}`; the typed value (and its base64) in no message, log line, prompt or the PUT body.
- DELETE_NO_EDITOR: real folders `a`/`b`, both deployed; b's mapping and pipeline are checked as left; the confirm names `a/orders-47.yaml.cloud.json`; `mappings` is that file; it is deleted with the pipeline (DELETE sent, pipeline gone), the config unchanged (compared with its text just before the delete, since earlier tests mark the file).
- MAP_WRITE_FAILS: its own temp dir (not `dir`, which NO_LEAK reads file by file), `chmod 0o555` after the saved file is opened, restored to `0o755` and removed in `finally`; skipped on Windows and as root. Final Running, one create, the error "Could not write orders.yaml.cloud.json: … The next Deploy will not know the pipeline it went to.", the log line, no mapping file.
- REAL_WIRING: `binaryPath` is only a fallback when PATH yields no binary, so PATH is filtered of `rpk`/`redpanda-connect` (as 50-lint) and restored in `finally`, with `binaryPath` reset and the state waited off the fake. Fake 4.120.0 (4.112.0 schema fixtures), lint finding for `nope_49:`; `cloud().lint`/`localVersion` set to the captured real closures, reset to the clean ones in `finally`. Asserts the finding and "rpc-vilnius runs Redpanda Connect 4.115.0; this machine has 4.120.0."
- TWO_SOURCES: first the env file only (own temp dir): "Keep the value from the env file", its value created; then `redpandaConnect.env` too (the secret removed from the fake), deployed again (unchanged); `envFile` cleared in `finally`, `env` by `withLocal`. Offer "Keep the value from redpandaConnect.env (user settings)", the created secret is the setting's value.

Criterion 7 (each break a scratch edit, rebuilt with `node esbuild.js`, run with `--grep`, then `git checkout` and rebuilt; none committed):
- `cloudDeploy.ts`: `ensureSecrets` skipped when `only` (Deploy again) -> AGAIN_FULL fails (the cluster rejects: `required secrets were not set: [secrets.AGAIN_49]`, a second error). Undone: passes.
- `cloudActions.ts` `mappingsOf`: `taggedConfigs(…, [])` (folders ignored) -> DELETE_NO_EDITOR fails (the confirm without the mapping). Undone: passes.
- `cloudDeploy.ts` `writeMapping`: the `showError` in the catch removed (silent) -> MAP_WRITE_FAILS fails (`errors.length` 0 !== 1). Undone: passes.
- `cloudDeploy.ts` `createAndFollow`: `created(current)` (mapTo) moved after the follow, only on `final` -> "still starting after the timeout" fails (ENOENT on the mapping). Undone: passes.
- `extension.ts`: the Cloud view's `lint` wired to a no-op clean result -> REAL_WIRING fails (`final`, not `checkStopped`); `localVersion` wired to `undefined` -> REAL_WIRING fails (no version line). Undone: passes.
- `environmentView.ts` `localValues`: overridden values kept and the last source wins (`!out.has` dropped) -> TWO_SOURCES fails (the setting's Keep label not offered: `notStarted`). Undone: passes.

## Plan Change Log

## Review Triage Log

Thorough review (2026-11-12; blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Verdicts: 0 high, 3 medium, 11 low (8 patched, 3 rejected), 3 false; intent-alignment descriptive, no action. Routes: 11 patch, 0 defer, 0 bad_plan, 0 intent_gap.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 1 | VG, BH, EC | TWO_SOURCES never shows the env file is read; passes with one source | medium | patch | Only the setting supplies the asserted choices and value; add an env-file-only step offering "the env file" with envFile49. |
| 2 | VG, BH, EC | REAL_WIRING `finally` ignores the restore `waitFor` result | medium | patch | Result unasserted at the restore; a failed restore leaks a deleted binary into later suites. Assert it. |
| 3 | BH | DELETE_NO_EDITOR deploys folder a only; a wrong-folder lookup goes unseen | medium | patch | No b mapping exists to be wrongly found or deleted; deploy b too and assert it is kept. |
| 4 | EC | REAL_WIRING: two 30 s waits inside the suite's 60 s timeout (96-cloud.ts:86) | low | patch | Direct correction: `this.timeout(120_000)` on the test. |
| 5 | BH, EC | AGAIN_FULL never asserts the scripted Replace confirm | low | patch | Trivial assertion, as at :795. |
| 6 | BH | DELETE_NO_EDITOR does not assert the confirm's actions | low | patch | Trivial assertion. |
| 7 | BH | REAL_WIRING does not assert `errorActions` | low | patch | Trivial assertion. |
| 8 | BH | REAL_WIRING's three versions unexplained in code | low | patch | One-line comment. |
| 9 | BH | MAP_WRITE_FAILS does not assert the deploy's own success message | low | patch | Trivial assertion. |
| 10 | BH | `setting49`/`envFile49` lack doc comments | low | patch | Comment-only. |
| 11 | BH | Multi-root suite title says bug 47 / deploy names only | low | patch | Rename. |
| 12 | BH | AGAIN_FULL does not assert the secret POST body, the step order, the final state | low | reject | The created value is asserted via the cluster's secrets; the fake refuses a PUT with unset secrets, which enforces the order; adds assertions beyond the criterion. |
| 13 | BH | MAP_WRITE_FAILS does not check that the next Deploy offers Create | low | reject | Beyond criterion 3 (reported + still created); an extra deploy round-trip. |
| 14 | EC | CAP_DAC_OVERRIDE ignores 0o555 for a non-root user | low | reject | Not met in everyday runs (local and GitHub runners are plain users); the fix adds a guard branch. |
| 15 | BH | TWO_SOURCES does not show envFile49 kept out of messages and logs | false | reject | envFile49 is in SECRET_VALUES and never created, so NO_LEAK fails on any appearance in a request, message, output line, setting, file or view. |
| 16 | EC | `process.env.PATH = originalPath` writes "undefined" if PATH was unset | false | reject | PATH is always set in the extension host; the same restore is used in 00, 50, 60, 61 and 70. |
| 17 | IA | "No config open" shown as no active editor, not an unloaded document | false | reject | The ticket's "no config open" is the user's view (no editor); `mappingsOf` does not consult open documents, only the tag and the workspace folders. |

Intent-alignment notes (descriptive): one test per path with FOLLOW_TIMEOUT as added assertions on the existing timeout test; the row commands run with the row's node, not the context menu; the AGAIN_FULL check finding comes from the lint seam (the real wiring is REAL_WIRING's job); one pair of local sources; the breaks are recorded in Implementation Notes.

## Design Notes

The test replacement of lint and version stays for every other test; only REAL_WIRING puts the captured real closures back, so a break in `extension.ts`'s wiring fails one test instead of none. Criterion 2 runs in the multi-root run because the defect class was "the stable run opens no folder": the `workspaceFolders` seam would bypass the very lookup under test.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (lint included)
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: 0 failing
- same with `--label multiroot` -- expected: 0 failing
- `npm run test:corpus`, `npm run test:webview` -- expected: pass (unchanged)

**Manual checks (if no CLI):**
- None: tests only, no product change.

**Result (2026-11-12, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 381, stable 1477 passing, 1 pending, 0 failing, multi-root 15 passing; the test settings clean; `test/multiroot` clean; no floor run.
