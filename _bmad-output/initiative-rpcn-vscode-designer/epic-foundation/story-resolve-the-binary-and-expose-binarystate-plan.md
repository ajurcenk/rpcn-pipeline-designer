---
title: 'Resolve the binary and expose binaryState'
type: 'feature'
ticket: '3'
created: '2026-10-06'
status: done
baseline_revision: '545176eea09d786738c6cf6178109bdffed2fbb0'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The extension only runs `--version` once at activation on `binaryPath` or `redpanda-connect`; it has no AD-9 resolution order, no version floor, and no observable state that tickets 1.4 (notification), 1.5 (argument builder) and 1.6 (schema) can react to.

**Approach:** Turn the RedpandaConnect adapter into the single owner of binary resolution: resolve in AD-9 order, parse and check the version against v4.100.0, publish an observable `binaryState` with `onDidChange`, and re-resolve on activation, on `redpandaConnect.binaryPath` change, and on `refresh()`; it stays the only module that spawns.

**Decision (relative / `~` paths, user 2026-10-06):** a leading `~` in `binaryPath` expands to the home directory; a relative path resolves against the first workspace folder; with no workspace folder a relative path is `invalid{reason relativePathWithoutWorkspace}`.

**Decision (bare name in `binaryPath`, user 2026-10-06, from review pass 1):** a value with no path separator and no leading `~` (e.g. `redpanda-connect`, `rpk`) is a command name looked up on PATH, as in ticket 1.2; only values containing `/` or `\`, or starting with `~`, are paths (and only those follow the relative-path rule).

**Decision (resolution order, user 2026-10-06, renegotiated during review pass 1):** PATH first — `rpk connect`, then `redpanda-connect` — and `redpandaConnect.binaryPath` only as a fallback when PATH has no usable binary. This replaces the earlier "setting always wins" order; the setting's own path rules (bare name on PATH, `~`, relative to workspace) are unchanged.

**Decision (rpk without plugin, user 2026-10-06):** when `rpk connect --version` reports the plugin is not installed, resolution falls through to `redpanda-connect` on PATH; if nothing is found the state is `missing` and the log line says rpk was found but `rpk connect install` has not been run.

## Boundaries & Constraints

**Always:** Resolution order — `rpk` on PATH run as `rpk connect` > `redpanda-connect` on PATH > `redpandaConnect.binaryPath` as a fallback, used only when PATH yields no `ok` binary; when the setting is unset or also fails, the result is the first `invalid` seen (PATH before setting) or `missing`. A setting whose binary is named `rpk` runs as `[path, 'connect']`. `binaryState` is `unresolved | ok{path, version, invocation} | missing | invalid{path, reason, version?}`; `invocation` is the argv prefix later tickets spawn with (`[path]` or `[rpkPath, 'connect']`). Version parse `^Version: v?(\d+)\.(\d+)\.(\d+)(-\S+)?$`; below 4.100.0 (pre-releases sort below their release) is `invalid` with reason `belowMinimum`. `onDidChange` fires only when the state value changes. `refresh()` is single-flight: concurrent calls share one run, and a trigger arriving mid-run schedules exactly one more. Every child gets `NO_COLOR=1`, no shell, a timeout. Each state change is logged once to the "Redpanda Connect" channel. Pure parsing and comparison live in `src/core`.

**Never:** Run `rpk connect install`/`upgrade` or anything that downloads; show notifications (ticket 1.4); build lint/run arguments (1.5); generate schema (1.6); add new settings or commands; let any other module spawn.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PATH_WINS | usable `rpk` or `redpanda-connect` on PATH and `binaryPath` set | PATH binary used; setting ignored | — |
| PATH_INVALID_FALLBACK | only an old `redpanda-connect` (4.63.0) on PATH; `binaryPath` → 4.112.0 | `ok` from the setting | — |
| SETTING_RPK | nothing on PATH; `binaryPath` → an `rpk` binary | `invocation [path, 'connect']` | — |
| SETTING_OK | nothing on PATH; `binaryPath` → binary printing `Version: 4.112.0` | `ok{version 4.112.0, invocation [path]}` | — |
| SETTING_V_PREFIX | `binaryPath` → binary printing `Version: v4.100.0` | `ok{version 4.100.0}` | — |
| SETTING_OLD | `binaryPath` → binary printing `Version: 4.63.0` | `invalid{reason belowMinimum, version 4.63.0}` | — |
| SETTING_MISSING | `binaryPath` → nonexistent file | `missing` | — |
| SETTING_BAD | `binaryPath` → exits non-zero / no Version line / times out | `invalid{reason …}` | Never throws |
| RPK_OK | no setting; `rpk connect --version` prints `Version: 4.112.0` | `ok{invocation [rpk, 'connect']}` | — |
| RPK_NO_PLUGIN | no setting; `rpk connect --version` exits 0 with `cannot get connect version: rpk connect is not installed…` | falls through to `redpanda-connect` | — |
| STANDALONE_OK | no setting, no usable rpk; `redpanda-connect` on PATH | `ok{invocation [path]}` | — |
| NOTHING | none of the above | `missing` | — |
| SETTING_TILDE | `binaryPath` `~/bin/rc` | resolved to `$HOME/bin/rc` | — |
| SETTING_RELATIVE | `binaryPath` `bin/rc`, workspace open | resolved against the first workspace folder | — |
| SETTING_BARE_NAME | `binaryPath` `redpanda-connect` (no separator) | looked up on PATH; `missing` if not found there | — |
| SETTING_RELATIVE_NO_WS | `binaryPath` `bin/rc`, no workspace folder | `invalid{reason relativePathWithoutWorkspace}` | — |
| SETTING_CHANGED | `binaryPath` changed at runtime | state re-resolved; `onDidChange` fires; no reload | — |
| SAME_STATE | refresh with nothing changed | no `onDidChange` event | — |
| CONCURRENT | two `refresh()` calls overlap | one resolution run; both get its result | — |

</frozen-after-approval>

## Code Map

- `src/adapters/redpandaConnect/version.ts` (1.2) — `resolveBinary`, `findOnPath` (bare name + `.exe` on win32), `readVersion` (spawn `--version`, `NO_COLOR=1`, `shell: false`, timeout resolves in the timer, ENOENT → notFound only if the path does not exist), `describeVersionResult`, `checkConfiguredBinaryVersion(log)`. Reuse `findOnPath` and the spawn/timeout logic; `readVersion` must accept an argv prefix so `rpk connect --version` runs without a shell.
- `src/core/version.ts` (1.2) — `parseVersionOutput()` keeps the version as printed (`v4.100.0`). Extend in core: numeric parse with optional `v` and pre-release, comparison, `MIN_VERSION = 4.100.0`.
- `src/extension.ts` (1.2) — creates the channel, calls `checkConfiguredBinaryVersion(log)`, returns `ExtensionApi { versionChecked, outputLines() }`; keep `outputLines()`; replace `versionChecked` with access to the adapter's state for tests.
- Tests (1.2): mocha/tdd under `@vscode/test-cli`; fake binaries via `src/test/helpers/fakeBinary.ts` (`makeTempDir`, `writeFakeBinary`, `VERSION_4_112_SCRIPT`); integration test sets `binaryPath` globally and opens a YAML file.
- Spike facts: version stdout `Version: 4.112.0` / `Date: …`, exit 0, identical for rpk; the local standalone build prints `Version: v4.100.0`. rpk with no managed plugin (verified 2026-10-06 with isolated `HOME`/`PATH`): exit 0, stdout `cannot get connect version: rpk connect is not installed; run 'rpk connect install'` followed by help, nothing downloaded. rpk finds its plugin `.rpk.managed-connect` via `$HOME/.local/bin` or PATH.
- `package.json` already contributes `redpandaConnect.binaryPath`; do not add settings.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/version.ts` -- numeric version parse (optional `v`, pre-release), compare, `MIN_VERSION`, floor check -- pure, unit-tested
- [x] `src/adapters/redpandaConnect/binary.ts` -- `RedpandaConnect` class: AD-9 resolution, `state`, `onDidChange`, single-flight `refresh()`, config-change listener, disposable -- single owner of binaryState
- [x] `src/adapters/redpandaConnect/version.ts` -- generalize `readVersion` to an argv prefix; keep it the only spawn site -- rpk invocation without a shell
- [x] `src/extension.ts` -- construct `RedpandaConnect` with the channel log, refresh on activation, expose it on `ExtensionApi`, log each state change -- composition root
- [x] `src/test/` -- core unit tests, adapter tests for every matrix row (fake `rpk` and `redpanda-connect` scripts on a temp PATH), integration test flipping `binaryPath` between ok, missing and invalid -- matrix coverage

