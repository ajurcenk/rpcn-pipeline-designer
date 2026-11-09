---
title: 'Deploy masks only the secret values it sends'
type: 'bugfix'
ticket: '44'
created: '2026-11-09'
status: 'built'
baseline_revision: 'c8fdebd008f46e3a1cf4f56b6d02a1363b6735ed'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/epic-deploy-to-redpanda-cloud-retrospective.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Deploy masks the local value of every missing secret for the whole session, before the user chooses, so a value not created (often a common word) turns ordinary names and messages into `•••••`. A sent value under 4 characters is never masked, so a short secret echoed by a Cloud API error would show in a message and the output channel. No test exercises the masking (retrospective C2, V4).

**Approach:** Mask a secret value from the moment it is sent, and only then: the value kept or typed, just before its create request, not every local value up front. Short sent values (1–3 characters) are masked only in Cloud API text. Add the tests that make the masking fail when it is removed.

**Decision (user, 2026-11-09, the recommended option):** a sent value of 1–3 characters is masked, with no minimum length, only in the Cloud API's error message and hints (`http.ts`, where API text enters), not in the extension's own messages; values of 4 or more are masked everywhere as today.

## Boundaries & Constraints

**Always:**
- A value that is sent, and its base64 form, never appears in a message, a log line, a deploy result, a question or a tree label after it is sent, including when a Cloud API error echoes it.
- A local value that is not sent (Don't create it, Stop, Escape, Enter another value) is not masked.
- The client secret, tokens and the log-access password stay masked as today.
- Every other text, prompt and request as today.

**Never:**
- The other deploy-flow cases (bug 45); a change to which secrets are asked about or created; secret values in any file, setting or argv; a new dependency; a floor (1.100.0) run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| NOT_SENT | local `kafka-topic-x` for A, user picks Don't create it; a later message contains it | the message shows it as is | none |
| KEPT | local value kept for B | masked in every later message, log line and result, with its base64 | none |
| TYPED | value typed for C | masked from the create request on | none |
| ECHO | the secret create fails with an error body echoing the sent value and its base64 | the shown error, the output channel and the result's message show `•••••`, not the value | the deploy stops as today |
| SHORT | a sent value of 1–3 characters echoed by the API; later the same characters in an extension message | masked in the API error's text; the extension's own message shows them as is | the deploy stops as today |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/cloudDeploy.ts` -- `ensureSecrets` :381-470: the up-front loop `for (const s of missing) … this.maskValue(v.value)` (:409-414) is the over-masking; `askSecretValue` :473-486 masks a typed value at once; the create is at :449-455 (`const secret = value; … createSecret(…)`). `maskValue` :369-374 adds the value and its base64 to `ctx.seenSecrets`.
- `src/adapters/vscode/cloudView.ts` -- `seenSecrets` :494, `secrets()` :663, `mask()` :668 (every info, error, log and tree label goes through it, :676-691, :1114-1123); the HTTP options take `secrets: () => this.secrets()` :761.
- `src/adapters/cloud/http.ts` -- `requestJson`: `mask` :51 applies to logged lines and to an error status's message and hints :75-77, the one place Cloud API text enters.
- `src/adapters/cloud/errors.ts` -- `maskCredentials` :130-141, skips values under 4 characters :133 (written for the client secret and tokens, 5.2).
- `src/adapters/vscode/cloudLogs.ts` :56, :166 -- the log-access password into `seenSecrets`; unchanged.
- Tests: `src/test/adapters/cloud/errors.test.ts` :55-70 (`maskCredentials`, `requestJson` masking; :59 asserts short values are not masked); `src/test/integration/suites/96-cloud.ts` 5.7 tests :1167-1361 (`SECRET_VALUES` :45, `fake.failures` with a `body` as at :1245, `api().outputLines()`, `allMessages`, `errors`); `src/test/helpers/fakeCloud.ts` `failures` :154, :259.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/vscode/cloudDeploy.ts` -- drop the up-front masking loop and the masking in `askSecretValue`; call `maskValue(secret)` just before `createSecret` -- only sent values are masked.
- [x] `src/adapters/cloud/errors.ts`, `src/adapters/cloud/http.ts`, `src/adapters/vscode/cloudView.ts` -- short sent values masked with no minimum in `requestJson`'s error message and hints only (for example a `minLength` option on `maskCredentials`, or a second list from `HttpOptions`), everywhere else the minimum of 4 kept.
- [x] `src/test/adapters/cloud/errors.test.ts` -- unit cases: `maskCredentials` still skips short values by default (:59 kept); `requestJson` masks a short sent value in an error's message and hints.
- [x] `src/test/integration/suites/96-cloud.ts` -- one 5.7-style test covering NOT_SENT, KEPT, TYPED and ECHO (a `fake.failures` body echoing the value and its base64 on `POST /v1/secrets`, and on the pipeline POST after a secret was created), and SHORT; each asserts on `errors`, `allMessages`, `api().outputLines()` and the result's `message`.

**Acceptance Criteria:**
- Given the change, when `maskValue` is removed or adds only the raw form, then the new integration test fails.
- Given the existing 5.7 tests and NO_LEAK, when the suite runs, then they pass unchanged.

## Implementation Notes

- Recorded by the orchestrator from the implementer's report (2026-11-09): `maskValue` is called just before `createSecret` and also adds the raw value to a new `CloudContext.sentSecrets`; `maskCredentials` takes `minLength` (default 4); `HttpOptions.sentValues` masks sent values with `minLength` 1 in an error status's message and hints only (token-endpoint errors included, Cloud API text too); log lines and URLs keep the minimum of 4. New integration test MASK_SENT; two values added to `SECRET_VALUES` so NO_LEAK covers them. The acceptance criterion was checked by breaking the code twice (the `maskValue` call removed; `maskValue` adding only the raw form): MASK_SENT failed both times; the source was restored.

## Plan Change Log

## Review Triage Log

Quick review (2026-11-09): 0 high, 0 medium, 3 low patched, 0 rejected, 0 false.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | MASK_SENT never checks `allMessages` (questions, choices, info, confirm, pick labels), against the task's "asserts on `errors`, `allMessages`, …" and the Boundary "never … in a question … after it is sent" | low | `shownSince` joins `errors`, the output and the result only; `allMessages` filled at `96-cloud.ts:238-267`, unused in the test | patch (`allMessages` since each deploy in `shownSince`) |
| 2 | `README.md:104` says the values "are masked in every message and output line", no longer true for 1–3 character values | low | the SHORT case asserts the extension's own text shows them | patch (the sentence reworded) |
| 3 | No CHANGELOG entry for a user-visible fix; earlier fix commits add one | low | `CHANGELOG.md` [Unreleased]; da15c92, 92bbdf5 | patch (one "Fixed:" line) |

## Verification

**Commands:**
- `npm run compile` -- expected: 0, lint included.
- `npm run test:corpus`; `npm run test:webview` -- expected: pass.
- `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); then `--label multiroot` -- expected: all pass. No floor run.

**Result (2026-11-09, after the review's patches, run by the orchestrator):** compile (lint included) 0, corpus 156, webview 378, stable 1360 passing (1 pending; MASK_SENT, NO_LEAK and the 5.7 tests among them), multi-root 10; `git diff --stat c8fdebd -- src/extension.ts webview/src` empty; the test settings clean; no floor run.

**Manual checks:**
- Dev host 1.143.1 on the user's cluster: a config with two missing secrets; Don't create it for one whose local value appears in the pipeline name; the name shows unmasked; the other kept, the pipeline runs.
