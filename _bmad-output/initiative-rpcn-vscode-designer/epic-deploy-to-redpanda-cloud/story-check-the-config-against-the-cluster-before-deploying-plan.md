---
title: 'Check the config against the cluster before deploying'
type: 'feature'
ticket: '8'
created: '2026-11-04'
status: 'in-review'
baseline_revision: 'b47b2f41da941669637b246a48cd2b4dd431bf74'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-5-1-findings/findings.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-create-the-missing-cloud-secrets-plan.md
  - src/adapters/vscode/cloudView.ts
  - src/adapters/vscode/diagnostics.ts
  - src/core/graph.ts
  - src/core/bloblangProcessors.ts
  - src/core/bloblang.ts
  - src/test/helpers/fakeCloud.ts
  - src/test/integration/suites/96-cloud.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A config the cluster cannot run (a component or Bloblang function it does not offer, or a config with lint errors) is only found out when the cluster's lint rejects the create, one hint at a time, after the round trip; nothing says the cluster's Connect version differs from the local one.

**Approach:** Before sending (after the cluster is chosen and the final translation), Deploy runs the local lint and checks the config against the cluster's `GET {dp}/v1/redpanda-connect/components`: every component the config uses, by category, and every Bloblang function and method its mappings call. Findings go to the Problems panel on their lines and into one error message that offers **Deploy anyway**; with none, the deploy goes on unchanged.

