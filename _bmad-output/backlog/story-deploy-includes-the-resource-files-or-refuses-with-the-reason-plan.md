---
title: 'Deploy includes the resource files or refuses with the reason'
type: 'feature'
ticket: '42'
created: '2026-11-17'
status: 'done'
baseline_revision: '9a7de92e239aeab32eac87b1400837f5dcc98984'
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

**Problem:** A config that uses resources from `redpandaConnect.resourceFiles` runs locally (lint and Run pass them as `--resources`), but Deploy to Redpanda Cloud sends only the config, so the pipeline in the Cloud lacks them.

**Approach:** Deploy merges the resources of the config's resource files into the one config it sends, translated for the Cloud as the config is, or refuses before anything is sent and names the file or the resource and why. A config with no resource files is sent as before, byte for byte. Compare with local file compares the same merged, translated text.

**Decision (user, 2026-11-09):** moved here from epic 5's refactor sweep (5.9). No floor (VS Code 1.100.0) runs (user).

**Decisions (user, 2026-11-17, the recommended options):** the resources go in as the config's top-level `*_resources` lists (`cache_resources`, `rate_limit_resources`, `processor_resources`, `input_resources`, `output_resources`), the standard Redpanda Connect form; the user's dev-host check on their cluster confirms the Cloud runs it. Every resource in the config's resource files is sent, as a local run with `--resources` loads them all (no reference scan). When the config has its own list of a kind, the files' items join that list; a label defined in the config and a file, or in two files, is refused, naming the label and where each is defined.

**Decision (user, 2026-11-17, after the first build; the recommended options):** Deploy no longer merges on its own. When the config's resource files hold resources (and the merge would succeed), Deploy first shows an error, before any other prompt: "<config> uses resources from <files>, which Redpanda Cloud does not get. Nothing was sent." with one button, **Include them and deploy**; Escape sends nothing. Include copies the resources only into the config sent (the local files are never written) and the deploy goes on with that merged text; the choice holds for the rest of that deploy and is asked again on the next. A merge that would be refused shows its refusal instead, with no button. Compare with local file shows the text Include would send (the config with its resources, translated).

## Boundaries & Constraints

**Always:** The resource files a config gets are the ones lint and Run get (`defaultArgsEnvironment(uri)` → `commandSettings(...).files().resourceFiles`, each entry expanded with `expandResourceEntry`, as `UnsetVariables.forRun` does); the config's own bytes are kept in the text sent, the resources appended; the merged text translated by the unchanged `translateForCloud` (variables as secrets, the secrets questions covering the resources' variables too); one merged text for the create, the update, "Nothing changed", the update's diff and Compare; the pre-deploy check (5.8, and story 43's warnings) still gets the unmerged config text, so its Problems ranges stay in the config document; the local files never written; refusals logged and shown in the existing "… Nothing was sent." / "Nothing was compared." style, before any prompt.

**Never:** Changing the deploy of a config with no resource files; changing `translateForCloud`'s rules or the pre-deploy check; scanning which resources the config references; a new setting.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MERGED | config uses a cache and a processor resource from `res.yaml` in `resourceFiles`; `res.yaml` uses `${TOKEN}` | config sent = config text + `cache_resources:` and `processor_resources:` from `res.yaml`, with `${secrets.TOKEN}`; TOKEN asked as a missing secret; local files unchanged | — |
| JOINED | config has its own `cache_resources` (block list); `res.yaml` adds another cache | one `cache_resources` list holding both, parsed again cleanly | a shape that cannot be joined (a flow list, a non-list) is refused, naming the key and the file |
| DUP_LABEL | a label in the config and in `res.yaml`, or in two files | nothing sent; message names the label, its kind and both places | — |
| UNREADABLE | a listed file that cannot be read, or not valid YAML, or not a map | nothing sent; message names the file and why | — |
| BAD_IN_FILE | a resource file with a translation problem (`env(` call, a bad name) | nothing sent; the problem named with the resource file and its line | — |
| UNSET_SETTING | `resourceFiles` unusable (relative path, no workspace) | nothing sent; the setting named, as lint says | — |
| GLOB_NONE | an entry that matches no file | as lint and Run: nothing added for it | — |
| UNCHANGED | deployed once; deploy again with nothing changed | "Nothing changed" (the merged text compared) | — |
| DIFF / COMPARE | a resource file changed after the deploy | the update's diff and Compare show the change in the resource | — |
| NONE | no resource files set | as before, byte for byte | — |

