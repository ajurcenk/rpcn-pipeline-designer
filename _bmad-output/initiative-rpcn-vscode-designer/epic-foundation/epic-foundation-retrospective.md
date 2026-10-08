---
epic: epic-foundation
date: 2026-10-06
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective — epic-foundation (E1)

## Epic summary

- **Epic:** `epic-foundation` — Foundation: binary, schema and release pipeline. Requirements E1 (R1)–(R7); Done when 1–4.
- **Tickets (8/8 done, `pending_tickets` empty, none left at `built`):** 1.1 spike CLI facts + corpus · 1.2 scaffold + tracer · 1.3 binary resolution + `binaryState` · 1.4 binary-missing notification · 1.5 lint/run argument builder · 1.6 schema generate/transform/cache · 1.7 corpus harness in CI · 1.8 refactor sweep.
- **Plan ranges (chained baselines):** cb3d128..11af6bb (1.1) · ..545176e (1.2) · ..f27df11 (1.3) · ..8c15f90 (1.4) · ..b5f7ec8 (1.5) · ..1681555 (1.6) · ..89e819f (1.7) · 89e819f..e235604 (1.8; code ends at f046359). Closure and ticket-placement commits after it: c5c3fdb, 092f614, b3b6e0a, 1021f1a.
- **Evidence available:** epic file, initiative, spec, architecture spine, all 8 plans (Implementation Notes, Review Triage Logs), spike findings and captures (3 flavors × 27 scenarios), git history (one commit per ticket for 1.1–1.7, six for 1.8, no merges), CI runs 37479779169 … 37498262894 (all green), the manual check of 2026-10-06.
- **Evidence missing:** no story files (no ticket was refined); no session logs — process lessons come from the plans only. Diff-scope review ran inline (adversarial, edge-case, verification-gap) over `src/`, `test/corpus/*.ts`, `scripts/`, `.github/`, without deep-reading `src/core/schema.ts` or the test files; the architecture delta was derived from imports, not a dependency tool.
- **Going-in concerns:** not asked; the user asked to run the retrospective, UX update and E2 planning in one go.

## Findings

### Cross-ticket boundaries

| # | Finding | Source | Instance | Prevention |
|---|---|---|---|---|
| F1 | The 1.5 builder returns `env`, but the spawn site builds its own `env` and accepts none, so the builder's `env` has no consumer | `src/adapters/redpandaConnect/args.ts:165`; `process.ts:113` | defer — placed in E2 Notes (`epic-smart-yaml-editing.md`) | handoffs name both sides at inception |
| F2 | The corpus harness uses core `buildLintArgs` + `runProcess` directly, bypassing the adapter builder (setting path rules, normalization, dedupe); R5's "through the adapter and argument builder" is met only partly | `test/corpus/corpus.test.ts:23-25,94`; 1.7 plan Code Map | accept (adapter imports `vscode`; documented in 1.7) | — |
| F3 | "Refresh Schema" with no usable binary clears the schema without a log line; Retry with nothing changed is silent by design (1.4 RETRY_STILL_MISSING), Refresh Schema's silence was never specified | `src/adapters/redpandaConnect/schema.ts:149-151`; `binary.ts:400-406` | fix later — action A1 | specify feedback for every user-triggered command |
| F4 | A window open for more than 30 days without a cache hit or write can have its live cache file removed by another window | `schema.ts:52,219,272,327` | defer to E2 inception (matters only if E2 serves the schema by file URI) | — |
| F5 | Component-level schema validation is weak (`anyOf` branches without `required`): unknown fields, typos and wrong types validate | manual check 2026-10-06; `epic-smart-yaml-editing.md` Notes | defer — open question in E2 Notes | — |

### Aggregate views

