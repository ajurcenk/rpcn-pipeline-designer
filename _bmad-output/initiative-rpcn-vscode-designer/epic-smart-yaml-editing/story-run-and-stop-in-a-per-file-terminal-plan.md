---
title: 'Run and Stop in a per-file terminal'
type: 'feature'
ticket: '7'
created: '2026-10-07'
status: 'built'
baseline_revision: '10da87e239846d53d9ee4e61a9c582b108b5fe23'
route: 'full'
route_source: 'auto'
review: 'full'
review_source: 'risk'
lenses_ran: ['adversarial', 'edge-case', 'verification-gap']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/EXPERIENCE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Run and Stop have been contributed but hidden, with no handler, since 1.2. A developer still has to leave the editor to run a pipeline (CAP-11, E2 R8, AD-13, EXPERIENCE Run control).

**Approach:**
- **Run** is an editor-title action on detected files and a command. It auto-saves a dirty file, then spawns `buildRunCommand` on the 2.3 streaming runner inside a `Pseudoterminal` named "Redpanda Connect: {file name}", one per URI and reused on re-run.
- **Stop** is a status-bar item and a command. It calls `stop(grace)`: SIGINT, then SIGKILL.
- **Exit status:** when the run ends, the status-bar item shows it instead of Stop.
- **Untitled files** cannot Run, and say "Save the file to run it."

