---
title: 'Probe Bloblang execution on the binary'
type: 'chore'
ticket: '1'
created: '2026-10-12'
status: 'built'
baseline_revision: '8243faa9958bc0b3c5dd50674ea51bdd91639311'
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

**Problem:** Epic 4 must run Bloblang on the developer's binary twice: a parse on every edit (CAP-15) and a test run with content and metadata (CAP-16). `blobl server` ignores metadata and hides `deleted()`, and no one has measured the routes or checked v4.100.0, so every later entry (4.2, 4.5, 4.7, 4.12) waits on the choice.

**Approach:** A repeatable probe script runs a fixed scenario set through three routes on three flavors and records raw evidence and timings. A findings file answers the questions, and AD-21 in the architecture spine proposes which route serves the live parse and which serves the test panel. The user approves AD-21 before the spike is done.

## Boundaries & Constraints

**Always:**
- Routes:
  - **A:** `blobl server --no-open -p <free port>` and `POST /execute`.
  - **B:** `blobl` with the mapping in `-f` and the input on stdin.
  - **C:** `run` on a temporary one-message config: an input that sets the sample's content and metadata, the mapping under test, a final step writing `{content, meta}` or the error to stdout.
- Flavors: `.cache/redpanda-connect/4.100.0` and `4.112.0` standalone, and the user's `rpk connect` (read-only, skipped when absent, as in `run-matrix.sh`).
- Each scenario's request, stdout, stderr, exit code and timing is captured. Text is normalised so a rerun gives identical files apart from timings: `<ROOT>`, `time="<TS>"`, licence lines dropped.
- Timings: 20 runs per scenario and route, reported as p50 and p95. A cold start (process launch) and a warm call (server already up) are measured separately.
- Every child gets `NO_COLOR=1` and runs without a shell, as AD-9 requires.

**Never:**
- No product code changes; nothing under `src/`, `webview/` or `package.json`.
- Never install, upgrade or modify the user's `rpk`, `redpanda-connect` or `~/.local/bin/.rpk.managed-connect`.
- No binaries or `.cache/` in commits, and no licence data in captures.
- Never write the AD as decided before the user approves it.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ok | mapping sets a field; JSON input | output content per route | none |
| meta-in | `root.k = @key`, input metadata `key=k1` | whether `k1` reaches the mapping | record "ignored" if null |
| meta-out | `meta out = "x"` | whether output metadata is returned | record "not returned" |
| deleted | `root = deleted()` | how each route signals deletion | record the signal or its absence |
| map-error | `this.nope.number()` on `{}` | error text, mapping line | record the shape |
| parse-error | missing `)`, multi-line mapping | message, line, column, caret | record whether positions are mapping-relative |
| bad-input | input not JSON | error text | record the shape |
| raw-input | non-JSON text used with `content()` | output | record whether raw input works |
| multi-line | input JSON over several lines | treated as one message or many | record the behaviour |
| server-missing | `blobl server --help` on each flavor | exists or not | route A marked unavailable |

</frozen-after-approval>

## Code Map

- `scripts/spike/run-matrix.sh` -- style to copy:
  - the flavor loop, skipping rpk unless `.rpk.managed-connect` reports 4.112.0;
  - normalisation rules; `NO_COLOR=1`; the timeouts.