| # | Finding | Source | Instance | Prevention |
|---|---|---|---|---|
| F6 | `binary.ts` is the largest source file (411 lines) and also hosts the path rules `args.ts` imports | `binary.ts`; `args.ts:10` | defer — extract path rules when E2 adds callers | — |
| F7 | AD-15 holds: `child_process` only in `process.ts:5` (lint-enforced); `notify.ts`/`schema.ts` import `binary` as type only | `src/` imports | accept (win) | — |
| F8 | Architecture says core tests use vitest and pins Node 24.21.0; core tests run under mocha, CI uses `node-version: '24'` | architecture Conventions/Stack; 1.2 Implementation Notes; `.github/workflows/ci.yml:14` | spec reconciliation — action A2 | — |
| F9 | Two ways of composing "exit code + first stderr line"; `RESOURCE_DEPS` copies `SOURCES.md` by hand with no check | `binary.ts:122-124`; `schema.ts:337-344`; `corpus.test.ts:31` | accept (low) | — |
| F10 | Spec and planning text lag the as-built: spec Open Questions still listed (answered by 1.1); CAP-14 still says "cookbook" (1.1 decided Apache-2.0 configs from `redpanda-data/connect`); AD-9 / E1 R4 still say `-r`/`-e` (code uses `--resources`/`--env-file`); the 1.6 ticket entry still lists `defaultSnippets` (dropped by decision) | `spec-rpcn-vscode-designer.md` Open Questions and line 77; architecture AD-9; `epic-foundation.md` R4; `tickets.toml` entry 6 | spec reconciliation — action A3 | reconcile upstream docs in the same ticket that decides the change |
| F11 | `@vscode/test-cli` runs against the default VS Code download; the engine floor 1.100 is never tested (manual check used 1.103.2) | `.vscode-test.mjs`; `package.json` engines | fix — action A4 | test the declared floor |
| F12 | The VS Code test suite uses only fake binaries; real binaries run only in the vitest corpus harness | `src/test/helpers/fakeBinary.ts`; `corpus.test.ts` | accept | — |
| F13 | `outputLines` keeps every log line for the life of the host in production (test API) | `src/extension.ts:70-74` | accept (low) | — |

### Process lessons (from the plans)

| # | Lesson | Source | Disposition |
|---|---|---|---|
| P1 | Two intent gaps were resolved by a patch round instead of re-deriving the plan (1.3 bare-name rule, then AD-9 renegotiated to PATH-first during review; 1.6 cache cleanup). Both needed a second review pass or a human loopback. AD-9's order was not settled before the build. | 1.3 plan frozen block + Review Triage Log; 1.6 plan Decision + pass 1 | action A5 |
| P2 | Every review used only the `quick` lens; the full lens set never ran on any ticket | `lenses_ran: ['quick']` in all 8 plans | action A6 |
| P3 | The harness blocks subagents from writing report files; the parent wrote `findings.md` from the implementer's report | 1.1 plan Implementation Notes | accept (worked around) |
| P4 | "Needs a second extension host" was rejected twice; partly covered by the manual check | 1.4 #4, 1.6 #5 | accept; open question in E3 Notes |
| P5 | Execution checkboxes were left unticked in two plans and 1.8 items 3–7 landed in one commit; plan checkboxes are not a reliable record | 1.1 #15, 1.8 #3/#5; commit 256250a | accept |
| P6 | Several plans exceeded the 1,600-token guideline (kept by user choice) without a measured problem | 1.1–1.8 plan size notes | accept |

### Wins confirmed by evidence

- The spike disproved predictions early and fed later tickets: lint ignores resources (1.1), rpk consumes `-v` (→ 1.5), the leading `v` in versions (→ 1.3), no docs in jsonschema (→ 1.6 json-full merge).
- A single spawn site, lint-enforced, held through every ticket and the 1.8 rename.
- The corpus harness has record/compare modes, checks binary versions, rejects crash exits, pins the same versions as `fetch-binaries.sh` (tested) and fails in CI when a binary is missing; its first CI run downloaded both binaries with `GH_TOKEN`.
- Reviews caught real defects: 1.2 timeout waited on `close`; 1.4 Set path left the user without feedback; 1.6 a stale generation could delete the live cache.
- The 1.8 sweep stayed behavior-neutral (184 tests, corpus 34/34, no record changes) and removed duplication (`text.ts`).
- No deferred finding was dropped: all landed in E2/E3 Notes or backlog tickets (c5c3fdb).