</frozen-after-approval>

## Code Map

- `src/adapters/redpandaConnect/args.ts` -- `defaultArgsEnvironment(resource?)` :119-142 (reads `resourceFiles` :124, folder via `definingFolder` :130, :148), `resolveFileSettingPath` :158-168 (`unusableSetting`, `relativePathWithoutWorkspace`), `resolveArgsFiles` :174-185, `commandSettings` :85.
- `src/adapters/redpandaConnect/resourceGlob.ts:84` -- `expandResourceEntry(entry)` (Go `filepath.Glob`; existing matches, sorted, never throws).
- `src/adapters/vscode/unsetVariables.ts:113-127` -- `forRun`: the pattern to copy (expand each entry, read with `diskText`); wiring `src/extension.ts:314-317`.
- `src/adapters/vscode/cloudView.ts:446-465` -- `CloudView` options (add a `resourceFiles(uri)` hook), wiring `src/extension.ts:335-345`.
- `src/adapters/vscode/cloudDeploy.ts` -- `savedAndTranslated(doc, file)` :413-430 (reads `source` :420, `translateForCloud(source)` :421; refusal message and log); called :166 (before any prompt) and :244; `configYaml = translated.text` :248 → create :278, `same` :287, update :350, `confirmReplace`/`showDiff` :365-369, :98-110 (`sentConfigUri`, `cloudShared.ts:44`); `ensureSecrets(..., translated.secrets)` :257; `checkBeforeSending(doc, file, cluster, dp, translated.source)` :250 (keep the unmerged `source`).
- `src/adapters/vscode/cloudActions.ts:553-590` -- `compare()`: buffer or file → `translateForCloud(source)` :570 → `compareConfigUri` (`cloudShared.ts:49`).
- `src/core/cloudTranslate.ts` -- `translateForCloud` (unchanged), `refusedText` style.
- `src/core/detection.ts:16-26` -- `DETECTION_KEYS` (the five `*_resources` keys); `src/core/graph.ts:222-227` walks them; `src/core/componentId.ts` `labelOf`; `src/core/yamlPath.ts:39` `parseYaml`; text-insertion model `src/core/labelEdit.ts:69-100` (insert, then parse again to check).
- Tests: `src/test/integration/suites/96-cloud.ts` `VARS`/`VARS_SENT` :1045-1075, ACCEPTANCE 5.6 :1077, BAD_NAME/ENV_CALL :1091, UNCHANGED 5.6 :1153, DIFF 5.6 :1163, COMPARE 48 :2049, secrets :1220+; setting `resourceFiles` in a test `src/test/integration/suites/60-run.ts:546-573` (write, `update(..., Global)`, reset in `finally`); unit `src/test/core/cloudTranslate.test.ts`, `src/test/adapters/redpandaConnect/resourceGlob.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/cloudResources.ts` (new, pure) -- `mergeResources(configText, files: {path, text}[])` → `{kind: 'merged', text}` or `{kind: 'refused', problems}`: each file parsed (one map document, else refused naming it); for each `*_resources` key in a file, its items appended to the config's list of that key (block list: items re-indented to the list's indent and inserted after its last item; no such key: the file's block appended at the end with a blank line); labels checked across the config and the files (duplicates refused, naming the label, its kind and both places); the result parsed again (refused if it does not parse to one map). No files → the config text unchanged. Unit tests for every matrix row it owns (MERGED, JOINED and its refused shapes, DUP_LABEL, UNREADABLE parse cases, NONE byte-for-byte, comments kept).
- [x] `src/adapters/vscode/cloudDeploy.ts` `savedAndTranslated` -- after reading `source`: get the config's resource files (the new hook), read each (unreadable: refused naming it), translate each file alone to report its problems with its path and line (BAD_IN_FILE), merge, then `translateForCloud(merged)`; return `{text, secrets, source}` with `source` still the config text; the unusable setting refused naming it.
- [x] `src/adapters/vscode/cloudActions.ts` `compare()` -- the same steps before translating, with the dirty buffer as the config text; refusals "Nothing was compared.".
- [x] `src/adapters/vscode/cloudView.ts`, `src/extension.ts` -- a `resourceFiles(uri)` option returning the expanded file list or the unusable-setting failure, wired from `defaultArgsEnvironment` and `expandResourceEntry` as `UnsetVariables.forRun` does; tests can replace it.
- [x] `src/test/integration/suites/96-cloud.ts` -- MERGED (config sent, TOKEN asked, files unchanged), JOINED, DUP_LABEL, UNREADABLE, BAD_IN_FILE, UNSET_SETTING, UNCHANGED, DIFF and COMPARE with a changed resource file, NONE covered by the existing tests unchanged.
- [x] `README.md` -- the Deploy section: resource files are sent with the config, and the refusals.