- `scripts/spike/fetch-binaries.sh` -- fetches the pinned binaries into `.cache/`. Run it first when they are missing; don't change it.
- `_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md` -- layout to copy: answers first, then Q sections that quote captures.
- `_bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/research-and-cli-reference.md` -- the `blobl server` / `blobl` facts already checked on 4.112.0. The spike confirms them and extends them to 4.100.0 and rpk.
- `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md`:
  - the AD-21 section goes after AD-20, in the same Binds / Prevents / Rule shape, marked `[PROPOSED]`;
  - the AD-9 rule (one spawn site, `NO_COLOR=1`) constrains every route;
  - AD-14 and AD-12 are not edited here (that's entry 4.5).
- `src/adapters/redpandaConnect/process.ts:136,242` -- `stdio: ['ignore', …]` in both runners. The findings note what route B or C would need from the spawn site (stdin, a long-lived server child). Don't change it.
- rpk swallows a bare `-` and `-v` (spike 1.1 Q1), so route B must read stdin without `-`. Check that `rpk connect blobl server` passes `-p` through.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/spike/blobl-probe.sh` (or a `.mjs` beside it when timing needs Node) -- runs the matrix scenarios × routes × flavors and writes captures plus a `timings.tsv`. It's repeatable and touches nothing outside the repo.
- [x] `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/spike-4-1-findings/captures/` -- the raw evidence from the script.
- [x] `_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/spike-4-1-findings/findings.md` -- holds:
  - answers to the epic's open questions (metadata in and out, `blobl server` on v4.100.0, latency);
  - a measured table per route and flavor: supported scenarios, p50/p95 cold and warm;
  - what each route needs from the AD-9 spawn site;
  - a recommendation.
- [x] `_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md` -- AD-21 "Bloblang execution" `[PROPOSED]`: the route for the live parse, the route for test runs, the process lifetime, and how positions are reported. After the user approves it, mark it `[ADOPTED]` with the date.

**Acceptance Criteria:**
- Given the cached binaries, when the probe script runs twice, then the captures are identical apart from the timings.
- Given the findings, when a reader looks up any matrix scenario, then every route and flavor has a recorded result or "unavailable", with the capture path.
- Given the proposed AD-21, when the user approves it, then the spine marks it `[ADOPTED]` with the date, and the findings name the routes 4.2, 4.5 and 4.7 will use.

## Implementation Notes

- The probe is `scripts/spike/blobl-probe.mjs` (Node: timings and the HTTP route); `blobl-probe.sh` checks for Node and execs it. `BLOBL_PROBE_RUNS` overrides the 20 timing runs for a quick capture-only rerun.
- Temporary mapping and config files go in `.cache/blobl-probe/` (git-ignored, removed at the end), so nothing outside the repo is touched.
- Normalisation beyond the plan's list: Go log timestamps (`2006/01/02 15:04:05`, from `blobl server`) become `<TS>`; the route A port becomes `<PORT>`; argv in `.request` files shows the invocation as `<BIN>` (spelled out per flavor in `invocation.txt`), so the flavor diffs show only behaviour.
- Extra captures beyond the matrix: `empty-string` (`root = ""`), to tell `deleted()` apart from an empty result; and route B `*.parse-only.*` (stdin closed) for ok, map-error and parse-error, since the AD-21 proposal depends on it.
- `summary.tsv` (deterministic) holds one line per flavor/route/scenario; `timings.tsv` is the only file that changes between runs.
- Verified: three full runs, all exit 0. Runs 1 and 2 were identical apart from `timings.tsv`; run 3 (after adding parse-only) changed only the new files, `summary.tsv` and `timings.tsv`. `npm run compile` exits 0. No licence lines or home paths appear in the captures.
- Open: `findings.md` and the AD-21 approval (hitl). AD-21 is in the spine as `[PROPOSED]`.
- Review patches (iteration 0): AD-21 keeps the processor kind (`mapping` / `mutation`), classifies non-zero exits by message (env-var failures are not parse errors) and passes `redpandaConnect.envFile`; findings record the route C vs `blobl` differences; the probe's fetches time out and the route C summary uses the sorted stderr.
- The user approved AD-21 (now `[ADOPTED]`) and chose to compare parity against route C (2026-10-12); the epic's Done when 2 and R11 and the spec's success signal are reworded to match (spec memlog entries 75–77).

## Plan Change Log

## Review Triage Log

Iteration 0 (quick). Verdicts: 0 high, 3 medium, 7 low, 1 false, 0 maybe-false.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | AD-21 still `[PROPOSED]`; AC3 unmet | low | reject | The approval is the plan's hitl step, done at presentation (step 5), not a defect in the change. |
| 2 | Implementation Notes say findings.md is open | low | reject | The fix would edit this build's plan. |
| 3 | Route C differs from `blobl` on multi-line, `deleted()` and bad-input, while Done-when 2 and the spec signal say "matches the binary's `blobl` result" | medium | patch | Confirmed in `B/` vs `C/` captures. Findings now state it in Answers and Follow-ups as a decision for the user with AD-21; spec and epic not edited. |
| 4 | `mutation` would run as `mapping` in route C | medium | patch | Reproduced on 4.112.0 (`{"y":2}` vs `{"x":1,"y":2}`). AD-21 now keeps the processor kind; findings Q2 records it by hand. |
| 5 | Unset `${VAR}` makes exit 1 without a parse error; env file not passed | medium | patch | Reproduced: `failed to replace env vars: …`. AD-21 classifies by message and passes `redpandaConnect.envFile` to both routes; findings Q1 and Follow-ups updated. |
| 6 | A run without rpk rewrites summary.tsv without rpk rows | low | reject | Only on a machine without rpk; the fix adds branches; not met in normal use. |
| 7 | Route C summary row uses the unsorted first stderr line | low | patch | Direct correction: the summary now uses the sorted normalisation. |
| 8 | Route A writes no "unavailable" when the server is not ready | low | reject | Never reached in the recorded runs (every flavor ready); the fix adds a branch. |
| 9 | `port_passed_through` equals readiness | false | reject | Readiness means `/execute` answered on the chosen port, which proves `-p` reached the server. |
| 10 | `fetch` has no timeout, the readiness loop can hang | low | patch | Direct correction: `AbortSignal.timeout(FETCH_MS)` on every fetch. |
| 11 | Findings Q3 quote drops the start of the line | low | patch | Now quoted in full as captured. |

## Verification

**Results (2026-10-12):** `bash scripts/spike/blobl-probe.sh` exit 0 after the review patches; the rerun changed only `timings.tsv` (restored to the run the findings table quotes, so table and file agree); `npm run compile` exit 0; no licence data or home paths in the captures.

**Commands:**
- `bash scripts/spike/blobl-probe.sh` -- expected: exit 0, captures and `timings.tsv` written; a second run changes only the timings.
- `npm run compile` -- expected: exit 0 (no product code touched).

**Manual checks:**
- The user reads the findings and approves or changes AD-21 (hitl).
