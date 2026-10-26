---
title: 'Automated Run and Stop check with a real binary'
type: 'chore'
ticket: '9'
created: '2026-10-26'
status: done
baseline_revision: 'd89e711a28b19a64e0139408c07f919bde5007ee'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The VS Code suite checks Run and Stop (2.7) only against fake binaries; with a real Redpanda Connect, the terminal output, Stop, the exit status and terminal reuse are a manual check (2.7 review V8).

**Approach:** A new integration suite drives Run and Stop in the extension host with the pinned real binaries, 4.100.0 and 4.112.0 from `.cache/redpanda-connect/<ver>/` (`scripts/spike/fetch-binaries.sh`), never the user's installed `rpk`, `redpanda-connect` or managed connect (they are taken off `PATH`, and `binaryPath` points at the cached binary). For each version, on a copy of `test/corpus/fixtures/run_generate.yaml`: Run shows the generated message in its terminal while the pipeline runs; Stop ends it within the grace period and the status bar says "Pipeline stopped"; Run again reuses the same terminal. Terminal content is read through two small test seams on `RunController` (what its Pseudoterminal wrote, and the status bar text). Without a cached binary the version's tests are skipped with a message, and fail in CI (`CI` set), as in the corpus harness. CI fetches the binaries before the VS Code tests, so they run there.

</frozen-after-approval>

## Implementation Notes

Oneshot: two test seams in `src/adapters/vscode/run.ts`, a new suite, and the CI step order.

- `run.ts`: `RunPty.transcript` (the last 64 KiB written, as given), `RunController.outputOf(uri)` and `statusBarText` (the status bar item's text, for the active file's run).
- `src/test/integration/suites/61-run-real.ts` (registered after suite 60): one test per pinned version on a copy of `run_generate.yaml` in its own folder: Run → `tick` in the output while `running`; Stop → `exited` in under `STOP_GRACE_MS`, status "Pipeline stopped"; Run again → a second `tick`, one terminal. `PATH` without `rpk` / `redpanda-connect` (as suite 60), `binaryPath` = the cached binary, resolved state checked (path and version). A missing binary: `this.skip()` with a `skipped: …` line, `assert.fail` with `CI` set.
- `.github/workflows/ci.yml`: the binary cache and `fetch-binaries.sh` run after `npm run compile`, before the VS Code tests (the corpus harness still runs later). A failed fetch now stops the job before the VS Code tests.
- Checked: both versions pass (with suite 60: 14 passing); with `.cache/redpanda-connect` moved aside, 2 pending with the message locally and 2 failing with `CI=true`.

## Review Triage Log

Quick review. Verdicts: 0 high, 0 medium, 6 low. All patched; Run suites 14 passing, full stable suite 936 passing.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | AC 3 counted terminals by name, which can't tell the same terminal from a new one | low | patch | The first run's `vscode.Terminal` is kept and the second run must have exactly it. |
| 2 | Both versions' terminals have the same name; `dispose()` doesn't wait, so the next version's count could see the old one | low | patch | `finally` waits until no run terminal is left. |
| 3 | `statusBarText` returned the last text while the item was hidden | low | patch | `undefined` while hidden (`statusShown`, set by `refreshUi`); the doc comment says so. |
| 4 | The transcript copied up to 64 KiB on every write of every user's run | low | patch | Chunks, trimmed only when over twice the limit; `transcript` joins on read. |
| 5 | The skip check (`existsSync`) differed from the corpus harness's (executable) | low | patch | `hasBinary` with `X_OK`, as the harness. |
| 6 | The 90 s timeout was shorter than the test's waits (about 125 s) | low | patch | 180 s. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "Extension tracer path|Run and Stop"` -- expected: all pass, the real-binary tests for both versions included.
- The same with `.cache/redpanda-connect` moved aside -- expected: the real-binary tests are skipped with a message; with `CI=true` they fail.
- The full stable suite (alone) -- expected: all pass.