**Acceptance Criteria:**
- Given the Extension Development Host, when `redpandaConnect.binaryPath` is changed between a valid, a missing and a too-old binary, then `binaryState` becomes `ok`, `missing` and `invalid` in turn without a reload, and each change is logged once.
- Given the source tree, when it is searched for `child_process` imports, then the only match is the spawn site in `src/adapters/redpandaConnect/`.

## Implementation Notes

- `src/core/version.ts`: `parseVersion` (`^v?(\d+)\.(\d+)\.(\d+)(-\S+)?$` on the token after `Version: `), `formatVersion` (no `v`), `compareVersions` (pre-release below release, SemVer identifier order between pre-releases), `MIN_VERSION`, `meetsMinimum`, `isRpkConnectNotInstalled`. `parseVersionOutput` is unchanged.
- `src/adapters/redpandaConnect/version.ts` is now only the spawn site: `findOnPath` and `readVersion(invocation, timeoutMs)` returning a raw `VersionProbe` (`exited | timeout | notFound | spawnError`). `resolveBinary`, `checkConfiguredBinaryVersion` and `describeVersionResult` were removed (superseded by `binary.ts`); their test file `src/test/describeVersionResult.test.ts` was deleted.
- `src/adapters/redpandaConnect/binary.ts`: `resolveBinaryState(env)` (pure inputs: setting, PATH, home, workspace folder) and the `RedpandaConnect` class (`state`, `onDidChange`, `refresh()`, `scheduleRefresh()`, `dispose()`). `refresh()` joins an in-flight run; `scheduleRefresh()` (used by the `redpandaConnect.binaryPath` config listener) queues exactly one more run when a run is in progress. The joined promise covers the queued run, so every caller gets the final state.
- `invalid` carries an optional `detail` (exit code + first stderr line, timeout, spawn error) for the log line; it takes part in state equality. Extra reasons beyond the matrix: `nonZeroExit`, `noVersionLine`, `unparseableVersion` (`Version: dev`), `timeout`, `spawnError`.
- Judgement calls not fixed by the plan: (1) Order per the renegotiated decision: `rpk` on PATH, then `redpanda-connect` on PATH, then `binaryPath` only when neither is `ok`. Any unusable PATH candidate (not only rpk without its plugin) falls through to the next one; if nothing is `ok`, the first `invalid` seen (rpk, standalone, then setting) is the state, else `missing`. rpk without its plugin counts as not found, and its hint is appended to the final log line whether that is `missing` or `invalid`; likewise a `binaryPath` rpk without its plugin adds its hint to a PATH `invalid` line. Any binary (PATH or setting) whose basename is `rpk`/`rpk.exe` runs as `[path, 'connect']`. The `missing` line names both the PATH outcome and the setting outcome. (2) Superseded by the bare-name decision: a `binaryPath` without `/` or `\\` and without a leading `~` is a command name looked up on PATH (as in 1.2), `missing` if not found; the found binary follows the rpk rule in (1), so a bare `rpk` runs as `rpk connect` (in practice a bare `rpk` is already covered by the PATH pass). (3) `missing` has no fields, so changing `binaryPath` from one missing path to another fires no event; the new message is still logged: a line is logged on every state change and, while `missing`, whenever the message differs from the last logged one (an unchanged `invalid` with varying detail is not re-logged). `invalid.detail` is excluded from state equality. After `dispose()`, `refresh()` returns the current state without spawning. When rpk lacks its plugin and `redpanda-connect` is `invalid`, the log line appends the rpk-not-installed hint. (4) A change of workspace folders does not re-resolve a relative `binaryPath`; only activation, the setting change and `refresh()` do.
- `src/extension.ts`: `ExtensionApi` is now `{ redpandaConnect, activationResolved, outputLines() }` (`versionChecked` removed).
- `package.json` / README: the `binaryPath` description now states the `~`, relative and rpk-then-standalone rules (text only; no settings added).

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-06):** 7 findings — medium 2, low 3, false 1, rejected-low 1. Contains an **intent_gap** → loopback to the human; lower entries are moot until it is resolved.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Bare name in `binaryPath` (e.g. `redpanda-connect`) now resolves against the workspace instead of PATH; 1.2 looked it up on PATH | medium | intent_gap | Confirmed: 1.2 doc comment "A setting without a path separator is treated as a command name and looked up on PATH too" and its test were removed. The frozen decision "a relative path resolves against the first workspace folder" has two readings for a bare name. |
| 2 | rpk-not-installed hint not logged on `missing` → `missing` | medium | patch (pending loopback) | Confirmed: `statesEqual` treats all `missing` as equal, so `runOnce` skips `log(message)`. Fix: log when the message changes, without firing an event. |
| 3 | `invalid.detail` (varying stderr) counts toward equality → spurious events | low | patch (pending loopback) | Confirmed at `statesEqual` line 242. Fix: exclude `detail` from equality. |
| 4 | rpk hint dropped when standalone is `invalid` | low | patch (pending loopback) | `rpkWithoutPlugin` unused on that branch; append the hint to the message. |
| 5 | First `file:` workspace folder chosen, not first folder | low | reject | A non-`file:` folder cannot host a local binary; the choice only matters in rare remote multi-root setups. |
| 6 | `child_process` appears in comments, so a literal grep returns more than one hit | false | reject | The AC is about imports; the only import is `version.ts:5`. |
| 7 | `refresh()` after `dispose()` still spawns | low | patch (pending loopback) | `refresh()` does not check `disposed`; add a guard. |

