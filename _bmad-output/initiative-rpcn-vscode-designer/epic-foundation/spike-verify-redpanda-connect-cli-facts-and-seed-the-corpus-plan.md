---
title: 'Verify Redpanda Connect CLI facts and seed the corpus'
type: 'chore'
ticket: '1'
created: '2026-10-05'
status: 'built'
baseline_revision: 'cb3d128fc8b5479224ffd2eb9005e780e7897b9a'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/spec-rpcn-vscode-designer/research-and-cli-reference.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The architecture (AD-9, AD-10, AD-12, AD-13) rests on CLI facts recorded from source reading, not from running the binaries we support; the spec leaves two questions open (standalone vs `rpk connect` parity; real lint and jsonschema output), and there is no reference corpus.

**Approach:** Reproducible scripts fetch pinned binaries into a git-ignored cache and run a fixed command matrix against v4.100.0 and v4.112.0; a findings file answers each question with captured output; `test/corpus/` is seeded with licensed configs and their recorded lint output per version.

**Decision (corpus source, user 2026-10-05):** seed the corpus only from the Apache-2.0 configs in public `redpanda-data/connect` `config/` (examples, template_examples, test, rag); the private docs cookbooks (`rp-connect-docs`, unlicensed) are not used.

**Decision (rpk parity, user 2026-10-05):** compare the user's installed `rpk connect` 4.112.0 read-only against the downloaded standalone 4.112.0; the version comparison uses only the downloaded standalone 4.100.0 and 4.112.0 archives; nothing is installed through rpk.

## Boundaries & Constraints

**Always:** Pin exact versions 4.100.0 and 4.112.0; verify each download against its `.sha256`; run every child with `NO_COLOR=1`; capture stdout, stderr and exit code separately; record source URL, commit and license for every corpus file; keep scripts re-runnable (idempotent cache).

**Never:** Change the user's installed `redpanda-connect`, `rpk` or `~/.local/bin/.rpk.managed-connect`; commit binaries or the cache; write extension code (`src/`, `package.json` — ticket 1.2); copy files whose license does not allow redistribution in this public Apache-2.0 repo.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Version | `--version` per binary | Captured exact format (`Version: X` / `Date:`) | Record if rpk differs |
| Lint clean | corpus config | exit 0, empty stderr | — |
| Lint errors | invalid field, missing required, missing file | stderr `<path>(line,col) <msg>`, exit 1 | Record column base and path form (relative/absolute) |
| Env vars | `${VAR}` with no default | Fails without flag; exit 0 with `--skip-env-var-check`; `-e` dotenv resolves | Record message text |
| Deprecated | config with a deprecated field, `--deprecated` | Record message wording to distinguish warnings (AD-17) | — |
| Resources | `-r resources.yaml` referenced by a config | exit 0 only with `-r` | Record error without it |
| Schema | `list --format jsonschema` | Top-level keys, `$schema` presence, `definitions`, custom `is_*` keys, size | Diff 4.100.0 vs 4.112.0 |
| Run + Stop | tiny `generate` → `stdout` config, then SIGINT | Log line format on stdout/stderr, exit code after SIGINT | Record timeout behavior |

</frozen-after-approval>

## Code Map

Greenfield repo: only planning docs, `_bmad/`, `.claude/`, `.agents/` exist. Nothing to reuse; do not touch those folders except the paths below.