**Decisions (defaults to confirm at this checkpoint):**
- **Grace period** (the ticket's open question): 10 s. Pressing Stop again while stopping sends SIGKILL at once. The status item reads "$(loading~spin) Stopping…" in between.
- **Run while running:** a second Run on the same file stops the current run (same grace), then starts again in the same terminal. *Renegotiated 2026-10-07:* a Stop, Ctrl+C or closing the terminal during that wait cancels the restart.
- **Terminal:**
  - It starts with one dim line, `$ <command line>`, and the run's own output follows verbatim, both streams, with `\n` written as `\r\n`.
  - When the run ends it adds `Redpanda Connect exited with code N.` (or `stopped by SIGINT/SIGKILL`). The terminal stays open.
  - Ctrl+C in the terminal acts like Stop. Closing the terminal while running kills the run (SIGKILL).
  - If the user has closed the terminal, the next Run opens a new one with the same name.
- **Working directory:** the workspace folder that contains the file; with no folder, the file's directory. Relative paths inside configs resolve as they do with `rpk connect run` from the project root.
- **Status bar:** one item that follows the active editor's file.
  - While running: "$(debug-stop) Stop pipeline" (EXPERIENCE).
  - After exit: "$(pass) Pipeline exited (code 0)", "$(error) Pipeline exited (code N)", or "$(circle-slash) Pipeline stopped" after a signal. Clicking it reveals the terminal.
  - *Renegotiated 2026-10-07 (review):* any run the user stopped (Stop, Ctrl+C, closing the terminal, a re-run) shows "Pipeline stopped", and its terminal line keeps the code ("Redpanda Connect stopped (exit code 0)."), because Redpanda Connect exits 0 on SIGINT.
  - Hidden for files that have never run in this session.
- **Untitled files:** a second editor-title entry with the same play icon. It is disabled, and its title (its tooltip) is "Save the file to run it." Run from the Command Palette on an untitled file shows that text as an info message.
- **Visibility:** the context key `redpandaConnect.activeEditorDetected` (which follows the DetectionRegistry) shows Run in the editor title and the Command Palette. `redpandaConnect.activeEditorRunning` does the same for Stop. *Renegotiated 2026-10-07:* the editor-title entries follow each editor's own file through `resourcePath in redpandaConnect.detectedPaths` (paths, so remote windows match too), with `resourceScheme != untitled` / `== untitled`. The palette keeps following the focused editor.
- **No usable binary:** Run shows the binary warning again (the same copy and actions, through a `showAgain` added to `attachBinaryNotifications`, which 2.8 will reuse) and logs one line.
- **Builder failure:** Run logs the line and shows it as an error notification, because Run is user-triggered (A1).
- **Review** runs the full lens set (ticket risk is medium).

## Boundaries & Constraints

**Always:**
- **Spawn:** the argv and env are exactly `buildRunCommand(state, {targets: [fsPath]})`, run with `runStreaming([command], args, handlers, {env, cwd})`. Nothing is typed into a shell (AD-13).
- **One per URI:** each URI (AD-1 key) has at most one terminal and one child.
- **Stop:** it goes through the handle's `stop(grace)`, or `kill('SIGKILL')` on a second press.
- **Dirty files:** Run saves before spawning. If the save fails or is cancelled, nothing runs.
- **Failures:** the controller never throws into VS Code. Every failure leaves one log line.
- **Deactivation:** disposing the extension kills every running child (SIGKILL).

**Never:**
- a shell or `child_process` outside `process.ts`;
- `--chilled`, `--verbose`, or flags other than the builder's;
- forwarding stdin to the pipeline (only Ctrl+C is read);
- parsing Run logs for diagnostics or graph status;
- Show/Hide graph (epic 3);
- running files that are not detected.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| RUN | detected saved config, binary ok | terminal "Redpanda Connect: a.yaml" opens; `$ …` line, then streamed output; status shows Stop | — |
| DIRTY | unsaved changes | saved first, then run (no prompt) | save fails → no run, log line |
| STOP | Stop while running | SIGINT; the run ends; status shows exit status; terminal keeps output and exit line | — |
| STOP_ESCALATE | child ignores SIGINT | SIGKILL after 10 s, or at once on a second Stop | — |
| RERUN | Run again after exit | same terminal reused; new run appended | — |
| RERUN_RUNNING | Run while running | stop, then start in the same terminal | — |
| CLOSED_TERMINAL | user closed the terminal, then Run | new terminal with the same name | — |
| CLOSE_WHILE_RUNNING | terminal closed during a run | child killed | — |
| CTRL_C | Ctrl+C typed in the terminal | same as Stop | — |
| EXIT_STATUS | run exits 1 by itself | "$(error) Pipeline exited (code 1)"; terminal line `…exited with code 1.` | — |
| UNTITLED | untitled detected file | editor title shows the disabled entry titled "Save the file to run it."; palette Run shows that message | — |
| NOT_DETECTED | non-Redpanda-Connect YAML | no Run in editor title or palette | — |
| NO_BINARY | binary missing | binary warning shown again; one log line; no terminal | — |
| BUILDER_FAIL | relative `resourceFiles` entry, no workspace | error notification with the builder's message; log line; no terminal | — |
| SPAWN_FAIL | binary vanished since resolution | terminal shows `Could not start Redpanda Connect: …`; status shows failed | — |
| TWO_FILES | two configs running | two terminals; the status item follows the active editor's file | — |
| DISPOSE | extension deactivates while running | children killed | — |

</frozen-after-approval>

## Code Map

- `package.json`:
  - commands `redpandaConnect.run` and `redpandaConnect.stop`, with `menus.commandPalette` `when: false` (since 1.2);
  - add `icon`s, `editor/title` entries and `when` clauses on the context keys;
  - add a hidden `redpandaConnect.runUntitled` (`enablement: false`, title "Save the file to run it.").
- `src/adapters/redpandaConnect/process.ts`: `runStreaming(invocation, args, handlers, {env, cwd})` returns a `StreamingChild {exited, kill, stop}` (2.3).
- `src/adapters/redpandaConnect/args.ts`: `buildRunCommand(state, {targets})` returns an `ArgsResult` (`run --set http.enabled=false …`); `describeArgsFailure`.
- `src/adapters/redpandaConnect/notify.ts`: `attachBinaryNotifications(source, notifier, log)` returns a subscription. Extend it to also return `showAgain()`, and have `binary.ts` / `extension.ts` expose it.
- `src/adapters/vscode/detection.ts`: `isDetected`, `onDidChangeDetection`.
- `src/extension.ts`: composition root; `ExtensionApi` for tests.
- `src/test/helpers/fakeBinary.ts`: `connectScript` gains a `run` body (a waiter that prints, traps INT).
- New: `src/adapters/vscode/run.ts` (`RunController`: terminals, children, status item, context keys, commands).

## Tasks & Acceptance

**Execution:**
- [x] `package.json`: commands, icons, editor-title and palette `when` clauses, the untitled entry. Contributions.
- [x] `src/adapters/vscode/run.ts`: `RunController` with injectable terminal, status-bar and runner seams. Run and Stop.
- [x] `src/adapters/redpandaConnect/notify.ts`, `binary.ts`, `src/extension.ts`: `showAgain`, wiring, `ExtensionApi.run`. Composition.
- [x] `src/test/`: unit tests for every matrix row with fakes; integration tests with a fake binary for RUN, STOP, RERUN, UNTITLED and NO_BINARY. Coverage.
- [x] `README.md`, `CHANGELOG.md`: Run and Stop. Docs.

**Acceptance Criteria:**
- Given the generate-to-stdout fixture `test/corpus/fixtures/run_generate.yaml` (the corpus itself has none that runs without external services) and a real binary, when Run is clicked, then its output streams into "Redpanda Connect: {file}"; Stop ends it with the exit status shown; a second Run reuses the terminal.
- Given an untitled file with Redpanda Connect content, then Run is unavailable and the editor title shows "Save the file to run it."

## Implementation Notes

- **`RunController`** (`src/adapters/vscode/run.ts`) keeps one `Session` per URI: `{terminal, pty, child, phase, exit, busy, stopRequested, restartCancelled}`.
- **`RunPty`** buffers writes until VS Code calls `open()` and writes `\n` as `\r\n`. It reads only `\x03` and reports `close()`. A close during dispose does not kill a second time.
- **Seams:** `RunHost` (terminal, status item, active document, messages, `setContext`, `cwdFor`), `build` and `spawn` are injectable. The controller registers the four commands; `revealRun` is not contributed.
- **Notifications:** `attachBinaryNotifications` now returns `showAgain(state)`, and `RedpandaConnect.showBinaryWarning()` calls it for the current state, with the same copy and actions. A Run made while the state is `unresolved` first waits for `refresh()`.
- **Messages:** a non-`file` scheme gets "Run needs a file on disk." A Run while one is being prepared is logged and ignored.
- **`DetectionRegistry.detectedUris()`** is added for the editor-title path list.
- **Real binary** (4.112.0, `test/corpus/fixtures/run_generate.yaml`, through `runStreaming` with `buildRunArgs`, parent, scratchpad script):
  - `tick` arrived after 227 ms;
  - `stop(10000)` ended the run in 10 ms with `{exitCode: 0, signal: null}`;
  - the last log line was "Received SIGINT, the service is closing".

  The adversarial reviewer saw the same for `/usr/bin/rpk connect run`: rpk execs in place, so there is no grandchild.
- **Not run:** the UI check in the Extension Development Host with the real binary.
- **Known limit (multi-root):** relative `resourceFiles` / `envFile` resolve against the first workspace folder (the builder, 1.5), while the working directory is the file's folder. Recorded in the README.

## Plan Change Log

- 2026-10-07 (review, human renegotiation):
  - A run the user stopped shows "Pipeline stopped".
  - A Stop during a re-run's wait cancels the restart.
  - The editor-title buttons follow each editor's file through a path list.

## Review Triage Log

**Pass 1 (full: adversarial + edge-case, verification-gap; 2026-10-07):** 20 findings (deduplicated).
- **Decided by the human:** 3.
- **Patched:** 16.
- **Recorded limit:** 1.
- No rejections.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| A1 | A normal Stop showed "exited (code 0)" (Redpanda Connect exits 0 on SIGINT) | medium | intent_gap → human | `stopRequested`; "Pipeline stopped" and "stopped (exit code 0)"; tests. |
| A2 | A Stop or close during a re-run's wait did not cancel the restart | medium | intent_gap → human | `restartCancelled`; tests for both. |
| A5 / V11 | Editor-title buttons followed the focused editor in split views | low | bad_plan → human | `resourcePath in redpandaConnect.detectedPaths`; contributions test. |
| A3 | Run before the first resolution did nothing visible | medium | patch | `refresh()` when `unresolved`; test. |
| A4 | `resourceScheme == file` hides Run in remote windows | medium | patch | Path list plus `resourceScheme != untitled` (not tried in a remote window). |
| A6 | Non-file schemes got the untitled message | low | patch | "Run needs a file on disk."; test. |
| A7 | Multi-root: settings vs working directory use different folders | low | intent_gap → recorded limit | README and Implementation Notes. |
| A8 | Extra Runs while busy were silent | low | patch | Log line; test. |
| V1 | Contributions (`when`, icons, enablement, untitled title) untested | medium | patch | Integration test reads `packageJSON`. |
| V2 | Production grace (10 s) never asserted | medium | patch | Test without `graceMs`. |
| V3 | Escalation by the grace alone untested at controller level | low | patch | The fake child escalates on a timer like the real one; test. |
| V4 | Writes before `open()` never exercised | medium | patch | Deferred-open fake; test includes the `$` line. |
| V5 | Slow old child during a re-run untested | low | patch | Covered by the A2 tests (`intDelayMs`). |
| V6 | `showAgain` / `showBinaryWarning` untested | medium | patch | Notify tests: same copy and actions, its Set path works, `false` for ok, disposed, no notifier. |
| V7 | Integration UNTITLED could pass vacuously | low | patch | Positive control: the same content saved runs. |
| V8 | Real-binary acceptance not automated | medium | intent_gap → recorded | The runner and builder were run against the real binary and recorded above; the UI check is still manual. |
| V9 | Integration checked only part of the argv | low | patch | Full `$*` asserted. |
| V10 | The `exited with code 1.` terminal line was not asserted | low | patch | Asserted. |
| V12 | Detection change did not refresh the context keys in tests | low | patch | Test. |

**Re-verification (parent):** `npm test` 404 passing on two runs; `npm run test:corpus` 65 passed.

## Verification

**Commands:**
- `npm run compile`: exit 0.
- `npm test`: all pass.
- `npm run test:corpus`: 65 passed.

**Manual checks (if no CLI):**
- In the Extension Development Host with a real binary, Run `test/corpus/fixtures/run_generate.yaml`: output streams, Stop ends it, the exit status shows, and Run again reuses the terminal.