**Decisions (user, 2026-11-04):**
- The check covers components (inputs, outputs, processors, caches, rate limits, buffers, metrics, tracers, scanners) and Bloblang functions and methods.
- The local lint runs first: its errors are findings (its warnings are not); with no binary, the lint is skipped with a note and the cluster check still runs.
- Findings: the Problems panel (until the file changes or the next deploy) plus one error message summarising them.
- The message offers "Deploy anyway"; choosing it sends as before (the cluster's own lint still applies).

## Boundaries & Constraints

**Always:**
- The components list is read once per deploy, through `authorizedJson`, under the deploy's progress; if it cannot be read, the deploy says so and offers "Deploy anyway" (the cluster check is skipped, the lint still counts).
- The check runs on the local file's components and mappings (the translation changes only variable references); line numbers are the local file's.
- A finding names the thing and the cluster: "line 4: input `stdin` is not available on rpc-vilnius (Redpanda Connect 4.115.0)"; "line 9: Bloblang method `.foo()` is not available on rpc-vilnius"; lint errors as the lint reports them. The message also names the cluster's and the local Connect versions when they differ.
- The Problems entries use their own diagnostic collection (source "Redpanda Cloud"), separate from lint on save; they are cleared when the file changes, when it is closed, and at the next deploy.
- Story 5.2–5.7 rules stand (masking, requests only on the user's action, the fake for every test); "Deploy anyway" and Escape are the only ways forward, Escape sends nothing.

**Never:**
- Checking component fields against the cluster's config schema; changing lint on save; blocking on lint warnings; a check outside Deploy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CLEAN | every component and function offered, lint clean | no finding, no prompt; deploys as before | none |
| MISSING_COMPONENT | `input: stdin` (or a processor in a `switch` case, a cache resource) not in the cluster's list | Problems entry on its line; message with Deploy anyway; nothing sent | Escape: nothing sent |
| MISSING_BLOBLANG | a mapping calls `foo()` or `.bar()` the cluster lacks | Problems entry on the call's line; same message | none |
| LINT_ERROR | the local lint reports an error | it is a finding; the same message | warnings only: no finding |
| NO_BINARY | no local binary | lint skipped, one note in the output channel; the cluster check runs | none |
| LIST_FAILS | the components list fails | the API's message with Deploy anyway; the lint still counts | none |
| DEPLOY_ANYWAY | findings; Deploy anyway | sent as before; the Problems entries stay until the file changes | the cluster's rejection shown as 5.2 |
| VERSIONS | cluster 4.115.0, local 4.120.0 | the message names both | equal or unknown: not mentioned |

</frozen-after-approval>

## Code Map

- `src/core/graph.ts` `buildPipelineModel` -- the components the config uses with their category and position (nested processors, resources); reuse it rather than walking the YAML again; a pure `componentUses(model)` (new, in `src/core`) if the model needs flattening. Resource sections (`cache_resources`, `rate_limit_resources`, `input_resources`, `output_resources`, `processor_resources`) and `buffer`, `metrics`, `tracer`, scanners count.
- `src/core/bloblangProcessors.ts` + `src/core/bloblang.ts` -- the mappings and their regions; a pure `bloblangCalls(text)` (new) returning function `name(` and method `.name(` calls with offsets, skipping strings and comments, unit-tested.
- New `src/core/cloudCheck.ts` -- pure: (uses, calls, cluster components) → findings `{ line, message }`; unit-tested on the corpus (`test/corpus/*.yaml` against a list built from the local schema: no findings) and on missing entries.
- `src/adapters/cloud/dataPlane.ts` -- `getComponents(call, dp)`: version and the name lists per category (capture 18 shape: `components.{inputs, outputs, processors, caches, rate_limits, buffers, metrics, tracers, scanners, bloblang_functions, bloblang_methods}[].name`).
- `src/adapters/vscode/diagnostics.ts` -- how lint on save gets `lint(doc)`; Deploy gets the same function as a `CloudView` option (`src/extension.ts`), and the local version from where the status bar reads it.
- `src/adapters/vscode/cloudView.ts` `deployFile` -- the check after the secrets step (5.7) and before the UNCHANGED comparison; a new diagnostic collection; `CloudUi.error` with the Deploy anyway action.
- `src/test/helpers/fakeCloud.ts` -- `GET /dp/<id>/v1/redpanda-connect/components` per cluster (default: a list that covers the suite's configs), a failure hook.
- `src/test/integration/suites/96-cloud.ts` -- every matrix row; Problems entries via `vscode.languages.getDiagnostics`.
- `README.md` Redpanda Cloud section, `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/cloudCheck.ts`, `bloblangCalls`, `componentUses` + unit tests (corpus included).
- [x] `src/adapters/cloud/dataPlane.ts` `getComponents` + unit test; `src/test/helpers/fakeCloud.ts` route.
- [x] `src/adapters/vscode/cloudView.ts`, `src/extension.ts` -- the check, the collection, Deploy anyway.
- [x] `src/test/integration/suites/96-cloud.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a fake cluster that lacks `stdin`, when a config with `input: stdin` is deployed, then nothing is sent, the Problems panel has an entry on the `stdin` line naming the cluster, and Deploy anyway sends the config.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass.

## Implementation Notes

- `componentUses(parsed, text, catalogue)` lives in `src/core/graph.ts` and runs the model's own `Builder` with a collector (the model is unchanged): each component it reaches, with its category and its component key's offset, plus the top-level `buffer`, `metrics` and `tracer`, and scanners. Scanners are not graph slots, so `componentCatalogue` now also records `scannerSlots` (fields that `$ref` `#/definitions/scanner`: `file.scanner`, `decompress.into`, a `switch` scanner's `[].scanner`); the graph does not read them.
- With no local schema (no binary) the model has no catalogue, so `clusterComponents` derives one from the answer's `config` field trees (the same slot rule; an input's and output's `processors` as the shared slot, since the trees leave shared fields out). The local schema's catalogue wins when one is loaded.
- `bloblangCalls(source)` / `documentBloblangCalls(parsed, text)` are in `src/core/bloblang.ts`: every Bloblang field and `${! }` region, strings and comments blanked by the existing `codeOf`; `if`, `match` and similar words before `(` are not calls.
- The check runs after the secrets step (as the Code Map says), so on Escape the secrets created in that deploy stay and the deploy says so. Result kind `checkStopped` (`findings`, `listError`). Lint errors and cluster findings share the `redpanda-cloud-check` collection (source "Redpanda Cloud"); lint errors cover their whole line, cluster findings the name.
- Test seams on `CloudView`: `lint`, `localVersion`, `localCatalogue` (the suite sets a clean lint, no version, no local catalogue in `setup`, so it does not depend on a binary on PATH). The fake serves the 4.112.0 `json-full` recording as the components list (`missingComponents`, `componentsError`). UPDATE_RUNNING's cancelled update now also reads the components (two GETs).

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone, with the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: a config with `input: stdin` (or a component the cluster lacks) shows the finding in the Problems panel and the message, Escape sends nothing; a clean config deploys without any prompt.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | The check runs after `ensureSecrets`, so Escape at the check leaves the secrets just created, and the user answers secret prompts for a deploy the check then stops | medium | `checkBeforeSending` needs only `cluster`, `dp` and the translated source, all known before `ensureSecrets`; breaks "Escape sends nothing" (frozen) | patch (move the check before the secrets step) |
| 2 | The components list is read under its own "Checking …" progress, not the deploy's | low | a design choice, cosmetic; the deploy's progress starts later in create/update | reject |
| 3 | `checkStopped.findings` is returned unmasked while `listError` is masked | low | shown and logged copies are masked; the returned copy is not | patch |
| 4 | A `${! fn() }` inside a YAML comment becomes a blocking finding | medium | `regions` scans `${!` over the whole text, comments included; now feeds a deploy stop | patch (ignore calls inside YAML comments for the check) |
| 5 | Bloblang calls are scanned in every YAML document, components only in the first | low | `regions` walks `parsed.docs`, `componentUses` reads `docs[0]`; one rule for both is a direct correction | patch (both on the first document) |
| 6 | With no local schema, components nested under a component the cluster lacks are not walked | low | the cluster catalogue has no slots for a missing component; needs no binary and a missing container; the outer one is still reported | reject |
| 7 | The clear-on-close assertion is skipped when VS Code keeps the document open | low | conditional `if`; VS Code decides when a closed editor's document goes; test robustness only | reject |
| 8 | DEPLOY_ANYWAY's "the cluster's rejection shown as 5.2" has no test | low | every Deploy anyway test uses a config the fake accepts | patch (add one) |
| 9 | A lint that fails to run or parse is silently treated as clean | false | `checkBeforeSending`'s `lint.kind === 'failed'` branch logs the lint's line and "could not be linted before the deploy; the check against <cluster> still runs", the same kind of note as the no-binary case | reject |

Patches applied directly (the implementer could not be resumed after a session change): 1 (the check moved before `ensureSecrets`; its "they stay" message dropped), 3 (findings masked in the result), 4 and 5 (`documentBloblangCalls` keeps only calls inside a scalar of the first YAML document; unit test), 8 (an integration test of Deploy anyway then the cluster's rejection), plus a test that Escape at the check reads and creates no secret.

