---
title: 'The Enterprise license is documented and its state shown in the Environment view'
type: 'feature'
ticket: '38'
created: '2026-10-29'
status: done
baseline_revision: '5cac67019569e8aef74cd3b2eb34d72038913391'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Enterprise connectors need a license the binary finds by itself (`REDPANDA_LICENSE`, else the file in `REDPANDA_LICENSE_FILEPATH`, else `/etc/redpanda/redpanda.license`); the extension passes its environment so all three work, but nothing says how to set them up in VS Code, and nothing shows whether a license loads (the binary says so only in a `run`'s startup log).

**Approach:** The README gets a license section. The Environment view gets a **License** group for its config: where the binary would take the license from (the source, worked out from the config's environment), and, after **Check license**, the binary's answer: loaded (type, expiry), failed (its reason), or none. The check runs a tiny config with `run` and the config's command line and environment, reads the log line, and keeps the result until the next check.

**Decisions (user, 2026-10-29):** the License group in the Environment view; on demand only (no background runs); type and expiry shown, `license_org` left out.

**Decision (user, 2026-10-29, during implementation):** the binary reads `REDPANDA_LICENSE` and `REDPANDA_LICENSE_FILEPATH` only from its process environment, not from an `--env-file` (probed on 4.100.0 and 4.112.0), so a license is set as a secret variable or in VS Code's environment; `redpandaConnect.env` and the env file setting either name get a warning row that it is not used. How variables reach the commands is not changed for them.

## Boundaries & Constraints

**Always:**
- The check's command line is the commands' own (`buildCommandLine(buildRunArgs, …)` with the config's settings: `--env-file`s, secrets, `NO_COLOR`), so its answer is the one Run gets; its temp config is written in the extension's storage and removed on every path.
- The license string is never shown, logged or written; the check's text is masked like other binary output (`activeSecretValues`); `license_org` is dropped.
- Unit-tested pure parts: the log-line reading and the source resolution.

**Never:**
- `--redpanda-license` in any argv; a change to how variables reach the commands, their precedence or the view's other groups; background or automatic checks.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| NOT_CHECKED | a config shown, no check yet | License group: the source row, and "Not checked" with the Check license action | none |
| SOURCE_STRING | `REDPANDA_LICENSE` set by a secret or VS Code's environment | source row: `REDPANDA_LICENSE` from that source, value masked | none |
| NOT_READ | `redpandaConnect.env` or the env file sets `REDPANDA_LICENSE` or `REDPANDA_LICENSE_FILEPATH` | a warning row: that name there is not used for the license | none |
| SOURCE_FILE | no string; `REDPANDA_LICENSE_FILEPATH=/p` | source row: the file `/p` (and from which source) | none |
| SOURCE_DEFAULT | neither; `/etc/redpanda/redpanda.license` exists | source row: the default file | none |
| SOURCE_NONE | neither, no default file | "No license set": enterprise connectors need one; opens the README section | none |
| LOADED | check; the log says `Successfully loaded Redpanda license … expires_at=… license_type=…` | "Loaded: <type>, expires <date>" (no org) | none |
| FAILED | check; `Failed to read Redpanda License … error="…"` | "Not loaded: <reason>" (masked) | none |
| NO_LINE | check; no license line (no source) | "No license loaded" | none |
| CHECK_FAILS | the binary is missing, the command line fails, or the run times out | the reason in the group (as the view's other notes); nothing logged with a value | none |
| KEPT | check done, then the view refreshes or another config shows and comes back | that config's last result stays until its next check | none |
| NO_FLAG | lint, Run, live parse, test panel, the check | no `--redpanda-license` in any argv | none |

</frozen-after-approval>

## Code Map

- `src/core/` (new `licenseLog.ts`) -- pure: read a run's stderr for the license line (`level=info msg="Successfully loaded Redpanda license" … expires_at="…" … license_type=…`, or `level=error msg="Failed to read Redpanda License" … error="…"`, logfmt with quoted values); returns loaded {type, expiresAt} / failed {reason} / none. Probed lines are in the ticket's Notes. Unit tests in `src/test/core/`.
- `src/adapters/vscode/environmentModel.ts` -- `environmentModel(inputs)` and `EnvironmentInputs` (setting, secrets, env file read, `processEnv`). Add a pure license source resolution beside it (the first of: `REDPANDA_LICENSE` from the strongest source that sets it, `REDPANDA_LICENSE_FILEPATH` likewise, the default file if it exists — its existence passed in). Do not add the two names to `usage` (they would show as Missing).
- `src/adapters/redpandaConnect/bloblangRunner.ts` (~:75-110, `runMappingTest`) -- the pattern for the check: temp YAML in the storage dir, `buildCommandLine(buildRunArgs, state, [file], settings)`, `runProcess(..., timeout, spawnOptions(built))`, remove in `finally`. The settings for a config: `commandSettings(() => defaultArgsEnvironment(uri))` (`args.ts:85`, as `bloblang.ts:118`). A config that ends at once: `generate` with `count: 1`, `interval: ""`, `output: drop: {}`. Put the check in a new `src/adapters/redpandaConnect/license.ts`.
- `src/adapters/vscode/environmentView.ts` -- groups and items (`EnvironmentNode` ~:78, `getChildren` ~:312, `groupItem` ~:377, `items()` the test seam ~:289, `stateText`/notes); register `redpandaConnect.environment.checkLicense` in `register()` (~:238) and keep results per config URI (not cleared by `refresh`). The README link: open the README's license section (the repository URL in `package.json` + the heading anchor).
- `package.json` -- the command (title "Check license", icon), inline on the License group (`view/item/context`, by `contextValue`) and hidden from the palette unless a config is shown, like the view's other commands.
- `src/extension.ts` -- pass what the view needs (state of the binary, storage dir); the `environment` test seam already exposes `items()` / `model()`.
- Tests: suite `src/test/integration/suites/95-environment-view.ts` with its fake binary (`src/test/helpers/fakeBinary.ts` `connectScript`, a `run` body that prints the license line by `REDPANDA_LICENSE` / `REDPANDA_LICENSE_FILEPATH` and captures argv) for every matrix row; unit tests for the parse and the resolution.
- Docs: `README.md` (a License section: the order, how to set each in the extension, never the string in `redpandaConnect.env` or a committed env file, the License group), `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/licenseLog.ts` + unit tests -- the parse.
- [x] License source resolution (pure, beside the model) + unit tests.
- [x] `src/adapters/redpandaConnect/license.ts` -- the check.
- [x] `environmentView.ts`, `package.json`, `extension.ts` -- the License group, the command, per-config results.
- [x] Suite 95 -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass and tickets 31-34's tests are unchanged.
- Given any check, when its argv, the view's items, the output channel and messages are read, then none holds a license string.

## Implementation Notes

- Probed 2026-10-29 on 4.100.0 and 4.112.0: `REDPANDA_LICENSE` / `REDPANDA_LICENSE_FILEPATH` in an `--env-file` (so in `redpandaConnect.env` or the `envFile` file) do **not** reach the binary's license lookup; only its process environment does (secrets, VS Code's environment). The source resolution therefore reads secrets over VS Code's environment only, and the License group adds a warning row ("… is not used for the license") when the setting or the env file sets either name; the README documents the string as a secret and a file path as a secret or VS Code's environment. This differs from SOURCE_STRING's "(or the setting, env file …)" and the ticket's AC 1 wording.
- The License group is a `licenseGroup` node (not a `group` of a variable source), so ticket 31's group-list assertions are unchanged. The check's config also sets `http.enabled: false` (no port 4195 taken) and logfmt at INFO.
- `EnvironmentItem` gained an optional `command` (the item's click/Enter command) for the seam.

## Review Triage Log

Quick review. Verdicts: 0 high, 2 medium, 4 low, 0 false. No path puts a license string in the check's argv, its temp config, the License group's labels, messages or log lines; `license_org` is never read.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | A `REDPANDA_LICENSE` from `redpandaConnect.env` shows in clear in the Settings row, its accessibility label and the hover (ticket AC 5) | medium | patch | Real: setting values are plain (`masksValue`). The name `REDPANDA_LICENSE` is masked in every group and the hover (Show value reveals it); other names unchanged. A change to the other groups for that one name, which the ticket's AC 5 asks over the plan's "Never". |
| 2 | Each check writes the env file generated from `redpandaConnect.env`, which can hold a license string | low | noted | Ticket 29's file (owner-only, in global storage), written by lint and Run alike; a license there is not used and is flagged (NOT_READ). |
| 3 | A `REDPANDA_LICENSE_FILEPATH` from a secret or VS Code's environment shows in clear in the source row, while the state row masks it | medium | patch | Real: `licenseSourceText`. The path shows only from an unmasked source. |
| 4 | Tooltips are not checked for a license string | low | patch | The seam exposes the tooltip; `assertNoValue` covers it. |
| 5 | A throw after "Checking…" leaves the state stuck | low | patch | Stores an error state with a masked reason. |
| 6 | The secret clash line says the setting or env file "wins" for the license names | low | patch | For those two names the line says the secret is the one the license uses. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone) -- expected: all pass.
- `xvfb-run -a npx vscode-test --label multiroot`, `npm run test:corpus`, `npm run test:webview` -- expected: pass.

**Manual checks:**
- Dev host on 1.143.1 with the real 4.112.0 binary: the machine's default `/etc/redpanda/redpanda.license` (LOADED, with type and expiry, no org); a bad `REDPANDA_LICENSE` secret (FAILED); `REDPANDA_LICENSE_FILEPATH` to a missing file (FAILED); keyboard and screen reader on the group.

Result (2026-10-29, after the review patches): stable 1081 passing (every License group test ran and passed); multiroot 8 passing; corpus 156 passed; webview 318 passed. Manual check: done by the user on the 1.143.1 dev host with the real 4.112.0 binary and the machine's default license (2026-10-29), `.vscode-test/manual-license`, no issues. The user noted that a declared secret with no value has no Remove action in the view (only the value can be removed there; the name is removed by editing `redpandaConnect.secretEnv`): offered as a follow-up story.
