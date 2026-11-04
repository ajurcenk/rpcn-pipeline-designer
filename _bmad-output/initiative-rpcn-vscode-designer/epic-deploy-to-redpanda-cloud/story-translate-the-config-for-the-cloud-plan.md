---
title: 'Translate the config for the Cloud: variables become secrets'
type: 'feature'
ticket: '6'
created: '2026-11-03'
status: 'done'
baseline_revision: '8b6017d275267ce9d9c99a5389430a5839f56b9c'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-5-1-findings/findings.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/story-deploy-again-updates-the-mapped-pipeline-plan.md
  - src/core/envUsage.ts
  - src/adapters/vscode/cloudView.ts
  - src/test/integration/suites/96-cloud.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Deploy sends the file's text as written, but Redpanda Cloud pipelines have no environment variables: a config using `${VAR}` gets an empty value in the Cloud (or fails the cluster's lint), and `env("NAME")` in Bloblang reads nothing.

**Approach:** Before every create or update, a pure translation rewrites each `${VAR}` to `${secrets.VAR}` and `${VAR:default}` to `${secrets.VAR:default}` in the text sent; the local file is never changed. Deploy refuses, naming each one with its line, when a variable's name is not a valid secret id (`^[A-Z][A-Z0-9_]*$`) or the config calls Bloblang's `env(`. The translation returns the secret names it used (for story 5.7). The comparison with the deployed config and the diff use the translated text.

**Decisions (user, 2026-11-03):**
- Ticket 5.6 is split: this story translates variables only; including resource files and the local-only warnings are deferred (`deferred-work.md`, two entries).
- A default is kept: `${VAR:default}` → `${secrets.VAR:default}`; whether the cluster accepts it is checked in the manual check.
- A name that is not a valid secret id (lowercase, a leading `_` or digit) is refused, not rewritten.
- `env("NAME")` (and any `env(` call) is refused, naming each call: the user rewrites it as `"${NAME}"`.

## Boundaries & Constraints

**Always:**
- The binary's reference rule (`envUsage.ts` `REFERENCE`): `${NAME}` / `${NAME:default}` anywhere in the text, comments included; `${!…}` is Bloblang interpolation and untouched; a name with a `.` (such as an existing `${secrets.X}`) is left as written. Only the reference spans change; every other byte of the text is kept.
- The translation is pure (`src/core`, no `vscode` import) and idempotent: translating its output changes nothing.
- A refusal sends nothing, shows one error naming each problem with its line (the output channel gets one line each), and is masked like every other message.
- Story 5.2–5.4 rules stand (masking, the fake for every test, the sidecar and size rules).

**Never:**
- Changing the local file; resource files or local-only warnings (deferred); creating or checking cloud secrets (story 5.7); quoting or rewriting Bloblang.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PLAIN | `url: ${BROKER}` | sent as `url: ${secrets.BROKER}`; secrets `[BROKER]` | none |
| DEFAULT | `${TOPIC:orders}`, `${OPT:}` | `${secrets.TOPIC:orders}`, `${secrets.OPT:}` | none |
| MANY | the same name several times, in comments too | every use rewritten; the name listed once, by first use | none |
| UNTOUCHED | `${!meta("k")}`, `${secrets.X}`, `$${X}` text, no references | sent as the binary would read them: `${!…}` and dotted names unchanged; a config with no reference is sent byte for byte | none |
| BAD_NAME | `${my_token}`, `${_X}`, `${1X}` | refused: "my_token (line 4): a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$"; nothing sent | none |
| ENV_CALL | `root.k = env("KEY")` | refused: "line 7: env(\"KEY\") reads an environment variable, which Redpanda Cloud pipelines do not have; use \"${KEY}\""; nothing sent | none |
| UNCHANGED | deployed = the translation of the saved file, same size | "nothing changed" (compared with the translated text) | none |
| DIFF | update of a running pipeline | the diff's right side is the translated text (read-only), not the file | none |

</frozen-after-approval>

## Code Map

