---
title: 'Refactor sweep'
type: 'refactor'
ticket: '8'
created: '2026-10-06'
status: done
baseline_revision: '89e819fcf116961d81f1ad63f04020b66f6f90d6'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Building tickets 1.1–1.7 left cleanup behind: outdated CI actions, a test run that can execute stale compiled tests, duplicated helpers, a spawn module named for what it used to do, over-exported symbols, out-of-date docs and generator leftovers.

**Approach:** One behavior-neutral cleanup pass over exactly the ten items agreed with the user (2026-10-06): no user-visible change, every message text unchanged, the full suite, the corpus harness and CI green before and after.

## Boundaries & Constraints

**Always:** Behavior-neutral: no change to settings, commands, activation, log or notification wording, argv, cache file names or the schema transform output. Each item lands as its own small, reviewable change. AD-15 dependency rules still hold (`npm run lint`). The agreed items, and only these:
1. Bump `actions/checkout` → v7.0.1, `actions/setup-node` → v7.0.0, `actions/cache` → v6.1.0, `actions/upload-artifact` → v7.0.1 in `.github/workflows/ci.yml`, after reading each changelog for changed defaults; keep the artifact name, path and `if-no-files-found: error`.
2. `pretest`: remove `out/` before `compile-tests`, drop the duplicate trailing `lint` (`compile` already lints).
3. One shared adapter helper for "error to text" and "first non-empty stderr line", replacing the copies in `version.ts`, `notify.ts`, `binary.ts`, `schema.ts`.
4. Rename `src/adapters/redpandaConnect/version.ts` → `process.ts` (it stays the only `child_process` import), update every import (incl. `test/corpus/corpus.test.ts`) and header comments; remove the `VersionProbe` alias.
5. Simplify `firstWorkspaceFolderPath()` (same result); use one name for the empty-invocation failure in core and adapter.
6. Drop `export` from symbols used only inside their module (`statesEqual`, `RPK_BINARY`, `STANDALONE_BINARY`, `defaultArgsEnvironment`, `resolveFileSettingPath`, `OUTPUT_CHANNEL_NAME`) unless a test imports them.
7. Derive the fake-binary scripts in `src/test/helpers/fakeBinary.ts` from one builder.
8. Update `README.md` (binary resolution order, binary-missing warning, schema cache and docs, Refresh schema, `npm run test:corpus`) and `CHANGELOG.md` `[Unreleased]` (tickets 1.2–1.7).
9. Remove generator leftovers: commented-out `tsconfig.json` options, `.yarnrc` in `.vscodeignore`.
10. Mark done the "repo has no LICENSE" row in `spike-1-1-findings/findings.md`; close the "lint via stdin" entry in the architecture's Deferred table (spike: stdin unsupported), with a memlog line.

