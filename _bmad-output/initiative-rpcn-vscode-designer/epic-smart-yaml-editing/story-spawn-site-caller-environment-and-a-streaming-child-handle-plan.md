---
title: 'Spawn site: caller environment and a streaming child handle'
type: 'feature'
ticket: '3'
created: '2026-10-07'
status: done
baseline_revision: 'b712737823a5d63389b95321770015ef2b0e5380'
route: 'full'
route_source: 'auto'
review: 'full'
review_source: 'risk'
lenses_ran: ['adversarial', 'edge-case', 'verification-gap']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The single spawn site (`process.ts`) only runs buffered, timeout-killed one-shot processes with its own `process.env`. Lint (2.4) needs the builder's `{command, args, env}` to reach the child, and Run (2.7) needs a long-lived child whose output streams into a terminal and that Stop can signal (retro F1, AD-13).

**Approach:** Extend `process.ts`, still the only `child_process` import and still free of `vscode`: the one-shot runner takes an optional caller `env` (and `cwd`), and a new streaming runner returns a handle with output callbacks, an exit promise, `kill(signal)` and `stop(graceMs)` (SIGINT, then SIGKILL after the grace period). Existing callers keep their behavior byte for byte.

**Decision (defaults to confirm at this checkpoint):**
- `stop(graceMs)` lives on the handle (the spawn site owns the child), so 2.7 only picks the grace period. SIGINT exits 0 per the spike; SIGKILL is the fallback.
- The builder's unused `detectedResourceFiles` input is removed here (E2 Notes: "first ticket that calls the builder"), with its failure role and tests.
- An optional `cwd` passes through unchanged; which directory Run uses is 2.7's decision.
- Review runs the full lens set (ticket risk medium, retro A6).

## Boundaries & Constraints