- Local env (read-only): `~/.local/bin/redpanda-connect` = v4.100.0, a symlink to a local build in another project — not used for captures; `rpk` v26.2.2 whose `rpk connect` = 4.112.0 (`~/.local/bin/.rpk.managed-connect`).
- Releases: `gh release download v<ver> -R redpanda-data/connect -p 'redpanda-connect_<ver>_linux_amd64.tar.gz*'`; per-asset `<asset>.sha256` holds the bare hash; flat archive with `redpanda-connect` (~328 MB unpacked). Darwin arm64 assets exist with the same naming.
- rpk pinning: `rpk connect install --connect-version <ver> --force`; install dir is `$HOME/.local/bin/.rpk.managed-connect`, isolatable only with `HOME=<tmp>`.
- Corpus candidates (Apache-2.0, redpanda-data/connect `config/`): `examples/joining_streams.yaml`, `examples/track_benthos_downloads.yaml`, `examples/discord_bot.yaml`, `examples/stateful_polling.yaml`, `examples/cdc_replication.yaml`, `examples/jira_input.yaml`, `examples/resources/resources.yaml`, `template_examples/processor_hydration.yaml`, `template_examples/processor_log_and_drop.yaml`, `template_examples/input_sqs_example.yaml`, `test/awk.yaml`, `test/json_contains_predicate.yaml`, `test/deduplicate.yaml`, `rag/eval.yaml`. Docs cookbooks live in private `redpanda-data/rp-connect-docs` with no license.
- Findings target answers: spec Open Questions; architecture AD-9 (version), AD-12 (lint format), AD-10 (schema shape), AD-13 (SIGINT), AD-17 (deprecated wording).

## Tasks & Acceptance

**Execution:**
- [ ] `.gitignore` -- add `.cache/` -- binaries never committed
- [ ] `scripts/spike/fetch-binaries.sh` -- download + sha256-verify + extract 4.100.0 and 4.112.0 for the host OS/arch into `.cache/redpanda-connect/<ver>/` -- reproducible, pinned inputs
- [ ] `scripts/spike/run-matrix.sh` -- run every I/O matrix scenario per binary flavor, write `captures/<flavor>-<ver>/<scenario>.{stdout,stderr,exit}` -- raw evidence
- [ ] `_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/` -- `findings.md` plus `captures/` -- answers each question with quoted output and a diff between versions and flavors
- [ ] `test/fixtures/schema/jsonschema-<ver>.json` -- captured schema per version (gzip if > 2 MB) -- input for ticket 1.6 transform tests
- [ ] `test/corpus/<name>.yaml`, `test/corpus/<name>.lint/<ver>.txt`, `test/corpus/SOURCES.md` -- at least 10 configs covering switch, branch, workflow, try/catch, brokers, resources; recorded lint output per version; provenance table -- seed for ticket 1.7
- [ ] `test/corpus/fixtures/` -- the matrix's invalid/env/deprecated/resources inputs, written by hand -- exercises error paths

**Acceptance Criteria:**
- Given a clean checkout with `gh` authenticated, when `scripts/spike/fetch-binaries.sh && scripts/spike/run-matrix.sh` run twice, then the second run downloads nothing and produces identical captures.
- Given the findings file, when a reader checks each spec open question and each listed AD, then each has a yes/no or exact-format answer backed by a quoted capture.
- Given `test/corpus/`, when listed, then it holds at least 10 configs, every construct above appears at least once, and `SOURCES.md` names source URL, commit and license for each.

## Implementation Notes