## Behavior verification

Exercised end to end on 2026-10-06 in an Extension Development Host (VS Code 1.103.2, isolated profiles):

- With `rpk` on PATH: `Redpanda Connect 4.112.0 (…/rpk connect)` logged; schema generated and cached in globalStorage; "Redpanda Connect: Refresh Schema" present in the Command Palette.
- With neither binary on PATH: the warning showed Install guide / Set path / Retry; Set path to `~/.local/bin/redpanda-connect` switched the state to `ok` 4.100.0 and generated a separate 4.100.0 schema without a reload; the setting was written at user scope.
- Installing the CI-built `.vsix` into an empty profile also installed `redhat.vscode-yaml` 1.24.0.
- With the cached schema wired into Red Hat YAML by hand: completion and hover (merged docs) worked; component-level validation did not (F5).
- Not exercised: a second activation reusing the cache (covered by an integration test only), Install guide and Retry clicks, the invalid-binary variant, VS Code 1.100.

## Previous-retro follow-through

No previous retrospective file exists: E1 is the first epic (`after: []`). Nothing to follow through on.

## Action items

| # | Action | Owner | Kind |
|---|---|---|---|
| A1 | Decide and specify feedback for user-triggered commands with no visible effect (Refresh Schema with no binary; Retry with nothing changed) | product owner (user), at E2 inception | proposed |
| A2 | Reconcile the architecture with the as-built test setup: core tests under mocha (or move them to vitest), and the Node pin (`24` vs `24.21.0`) | architect, via `bmad-architecture` update | applied in 2.12 (user-approved sweep, 2026-10-08): mocha kept and documented; Node 24.x |
| A3 | Reconcile upstream docs: close the spec's two Open Questions (answered by 1.1), CAP-14 corpus source, AD-9/R4 long-flag wording, the 1.6 entry's `defaultSnippets` | `bmad-spec` / `bmad-architecture` / `bmad-ticket` updates | applied in 2.12 (user-approved sweep, 2026-10-08) |
| A4 | Run the `@vscode/test-cli` suite against VS Code 1.100 (the engine floor) in CI, in addition to the default download | E2 or a backlog story | done in 2.11 (CI runs stable and 1.100.0) |
| A5 | At E2 inception, settle cross-cutting decisions (resolution order, validation source per AD-12, diagnostics range rule) before the first build, so they are not renegotiated in review | E2 inception (`bmad-ticket`) | process lesson |
| A6 | Choose the review depth per ticket risk: keep `quick` for low risk, run the full lens set for medium/high-risk tickets in E2 (lint/diagnostics, Quick Fixes, Run) | user, per build | process lesson |

## Acceptance verdict

**accepted-with-open-items** (criteria declared in the epic file).

- Done when 1: CI builds and tests one `.vsix` with LICENSE/NOTICE on every push; installing it pulled in `redhat.vscode-yaml` (manual check).
- Done when 2: AD-9 resolution, the v4.100.0 floor, the schema cache keyed by path + version (+ transform version) and the once-per-transition warning are covered by tests and the manual check.
- Done when 3: CI runs `@vscode/test-cli` and the vitest corpus harness on Node 24 against 4.100.0 and 4.112.0 (run 37496110202 onward).
- Done when 4: spike findings recorded in `spike-1-1-findings/findings.md`; both spec open questions answered there (the spec itself still lists them — F10/A3).
- Open items tracked: F1, F4, F5, F6 (E2), A1–A6. No unfinished tickets. The human closed the epic as done on 2026-10-06 (`epic-foundation.md` Notes), consistent with this verdict.

## Open questions

- F5 / AD-12: is live schema validation meant to catch component-level errors (extend the transform) or is lint-on-save the real validation? Decides a chunk of E2's scope.
- F4: will E2 serve the schema to Red Hat YAML by file URI (then the 30-day cleanup needs a longer horizon or periodic touch) or as content via `registerContributor`'s content callback?
