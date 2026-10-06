---
title: 'Binary-missing onboarding notification'
type: 'feature'
ticket: '4'
created: '2026-10-06'
status: done
baseline_revision: 'f27df112a7999236f4dde068ef01dbd6d3c4c7d9'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** When no usable Redpanda Connect binary is found, the user learns it only from a line in the "Redpanda Connect" output channel, with no way to fix it from where they are (EXPERIENCE Flow 2).

**Approach:** The RedpandaConnect adapter shows one warning notification per transition of `binaryState` into `missing` or `invalid`, through a thin injected VS Code notifier, with **Install guide** (opens the install docs), **Set path** (file picker that writes `redpandaConnect.binaryPath` and calls `refresh()`) and **Retry** (calls `refresh()`).

**Decision (invalid copy, user 2026-10-06):** the invalid variant reads "Redpanda Connect at `<path>` can't be used: `<reason>`." with plain-words reasons — e.g. "version 4.63.0 is older than the required v4.100.0", "it did not report a version", "it timed out", "it could not be started", "a relative path needs an open workspace folder" — and the same actions.

**Decision (re-check after install, user 2026-10-06):** both variants get a third action, **Retry**, which calls `refresh()`.

## Boundaries & Constraints

**Always:** The once-per-transition rule lives in the adapter (AD-9); the VS Code calls (`showWarningMessage`, `showOpenDialog`, `env.openExternal`, configuration update) sit behind a small injected interface so the rule is unit-tested without VS Code. A transition is a `binaryState` change (`onDidChange`) whose new kind is `missing` or `invalid`, including the first resolution at activation. Missing copy is exactly EXPERIENCE Voice and Tone: "Redpanda Connect binary not found. Schema, validation, graph and Run need `rpk connect` or `redpanda-connect`." Install guide opens `https://docs.redpanda.com/connect/install/` (verified 2026-10-06: "Install or Upgrade Redpanda Connect"). Set path writes the chosen file's absolute path to `redpandaConnect.binaryPath` at user (Global) scope, then calls `refresh()`; with the PATH-first order (AD-9) the setting acts as the fallback. Action labels are exactly "Install guide", "Set path" and "Retry".

**Never:** Install, upgrade or download anything; modal dialogs; notify on `ok` or on a refresh that leaves the state unchanged; touch the graph empty state (epic 3) or editor features (epic 2); add settings or commands.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MISSING_AT_ACTIVATION | Activation resolves to `missing` | One warning with the missing copy and all three actions | — |
| INVALID_OLD | Only a 4.63.0 binary found → `invalid{belowMinimum}` | One warning, invalid variant ("…can't be used: version 4.63.0 is older than the required v4.100.0."), all three actions | — |
| NO_REPEAT | Refresh leaves the state `missing` (or the same `invalid`) | No second notification | — |
| OK_SILENT | State becomes or stays `ok` | No notification | — |
| RE_TRANSITION | `ok` → `missing` later (binary removed, refresh) | A new notification | — |
| INSTALL_GUIDE | User clicks Install guide | Docs URL opened externally; state unchanged | — |
| SET_PATH_VALID | User clicks Set path, picks a valid binary | Setting written (Global), `refresh()` → `ok`, no further notification | — |
| SET_PATH_INVALID | Picks a file that is not a valid binary | Setting written, `refresh()` → `invalid`; a new notification (Flow 2 failure) | — |
| SET_PATH_CANCEL | Opens the picker, cancels | Nothing written, no refresh | — |
| RETRY_FIXED | User installed a binary on PATH, clicks Retry | `refresh()` → `ok`, no further notification | — |
| RETRY_STILL_MISSING | Clicks Retry, nothing changed | State unchanged → no new notification | — |
| DISMISSED | Notification closed without an action | Nothing happens; next transition notifies again | — |

</frozen-after-approval>

## Code Map