**Always:** `NO_COLOR=1` is forced on top of whatever env the caller passes (a caller's `NO_COLOR=0` loses); no env → `process.env` as today. No shell. The one-shot runner keeps stdin ignored, its timeout, `ProcessOutcome` shapes and the resolve-on-`close` / resolve-on-timeout rules. The streaming runner: stdin ignored; stdout and stderr delivered as UTF-8 string chunks in arrival order per stream, as they arrive (no buffering until exit, no line splitting); `exited` resolves exactly once with `{kind: 'exited', exitCode, signal}`, `{kind: 'notFound'}` or `{kind: 'spawnError', message}` and never rejects; `kill` and `stop` after exit are no-ops; `stop` resolves with the exit and clears its timer when the child exits during the grace period. `notFound` / `spawnError` use the existing `spawnFailure` rules. Everything is testable in plain Node (the corpus harness imports this module).

**Never:** `vscode` imports in `process.ts`; a second module importing `child_process`; Pseudoterminal, status bar, Run/Stop commands or lint wiring (2.4, 2.7); stdin forwarding; process groups or killing grandchildren (`rpk connect` execs in place, spike); Windows signal handling (backlog); changing log or notification text.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CALLER_ENV | one-shot run with `env: {FOO: 'bar', NO_COLOR: '0'}` | child sees `FOO=bar`, `NO_COLOR=1`, and not the parent's other variables | — |
| DEFAULT_ENV | existing callers (`readVersion`, `runList`, corpus harness) | unchanged: `process.env` + `NO_COLOR=1`; existing suite and corpus pass | — |
| CWD | `cwd: <dir>` | child's working directory is `<dir>` | — |
| STREAM_BEFORE_EXIT | child prints `tick`, then waits | stdout callback gets `tick` while the child is still running | — |
| STREAM_STDERR | child writes to stderr | stderr callback gets it, separately from stdout | — |
| EXIT_CODE | child exits 3 | `exited` → `{exitCode: 3, signal: null}` | — |
| STOP_GRACEFUL | child traps INT and exits 0 | `stop(grace)` → `{exitCode: 0}`, no SIGKILL sent | — |
| STOP_ESCALATE | child ignores INT | after `grace`, SIGKILL; `{exitCode: null, signal: 'SIGKILL'}` | — |
| KILL_AFTER_EXIT | `kill` / `stop` after exit | no-op; `stop` resolves with the recorded exit | Never throws |
| NOT_FOUND | streaming run of a missing executable | `exited` → `{kind: 'notFound'}`; no output callbacks | Never rejects |
| SPAWN_ERROR | non-executable file | `exited` → `{kind: 'spawnError'}` | Never rejects |
| EMPTY_COMMAND | empty command | `spawnError` `empty invocation`, as the one-shot runner | Never throws |

</frozen-after-approval>

## Code Map

- `src/adapters/redpandaConnect/process.ts` — `runProcess(invocation, args, timeoutMs)` (env `{...process.env, NO_COLOR: '1'}`, `stdio: ['ignore','pipe','pipe']`, timeout SIGKILL, resolve on `close`), `readVersion`, `runList`, `findOnPath`, `spawnFailure` (ENOENT + missing file → `notFound`). Add an options argument `{ env?, cwd? }` and `runStreaming(command, args, options)`.
- `src/adapters/redpandaConnect/args.ts` — `CommandLine { command, args, env }` already includes `NO_COLOR: '1'`; `ArgsRequest.detectedResourceFiles` and `relativePath` role `detectedResource` to remove; `src/core/args.ts:22` comment "then detected ones".
- Callers: `binary.ts` (`readVersion`), `schema.ts` (`runList`), `test/corpus/corpus.test.ts:94` (`runProcess([command], args, LINT_TIMEOUT_MS)`).
- Tests: `src/test/adapters/redpandaConnect/` (process tests exist for the one-shot runner), `src/test/helpers/fakeBinary.ts` (`makeTempDir`, `writeFakeBinary` write `#!/bin/sh` scripts), `src/test/adapters/redpandaConnect/args.test.ts` (five `detectedResourceFiles` uses).
- Spike: `rpk connect run` execs in place (same PID), SIGINT exits 0 within ms; logs on stderr, payload on stdout.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/redpandaConnect/process.ts` -- caller env/cwd for the one-shot runner; `runStreaming` handle with callbacks, `exited`, `kill`, `stop` -- the spawn contract
- [x] `src/adapters/redpandaConnect/args.ts`, `src/core/args.ts` -- drop `detectedResourceFiles` -- resource-file decision
- [x] `src/test/` -- tests for every matrix row (fake `/bin/sh` scripts); args tests updated -- coverage

**Acceptance Criteria:**
- Given a builder `CommandLine` with a custom env, when it runs through the spawn site, then the child sees that env with `NO_COLOR=1`.
- Given a streaming child that prints and waits, when output arrives, then the callback gets it before exit, and `stop` ends it (SIGINT, or SIGKILL after the grace period).
- Given the existing suite and corpus harness, when run, then they pass unchanged.

## Implementation Notes

- `runProcess(invocation, args, timeoutMs, options?)` and `runStreaming(invocation, args, handlers?, options?)` share `childEnv` (`{...(env ?? process.env), NO_COLOR: '1'}`) and `cwdProblem`. A builder `CommandLine` runs as `[command]`, `args`, `{ env }`.
- Handlers are passed at spawn time, so no early chunk is lost. `exited` resolves on `close` (after the last chunk), or `STREAM_CLOSE_GRACE_MS` (2 s) after `exit` when a grandchild holds the pipes; then the pipes are destroyed and no handler runs after `exited`. A start failure is recognised by `child.pid === undefined` in the `error` handler. Experiments: `error` comes before a bogus `close(-2)`, and there is no `exit` event.
- `stop` signals only on the first call (`stopping` flag). The grace is clamped to 0 … 2^31-1 ms, and NaN becomes 0. The escalation timer is cleared on exit. `kill` is a no-op after `exit` (the `exitCode` / `signalCode` guard), so there is no risk of signalling a reused PID.
- A missing or non-directory `cwd` is a `spawnError` naming it. Node reports it as the command's ENOENT, which would otherwise read as "binary not found". This is beyond the frozen matrix, added from review #5 within the NOT_FOUND / SPAWN_ERROR intent.
- `detectedResourceFiles`, its `relativePath` role and five test uses are removed. Resource dedupe still covers setting entries (relative vs absolute spelling).
- Tests use `/bin/sh` fakes. Streaming children are tracked and SIGKILLed in teardown so a failed test leaves no orphan.

## Plan Change Log

## Review Triage Log

**Pass 1 (full: adversarial + edge-case, verification-gap; 2026-10-07):** 15 findings across two reviewers. Medium 3 and low 10 patched, low 2 rejected. No intent_gap or bad_plan. The adversarial reviewer verified the claims with Node experiments (Node 22 on that run).

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| A1 | Grandchild holding pipes: chunks reach handlers after `exited` resolved | medium | patch | Handlers gated on `!settled`; pipes destroyed on the fallback; doc corrected; test added. |
| A5 | Missing `cwd` reported as `notFound` / "binary ENOENT" | medium | patch | `cwdProblem` → `spawnError` naming the directory, both runners; BAD_CWD tests. |
| V1 | AC1 (builder `CommandLine` through the spawn site) untested | medium | patch | Test runs a `buildRunCommand` result through both runners. |
| A2 | A throwing handler becomes an uncaught exception | low | patch | Swallowed in `deliver`; test. |
| A3 | `stop(NaN / negative / ≥ 2^31)` SIGKILLs after ~1 ms | low | patch | Clamp; test. |
| A4 | Second `stop` re-sends SIGINT and can shorten the grace | low | patch | `stopping` flag; test counts one INT. |
| A7 / V5 | Close-grace fallback untested; doc overstated | low | patch | Test with `(sleep 4; echo late) &`. |
| V3 | CHANGELOG had no line for this ticket | low | patch | Line added; 1.5 line says "only". |
| V6 | Failed streaming tests leave waiters running | low | patch | Tracked children SIGKILLed in teardown. |
| V7 | DEFAULT_ENV relied on `HOME` | low | patch | Sentinel variable. |
| V8 | `args.ts` header over-long line | low | patch | Rewrapped. |
| V2 | Backlog story 5 (literal glob characters) assumes detected resource files | low | patch (raise to user) | The story is moot without detection; dropping it is the user's call. |
| A6 | Lowercase `no_color` from the caller sits next to `NO_COLOR=1` | low | reject | Only conflicts on Windows (out of scope); belongs with the Windows backlog item. |
| V4 | "Timer cleared" not observable in tests | low | reject | `kill` after exit is a guarded no-op, so a leaked timer is harmless; the adversarial run confirmed that the event loop exits promptly. |

Re-verification (parent): `npm test` 257 passing on two consecutive runs (compile, type-check and lint in `pretest`), `npm run test:corpus` 34/34, no record changes.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (AD-15: `child_process` only in `process.ts`)
- `npm test` -- expected: all pass
- `npm run test:corpus` -- expected: 34/34, no record changes