- 2026-10-05: Implemented by a fresh subagent from this plan. Files: `.gitignore` (`.cache/`), `scripts/spike/fetch-binaries.sh`, `scripts/spike/run-matrix.sh` (27 scenarios × 3 flavors), `spike-1-1-findings/captures/`, `test/fixtures/schema/jsonschema-{4.100.0,4.112.0}.json` (< 2 MB, not gzipped), `test/corpus/` (15 upstream files + `.lint/<ver>.txt`, `SOURCES.md`, 12 hand-written `fixtures/`).
- `findings.md` was written by the parent session from the implementer's report after spot-checking the captures (the harness blocks subagents from writing report files).
- Normalisation for byte-identical reruns: repo root → `<ROOT>`, log `time=` → `<TS>`, host license metadata redacted, racy `run` stderr and `lint --verbose` output sorted.
- Verified: two consecutive runs exit 0, second run downloads nothing, `diff -r` of all outputs between runs is empty; `git status` shows `.cache/` ignored.
- Surprise vs the I/O matrix: the Resources row predicted `lint` exits 0 only with `-r`; observed exit 0 with and without `-r` (lint does not check resource references; `run` does).
- Three corpus files are templates that `lint` rejects; kept as negative cases (12 true configs/resource files ≥ 10).
- Matrix audit (user decision 2026-10-05): the Resources row's prediction is treated as a disproved hypothesis and recorded as a spike finding; no expectation edited.
- Not covered: macOS, a hanging shutdown after SIGINT. NO_COLOR-on-TTY, `template lint` and the port-4195 collision were checked by hand, not captured.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-05):** 15 findings — high 0, medium 3, low 6, false 1, rejected-low 3, rejected-plan-edit 2. No intent_gap or bad_plan → patch round, no loopback.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | findings Q3 env+field claim cites `eval.lint`, made with `--skip-env-var-check` | low | patch | Confirmed: `eval.lint/4.112.0.txt` has only the field error. Implementer adds fixture + `env-plus-field-error` capture; findings re-cited. |
| 2 | findings Q6 "ending with Received SIGINT" from a sorted capture | low | patch | Confirmed: `cap_stop` sorts stderr. Reworded to "contains", order marked *by hand*. |
| 3 | NO_COLOR answer is by hand only | low | reject | Already marked *by hand*; NO_COLOR is not among the ACs' listed ADs; adding a pty capture adds complexity for a rarely-hit case. |
| 4 | `cue` / `bloblang-functions` doc-source claims uncaptured and unmarked | medium | patch | Confirmed: script never runs them, and ticket 1.6 relies on it. Implementer adds summary captures; findings re-cited. |
| 5 | rpk "execs in place" claim not marked by hand | low | patch | Confirmed (PID check was manual). Marked *by hand*. |
| 6 | Run+Stop row "Record timeout behavior" not done | false | reject | `.timing` records `exited_within_10s=yes` at 2 s + SIGINT; no timeout occurs to record. Hanging-shutdown gap already noted. |
| 7 | `-e` dotenv "resolves" stated without substitution evidence | low | patch | Confirmed: only exit 0 shown. Reworded to "variable counts as set; substitution not verified". |
| 8 | "4.100.0 is a strict subset" overstated | low | patch | Confirmed: only property-name paths compared. Reworded. |
| 9 | rpk skip branch wipes rpk evidence and leaves a stale diff | medium | patch | Confirmed at the skip branch. Implementer leaves existing rpk outputs untouched when skipping. |
| 10 | `license_org` redaction leaks quoted names with spaces | medium | patch | Confirmed: regex stops at first space; would commit host license org. Implementer fixes regex. |
| 11 | `${ROOT}` unescaped in sed pattern | low | reject | Breaks only on paths containing `#`/`[`/`(`; unlikely, and the fix adds an escaping helper. |
| 12 | no `set -e`: broken runs exit 0 | low | patch | Confirmed (`set -uo pipefail`). Implementer adds `|| die` to non-capture steps. |
| 13 | extracted binary not re-verified against archive | low | reject | Needs a tampered `.cache/`; unlikely, and the fix adds a check branch. |
| 14 | `.gitignore` `_bmad/render/` unrecorded | low | reject | Fix is an edit to this build's plan. (Added by the parent session for BMad's render cache.) |
| 15 | Execution checkboxes unchecked | low | reject | Fix is an edit to this build's plan. |

Patches applied: script items 1, 4, 9, 10, 12 by the implementer (re-engaged); findings.md items 1, 2, 4, 5, 7, 8 by the parent. Re-verification: two consecutive runs exit 0, second downloads nothing, `diff -r` of captures/corpus/fixtures empty, 15 corpus configs, `.cache/` ignored, `bash -n` ok.

## Verification

**Commands:**
- `scripts/spike/fetch-binaries.sh && scripts/spike/run-matrix.sh` -- expected: exit 0, captures written for both versions
- `ls test/corpus/*.yaml | wc -l` -- expected: >= 10
- `git status --short` -- expected: no `.cache/` or binaries listed