**Never:** New behavior, settings, commands or dependencies; moving `scripts/spike/fetch-binaries.sh`; the epic-2/3 and backlog items listed in Implementation Notes (they are placed by `bmad-ticket` after this ticket); editing ticket files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SUITE_UNCHANGED | `npm test` before and after | same tests pass (count may only grow from #7 refactors, never shrink) | — |
| CORPUS_UNCHANGED | `npm run test:corpus` | 34/34, no record file changes | — |
| STALE_OUT | a dummy `out/test/stale.test.js` exists | `npm test` does not run it | — |
| MESSAGES_UNCHANGED | log and notification texts | byte-identical (existing tests assert them) | — |
| CI_GREEN | push after the bumps | all steps pass; `.vsix` artifact uploaded; binary cache restored or saved | — |

</frozen-after-approval>

## Code Map

- `.github/workflows/ci.yml` — `actions/checkout@v5`, `actions/setup-node@v5` (node 24, npm cache), `actions/cache@v4` (`.cache/redpanda-connect`, key from `hashFiles('scripts/spike/fetch-binaries.sh')`), `actions/upload-artifact@v4` (`rpcn-pipeline-designer-vsix`, `*.vsix`, `if-no-files-found: error`). Latest releases per `gh release view` (2026-10-06): checkout v7.0.1, setup-node v7.0.0, cache v6.1.0, upload-artifact v7.0.1.
- `package.json` scripts: `compile` = `check-types && lint && node esbuild.js`; `compile-tests` = `tsc -p . --outDir out`; `pretest` = `compile-tests && compile && lint`; `check-types` = `tsc --noEmit && tsc -p test/corpus/tsconfig.json`; `lint` = `eslint src test/corpus vitest.config.mts`.
- Duplicates: `err instanceof Error ? err.message : String(err)` at `version.ts:145`, `notify.ts:101`, `binary.ts:393`, `schema.ts` `errorText` (~354); first non-empty stderr line in `binary.ts` `firstNonEmptyLine` and `schema.ts` `describeRun`.
- `src/adapters/redpandaConnect/version.ts` — `runProcess`, `runList`, `readVersion`, `findOnPath`, `type VersionProbe = ProcessOutcome`; imported by `binary.ts`, `schema.ts`, `test/corpus/corpus.test.ts` and `src/test/adapters/redpandaConnect/*.test.ts`.
- `binary.ts` `firstWorkspaceFolderPath()` checks the `file:` scheme twice; core failure `noInvocation` vs adapter `emptyInvocation` (`src/core/args.ts`, `src/adapters/redpandaConnect/args.ts`).
- `src/test/helpers/fakeBinary.ts` — `VERSION_4_112_SCRIPT` duplicates `versionScript('4.112.0')`; `rpkScript` repeats lines.
- No leftovers of 1.2's `resolveBinary` remain; AD-9 PATH-first wording is consistent; `MAX_SHARED_DEPTH` in `eslint.config.mjs` stays (simplifying weakens the rule).

## Tasks & Acceptance

**Execution:**
- [ ] `.github/workflows/ci.yml` -- item 1
- [ ] `package.json` -- item 2
- [ ] `src/adapters/redpandaConnect/text.ts` (new) + the four callers -- item 3
- [ ] `src/adapters/redpandaConnect/process.ts` (renamed) + importers -- item 4
- [ ] `binary.ts`, `src/core/args.ts`, `src/adapters/redpandaConnect/args.ts` -- item 5
- [ ] modules in item 6 -- item 6
- [ ] `src/test/helpers/fakeBinary.ts` -- item 7
- [ ] `README.md`, `CHANGELOG.md` -- item 8
- [ ] `tsconfig.json`, `.vscodeignore` -- item 9
- [ ] `spike-1-1-findings/findings.md`, architecture Deferred table + its `.memlog.md` via `uv run _bmad/scripts/memlog.py append` -- item 10

**Acceptance Criteria:**
- Given the swept tree, when `npm run compile`, `npm test` and `npm run test:corpus` run, then all pass with no change to any recorded corpus output.
- Given the swept tree, when searched, then `child_process` is imported only in `src/adapters/redpandaConnect/process.ts`.

## Implementation Notes

Out of scope, to be placed with `bmad-ticket` after this ticket (user decision 2026-10-06: epic-2/3 topics as notes in the matching epic envelope; separate topics as backlog tickets):
- Epic 2: lint column always 1 → whole-line mapping; lint ignores resource references; exclude templates from detection (AD-18); Stop = SIGINT then SIGKILL; port 4195 (run builder already disables HTTP); env from the argument builder not yet passed through the spawn site; Red Hat rendering of merged docs next to `anyOf`/`$ref`; Run/Stop handlers.
- Epic 3: Show/Hide graph handlers; activation end-to-end test needing a second extension host.
- Backlog: Windows support and CI; `~user` paths; re-resolve relative `binaryPath` on workspace-folder change; multi-root folder choice; literal glob characters in `--resources`; spike script `${ROOT}` escaping and re-checking extracted binaries.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-06):** 5 findings — low 2 patched, 3 rejected. No intent_gap or bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | README says the cache is reused "without running the binary" | low | patch | Activation always spawns `--version` (`probeBinary`); the cache only skips the two `list` runs. Correct the sentence. |
| 2 | README cleanup text omits "more than 30 days", "only after a successful write" and the transform version in the file name | low | patch | Matches `schema.ts` header, `STALE_CACHE_MS`, `SchemaSnapshot` doc. Complete the text. |
| 3 | Items not delivered as separate changes | low | reject | Not a code defect; handled at commit time (per-item commits where files allow; items 3–7 share `binary.ts`/`schema.ts` and land as one refactor commit). |
| 4 | No record of reading the action changelogs | low | reject | The fix is a plan edit; the implementer's report states v5→v7 notes were read and no relied-on default changed (upload-artifact v7 `archive` defaults to true). Recorded in the commit message; CI_GREEN confirmed after push. |
| 5 | Execution checkboxes unticked | low | reject | Fix is a plan edit. |

Patches 1–2 (README) applied by the re-engaged implementer. Re-verification (parent): `npm run compile` exit 0, `npm test` 184 passing (unchanged), `npm run test:corpus` 34/34 with no record changes, stale `out/test/stale.test.js` not run, `child_process` only in `process.ts`. CI_GREEN confirmed after push.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0
- `npm test` -- expected: all pass
- `npm run test:corpus` -- expected: 34/34, `git status` shows no record changes
- `grep -rln "from 'child_process'\|require('child_process')" src` -- expected: only `src/adapters/redpandaConnect/process.ts`