- `src/adapters/redpandaConnect/binary.ts` (1.3) — `RedpandaConnect` class: `state`, `onDidChange` (fires only on value change, including activation `unresolved` → `missing`/`invalid`), `refresh()` (single-flight, no spawn after `dispose()`), `scheduleRefresh()`, config listener on `redpandaConnect.binaryPath`; `BinaryState = unresolved | ok{path, version, invocation} | missing | invalid{path, reason, version?, detail?}` with reasons incl. `belowMinimum`, `nonZeroExit`, `noVersionLine`, `unparseableVersion`, `timeout`, `spawnError`, `relativePathWithoutWorkspace`. Add the notifier hook here or in a sibling `notify.ts` in the same folder.
- `src/extension.ts` (1.3) — composition root; constructs `RedpandaConnect` with the channel log, `ExtensionApi { redpandaConnect, activationResolved, outputLines() }`. Wire the real VS Code notifier here.
- `package.json` — `redpandaConnect.binaryPath` already contributed, scope `machine-overridable`; no manifest changes needed.
- Tests (1.3): mocha/tdd under `@vscode/test-cli`; fake binaries via `src/test/helpers/fakeBinary.ts` (`versionScript`, `rpkScript`, `RPK_NO_PLUGIN_SCRIPT`); state-owner tests inject environment/PATH via `RedpandaConnectOptions`. VS Code cannot read back notifications — test the rule with a fake notifier.
- UX: EXPERIENCE Voice and Tone (missing copy), State Patterns "Binary missing or invalid", Flow 2 steps 1–4 and its failure line; mock `ux-rpcn-vscode-designer/mockups/key-binary-missing.html`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/redpandaConnect/notify.ts` -- notifier interface, transition rule, copy for missing and invalid, action handling (Install guide, Set path, cancel) -- once-per-transition owned by the adapter
- [x] `src/adapters/redpandaConnect/binary.ts` -- subscribe the notifier to state changes -- single source of transitions
- [x] `src/extension.ts` -- wire the VS Code implementation of the notifier -- thin VS Code layer
- [x] `src/test/` -- unit tests for every matrix row with a fake notifier; one integration test that a `missing` activation calls the real notifier path without throwing -- matrix coverage

**Acceptance Criteria:**
- Given no binary on PATH and no setting, when the extension activates, then exactly one warning appears with "Install guide", "Set path" and "Retry".
- Given that warning, when the user picks a valid binary with Set path, then `redpandaConnect.binaryPath` holds its absolute path, `binaryState` becomes `ok` and no further warning appears, without a reload.

## Implementation Notes

- `notify.ts` has no `vscode` import: `BinaryNotifier` (showWarning / openExternal / pickBinary / setBinaryPath) plus `attachBinaryNotifications(source, notifier, log)`. Every `onDidChange` whose state has a message (`missing`, `invalid`) shows one warning; `onDidChange` already fires only on a value change (`statesEqual`, `detail` ignored), so the once-per-transition rule needs no extra bookkeeping.
- `RedpandaConnectOptions.notifier` (optional): the constructor subscribes before the first resolution, so activation's `unresolved` → `missing`/`invalid` notifies. Disposed with the adapter.
- `createVsCodeNotifier()` in `src/extension.ts`: `showWarningMessage` (non-modal), `env.openExternal`, `showOpenDialog` (single file, `file:` scheme only, absolute `fsPath`), configuration update at `ConfigurationTarget.Global`.
- Invalid copy keeps the path in backticks, like the missing copy's command names. Reasons not worded by the user: `nonZeroExit` → "its version check exited with an error", `unparseableVersion` → "it reported a version that can't be read".
- A failing action (e.g. `openExternal` rejects) is logged to the output channel, never thrown.
- Review fixes: after Set path's own refresh, a still-`missing`/`invalid` state that fired no transition (invalid on PATH still wins, rpk without its plugin, vanished path, re-picked invalid path) re-shows the warning and logs one `Set path:` line (Flow 2 failure); Retry and background refreshes stay silent on an unchanged state. `setBinaryPath` logs when a workspace/folder value overrides the user value; a non-`file:` pick is logged and treated as cancel.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-06):** 6 findings — medium 1, low 3 patched, low 2 rejected. No intent_gap or bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | After Set path the state often stays equal (PATH invalid wins, rpk without plugin, picked path gone, same invalid path), so no warning re-appears — SET_PATH_INVALID / Flow 2 failure line unmet | medium | patch | Confirmed via `fallback ??=` and `statesEqual`; only test starts from `missing` + empty PATH. Set path is an explicit user action: when the state after its `refresh()` is still `missing`/`invalid` and no transition fired, show the warning again and log what the picked path resolved to. The passive "unchanged refresh" rule still holds for Retry and background refreshes. |
| 2 | Global write shadowed by a workspace/folder `binaryPath` value | low | patch | Setting is `machine-overridable`; `refresh()` reads the effective value. After writing, if `inspect()` shows a workspace/folder value, log that it overrides the user setting. |
| 3 | Non-`file:` picked URI silently treated as cancel | low | patch | `pickBinary` returns `undefined`; log the rejection instead. |
| 4 | NOTIFY_MISSING does not exercise `activate()` wiring | low | reject | Activation runs once per test host with a valid fake; an end-to-end activation test needs a second host. Covered by the manual check. |
| 5 | "no notifications after dispose" can never fail | low | patch | `refresh()` short-circuits after dispose; test dispose while a warning is open, then click an action. |
| 6 | Integration tests open real warnings in the test host | low | reject | Cosmetic; warnings never block the tests. |

Patches 1, 2, 3, 5 applied by the re-engaged implementer. Re-verification (parent): clean `out/`, `npm run compile` exit 0, `npm test` all passing, `vsce package` ok. Not unit-tested: the workspace-override and non-local-file log lines (need a workspace with its own settings / a remote picker).

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0
- `npm test` -- expected: all tests pass, including every matrix row

**Manual checks (if no CLI):**
- With `rpk` and `redpanda-connect` off PATH, launch the Extension Development Host and open a YAML file: one warning with Install guide and Set path; Set path to a valid binary clears the problem without a reload.