- [x] `src/adapters/vscode/cloudDeploy.ts` (renegotiated) -- after the first translate and before any other prompt: when resource files add resources, show the error with **Include them and deploy** (`ctx.showError`); Escape → a new result kind (e.g. `resourcesStopped`) and nothing sent; Include → the deploy uses the merged text, and the second translate after the size pick reuses the choice without asking again; Deploy again from a row asks the same; a refused merge shows the refusal with no button. Tests: the error text and button, Escape sends nothing (no request after the components read), Include sends the merged text, asked once per deploy, asked again on the next deploy; the existing story-42 deploy tests choose Include. README states the prompt.

**Acceptance Criteria:**
- Given the matrix rows, when the unit and integration tests run, then each row is covered and passes.
- Given compile with lint, corpus, webview, stable and multi-root runs, when they run, then all pass, and no existing 96-cloud assertion changed.

## Implementation Notes

- `src/core/cloudResources.ts` `mergeResources(config, files, configName)`: text-based; a kind the config (or an earlier file's appended block) lists as a block list gets the file's items (sliced `[line start of the seq, seq.range[1])`, re-indented) at the list's `range[1]`, i.e. after the last item and before a trailing comment; otherwise the file's pair is sliced `[line start of key, value.range[2])` and appended after a blank line. A later file joins whatever list is in the text by then (its owner named in the flow-list refusal). Label duplicates are only reported when one side is a resource file (a config-only duplicate is lint's). An empty resource file (or comments only, or no `*_resources` key, or `key:` with nothing) adds nothing. The result is parsed again and each kind's item count checked.
- Resource file lookup: `resolveResourceFiles(env)` (new, exported from `args.ts`, which `resolveArgsFiles` now uses) instead of `commandSettings(...).files()`, so a bad `redpandaConnect.envFile` (which Deploy never uses) does not refuse a deploy; the files are the same ones lint and Run get. Wired in `extension.ts` with `expandResourceEntry`; `CloudView.resourceFiles` is the test seam (default: no files).
- Shared step `sentConfig(ctx, uri, file, source)` in `cloudShared.ts` used by `savedAndTranslated` (Deploy) and `compare()`: unusable setting → the config's own translation (its messages unchanged) → each file read from disk and translated alone (`<file>: <problem>`) → merge → `translateForCloud(merged)`. No files: `translateForCloud(source)` exactly as before. Files are named with `vscode.workspace.asRelativePath`.
- `refusedText` now takes any `{ message }[]`.

- Renegotiated prompt (after b951261): `mergeResources` now also returns `from` (the files that added resources) and `sentConfig`'s ok result carries it as `resourcesFrom`. `deployDoc` asks with `ctx.showError(includeResourcesText(file, from), INCLUDE_RESOURCES_ACTION)` right after the first translate, before the account check or any prompt; Escape returns the new `DeployResult` `{ kind: 'resourcesStopped', files }`. The choice is kept in a local `included` flag for that deploy: the second translate after the size pick asks only if the first had no resources and this one has (a resource file changed meanwhile). Refusals still come from `savedAndTranslated` with no button. Compare is unchanged (the merged text). Files that hold no resources (`from` empty) ask nothing. Tests: the story-42 deploys choose Include (`deployOnce` takes the actions); new PROMPT 42 (text, one button, asked first, Escape sends nothing, Include sends the merged text, once per deploy, again on the next deploy and on Deploy again) and NONE 42; `refused42` asserts no button. Ran: the cloudResources unit tests and the 96-cloud story-42 block.

- Review fixes to the prompt: consent is the set of files agreed to; the second read asks again naming only the files not yet agreed (Escape: `resourcesStopped` with those files) and logs that the resource files changed during the deploy. Deploy again asks after its shared-mapping and mapping-changed refusals; a plain Deploy still asks first. `savedAndTranslated` returns the named `SavedConfig` (`SentConfig`'s ok arm plus `source`). Tests: RACE 42, NEW_FILE 42, TWO_FILES 42, NONE 42 with no setting, `from` with two contributing files; ran the cloudResources unit tests and the story-42 block (32 passing).

## Plan Change Log

- **2026-11-17, renegotiated by the user after the first build (b951261).** Trigger: the user asked that Deploy show an error and offer to copy the resources in, instead of merging on its own. Amended: the frozen block (a new decision), and the tasks below (the prompt). KEEP: `mergeResources` and its semantic check, the refusals, `sentConfig`'s steps, the resource-files hook with its de-duplication, Compare's merged text, the README's gaps; the code is not reverted, only the Deploy flow gains the prompt.

## Review Triage Log

Thorough review (2026-11-17; blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Verdicts: 3 high, 6 medium, 11 low (5 patched, 6 rejected), 1 false. Routes: 15 patch, 1 defer, 0 loopback. The edge-case lens probed the compiled merge.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 1 | EC, BH | A config ending in a `|+` scalar gets the separator in its value | high | patch | Probe: `root = 1\n` sent as `root = 1\n\n`. A semantic check after the merge (the config's own values unchanged). |
| 2 | EC | A joined item's anchor captures a config alias; a file alias binds to the config's anchor or stays unresolved | high | patch | Probe: `output.x` 1s → 9s; unresolved aliases pass the count check. Each file resolved alone, the merged text resolved, the config's values compared. |
| 3 | EC | Whitespace-only lines in a block scalar not re-indented | medium | patch | Probe: 2 spaces became 6. Fixed, and caught by 1's check. |
| 4 | EC | A leading BOM copied mid-file | medium | patch | Stripped before slicing. |
| 5 | IA, VG, BH, EC | A config `cache_resources:` (null) or `[]` refused, the same in a file skipped | medium | patch | Treated as no list. |
| 6 | EC, BH | A config ending in `...` refused as two documents | medium | patch | Insert before the marker. |
| 7 | EC | CRLF config gets LF items | medium | patch | The config's line ending used. |
| 8 | BH, EC | The same file listed twice (or the config matched by a glob) refused as its own duplicate | medium | patch | Paths de-duplicated, the config dropped. |
| 9 | BH | A resource without a label merges silently | high | patch | The cluster rejects it after the secrets and the send; refused before. |
| 10 | BH | A translation problem under a resource file's non-resource key refuses a deploy | low | patch | Only problems inside the merged blocks reported. |
| 11 | VG | A bad `envFile` not blocking Deploy is untested | low | patch | Integration test. |
| 12 | VG, BH | The pre-deploy check reading the config only is untested and unstated | low | patch | Test with a local-only resource; README "Not yet". |
| 13 | BH | Unsaved edits to an open resource file are left out | low | patch | Read from disk as Run does; stated in the README. |
| 14 | EC | Comments before a joined list's items are dropped | low | patch | README states it. |
| 15 | BH | Doc nits (`Defined`, `readonly`) and the README's refusal list | low | patch | Fixed. |
| 16 | VG, BH | Folder-level `resourceFiles` for Deploy untested | low | defer | Folder resolution is unit-tested in `args.test.ts`; the gap is the one-argument wiring. |
| 17 | BH | Refusals arrive in rounds (setting, config, files) | low | reject | Each stage needs the previous one to proceed; the config's own problems are reported together as before. |
| 18 | BH | No unit tests for `sentConfig` and `resolveResourceFiles` | low | reject | Reached through the integration suite, which drives each refusal; 11 adds the envFile case. |
| 19 | BH | A config-only duplicate reported against the first config line only | low | reject | Lint reports the config's own duplicate. |
| 20 | BH | A multi-root `asRelativePath` and some re-indent shapes untested | low | reject | 1's semantic check covers any re-indent that changes meaning. |
| 21 | IA | Whether a real cluster runs the merged config is outside the tests | low | reject | The user's dev-host check settles it, as decided. |
| 22 | EC | An unusable `resourceFiles` now refuses a deploy that used to ignore it | false | reject | The setting is set, so "no resource files" (AC3) does not apply; lint and Run refuse the same setting. |

Review pass 2 (2026-11-17, the renegotiated Include prompt; same four lenses). Verdicts: 1 high, 3 medium, 7 low (3 patched, 4 rejected), 1 deferred. Routes: 8 patch, 1 defer, 0 loopback.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 23 | BH, EC, IA | Consent is one boolean: a file gaining resources after Include is sent without being shown | high | patch | The second read's list is not compared with the one agreed; ask again for the new files. |
| 24 | EC | Deploy again asks Include before the shared / only-mapping refusals | medium | patch | The user approves, then is told nothing was sent; the refusals moved first. |
| 25 | VG, BH | The late ask (resources appear during the prompts) is untested | medium | patch | RACE 42; a log line says the files changed; the README states the exception. |
| 26 | VG, BH | Two or three files: the wording and `from` untested; an empty `from` would skip the question | medium | patch | TWO_FILES 42 and unit cases. |
| 27 | BH | NONE 42 does not cover the no-files case | low | patch | Added. |
| 28 | BH | The README says Escape closes the message | low | patch | Reworded. |
| 29 | BH | `savedAndTranslated`'s long inline return type | low | patch | Named. |
| 30 | BH, EC | A non-modal notification hidden by Escape leaves the deploy waiting (and its per-file guard held) | low | defer | The same as 5.8's Deploy anyway; a modal changes every Deploy prompt's look; recorded. |
| 31 | BH | "Nothing was sent." in a message that offers to send | low | reject | The user chose this text (2026-11-17). |
| 32 | BH | Compare's title does not say the resources are included | low | reject | The user chose Compare to show the text Include would send; the README says so. |
| 33 | BH | `from` pushed before the refusal check; dedup only upstream | low | reject | A refusal discards `from`; ONCE 42 pins the dedup. |
| 34 | EC | "No existing 96-cloud assertion changed": CONFIG_ONLY 42 changed | false | reject | It is this story's own test from the first build, renegotiated by the user; no pre-story assertion changed. |

## Design Notes

The merge is text-based so the config's bytes (comments, order, quoting) stay as written and the 5.8 ranges keep meaning; a file's block is sliced from its own text by the key's node range, so its comments go too. Translating each resource file alone before the merge names a problem with the file it is in; the merged text is then translated once for the secrets and the text sent, which keeps one source for create, update, "Nothing changed", the diff and Compare. The Cloud's acceptance of top-level `*_resources` in `config_yaml` was not recorded by the spike; the dev-host check on the user's cluster settles it.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (lint included)
- `npm run test:corpus`, `npm run test:webview` -- expected: pass
- `npm run pretest`, then `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: 0 failing
- same with `--label multiroot` -- expected: 0 failing

**Manual checks (if no CLI):**
- Dev host on the user's cluster: a config using a cache resource from a resource file deploys, the pipeline runs (Running, no config error), and Compare shows the resource in the text sent.

**Result (2026-11-17, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 385, stable 1565 passing, 1 pending, 0 failing (11 min), multi-root 15 passing; the test settings clean; no floor run.

**Result (2026-11-17, the renegotiated Include prompt after review pass 2's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 385, stable 1570 passing, 1 pending, 0 failing (11 min), multi-root 15 passing; the test settings clean; no floor run.

**Manual check result (user, 2026-11-17): tested, no issues.** Dev host 1.143.1 with 84b76b2 on the user's cluster, `res42.yaml` using the `seen` cache and the `tag_it` processor from `res42/resources.yaml` (listed in `redpandaConnect.resourceFiles`): Deploy showed the resources error with Include them and deploy before any other prompt; closing it sent nothing; Include deployed the pipeline to Running with `tagged=true` in its logs; Compare showed no difference; a duplicate `seen` label was refused with no button.