- `src/core/envUsage.ts` -- `REFERENCE` and `ENV_CALL` are the binary's rules; export or share them rather than copying. Keep `envUsage`/`envReferenceAt` behaviour unchanged.
- New `src/core/cloudTranslate.ts` -- `translateForCloud(text): { kind: 'ok'; text; secrets: string[] } | { kind: 'refused'; problems: { line; message }[] }` (1-based lines); `env(` found with a word-boundary match (literal and computed).
- `src/adapters/vscode/cloudView.ts` `deployFile` (after `configYaml` is read, before the size pick) -- translate; on refusal show the problems and return `notStarted`; pass the translated text to create, update, the UNCHANGED comparison and `showDiff`. `showDiff` gets the translated text as a second read-only `redpanda-cloud:` document (e.g. `…/<name>.local.yaml`), titled "<name> (deployed) ↔ <file> (as sent)". The sidecar and the `rpcn-vscode/config` tag are unaffected.
- `test/corpus/*.yaml` -- the corpus for unit tests: every config translates or is refused; translated output has no `${NAME}` with a valid name left; idempotent; outside reference spans the text is unchanged.
- `src/test/helpers/fakeCloud.ts` -- no change expected; its lint already sees the received `config_yaml`.
- `src/test/integration/suites/96-cloud.ts` -- matrix rows through the fake (the `config_yaml` the fake received), the refusal messages, UNCHANGED and the diff's right side.
- `README.md` Redpanda Cloud section (variables become secrets; the cluster needs them, story 5.7 will offer to create them), `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/cloudTranslate.ts` + unit tests (matrix rows and the corpus) -- the translation.
- [x] `src/adapters/vscode/cloudView.ts` -- translate before sending; refusal; comparison and diff on the translated text.
- [x] `src/test/integration/suites/96-cloud.ts` -- matrix rows against the fake.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a config with `${BROKER}` and `${TOPIC:orders}`, when it is deployed, then the fake receives `${secrets.BROKER}` and `${secrets.TOPIC:orders}` and the local file is byte for byte unchanged.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass.

## Implementation Notes

- The save, the read and the translation moved to the start of `deployFile` (after the untitled / on-disk / detected checks, before Connect, the cluster pick, the name and the size pick), so a refusal costs no prompt and no request; a dirty config is now saved before the prompts (Escape at a later prompt leaves it saved, as Run would).
- `REFERENCE` and `ENV_CALL` are exported from `envUsage.ts` (behaviour unchanged). `env(` is found with `\benv\(` anywhere in the text (comments included, like the reference rule); a literal name is shown as `env("NAME")` with its suggestion, a computed one as `env(…)` with `"${NAME}"`. Each bad use is listed by position (a bad name used twice is listed twice).
- `$${X}` becomes `$${secrets.X}` (envUsage's rule: not an escape). A default's own `${…}` (`${A:${A}}`) is not rewritten, as the binary does not expand it.
- The diff's right side is `redpanda-cloud:/<cluster>/<pipeline>/<name>.local.yaml` (`sentConfigUri`), served by the same content provider. The translation's `secrets` are returned but not used yet (story 5.7).
- Unit tests run the matrix and every `test/corpus/*.yaml` (all translate; none is refused). The first full stable run had 7 unrelated failures (undo / applyEdit in the lint, Bloblang panel and Environment suites) plus one in the new BAD_NAME test (an edit applied before VS Code reread a file the previous test had changed); that test now waits for the text, and the second full run passed (1187).

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: deploy a config with `${VAR}` and `${VAR:default}` (the secret for `${VAR}` created in the Cloud UI first, as story 5.7 is not built): the cluster accepts the default form and the pipeline runs; a config with `${my_var}` and one with `env("X")` are refused with the lines.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | The text is saved, read and translated before the Connect, cluster, name and size prompts; edits made meanwhile are not sent, and the comparison and diff use the old text | medium | `deployFile` reads `configYaml` before `await this.ready` and the prompts, and never re-reads before the create or update | patch |
| 2 | The suggestion for `env("my_key")` is `"${my_key}"`, which BAD_NAME then refuses | low | ran `translateForCloud`; the message does not mention the secret name rule | patch |
| 3 | `env("X", …)` with more arguments is reported as a computed `env(…)` with the generic hint | low | the literal name is read with `ENV_CALL`, which needs `)` after the quote | patch |
| 4 | `\benv\(` also matches `this.env(` (after a `.`) and calls it a Bloblang `env(` call | low | `\b` matches after `.`; comment matches are the intended scope (plan); the `.` case is a direct correction | patch (the `.` case only) |
| 5 | `deployedConfigs` keeps old diff texts | low | pre-existing (5.3 rejected the same); now two entries per diff, still rarely met | reject |
| 6 | The acceptance test compares the whole received text, so a failing row is not named; `$${X}` only in unit tests | low | every row is asserted through the whole-text comparison and the unit tests | reject |

**Manual check result (user, 2026-11-04):** passed on the 1.143.1 dev host against the real organization: "tested, no issues". `${secrets.VAR:default}` with no such secret on the cluster runs on the default: the pipeline's log has an error-level "Failed to look up secret" (AccessDenied on the missing secret) at start, and the first state seen was `STATE_ERROR` with no reason, after which the pipeline ran on the default (the spike's intermittent no-reason error; the deploy's notification reported Error because it stops following at the first final state). An amendment to inline defaults was started on the Error report and discarded when the pipeline was seen running. The "as sent" diff, "nothing changed", and the `${my_var}` and `env("…")` refusals behaved as planned.