Resolution: the human answered the intent gap (bare name → PATH, decision added to the frozen block) and chose to fix #1 together with #2, #3, #4 and #7 in one patch round instead of revert-and-re-derive; a second review pass follows.

**Pass 2 (quick, 2026-10-06, after the PATH-first order change):** 4 findings — low 2 patched, low 2 rejected. No intent_gap or bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Same `invalid` state logged again when `detail` varies | low | patch | `runOnce` logs on message change; `detail` is in the message but not in `statesEqual`; the `$$` test checks only events. Log on state change, or on message change only for `missing`; assert `lines`. |
| 2 | `~name` / `~user/...` not expanded, treated as workspace-relative | low | reject | `~user` paths in a VS Code setting are rare; supporting them adds a branch. |
| 3 | rpk-not-installed hint for an rpk `binaryPath` lost when PATH had an invalid binary | low | patch | `settingNote` only reaches the `missing` line; append it to the fallback `invalid` line too; add a test. |
| 4 | Integration test strips whole PATH directories in the shared extension host | low | reject | Test-only; fake binaries use `/bin/sh` builtins; CI passes. Narrowing it needs a test-only environment hook. |


Pass 2 patches 1 and 3 applied by the re-engaged implementer. Re-verification (parent): clean `out/`, `npm run compile` exit 0, `npm test` all passing, `vsce package` ok.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (type-check, lint, bundle)
- `npm test` -- expected: all tests pass, including every matrix row

**Manual checks (if no CLI):**
- In the Extension Development Host, change `redpandaConnect.binaryPath` in Settings and watch the "Redpanda Connect" channel log the new state without a reload.
