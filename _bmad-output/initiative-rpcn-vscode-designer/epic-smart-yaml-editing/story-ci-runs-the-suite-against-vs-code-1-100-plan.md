---
title: 'CI runs the suite against VS Code 1.100'
type: 'chore'
ticket: '11'
created: '2026-10-08'
status: 'built'
baseline_revision: 'abae6f9f12658ceedf9af0411b2d2825dee552dc'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'risk'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/epic-foundation-retrospective.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `package.json` promises `engines.vscode ^1.100.0`, but the suite only ran on the latest VS Code download (retro F11, action A4; E2 R11).

**Approach (E2 inception decision, 2026-10-06; user, 2026-10-08: "continue to next step"):**
- `.vscode-test.mjs` defines two labelled configurations of the same suite: `stable` (latest) and `floor` (`version: '1.100.0'`).
- `npm test` runs both; CI runs `npm test` and caches the pinned 1.100.0 download.

## Boundaries & Constraints

**Always:** the same tests, with no skips per version.

**Never:**
- raising the engines floor;
- a separate test list per version.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| STABLE | `npm test` | all tests pass on the latest stable release (1.141.0 today) | — |
| FLOOR | `npm test` | all tests pass on 1.100.0 | — |
| CI | a push | both runs pass in CI | — |

</frozen-after-approval>

## Implementation Notes

- **Red Hat YAML:** 1.24.0 declares `engines.vscode ^1.63.0`, so the floor run installs it as well.
- **Local runs:** 508 passing on 1.141.0 and 508 passing on 1.100.0. This includes the 2.9 Bloblang tokenization tests, which load the running VS Code's own YAML grammar (`vscode.env.appRoot`), so the injection is now checked against 1.100's grammar too.
- **CI:**
  - `actions/cache` holds `.vscode-test/vscode-linux-x64-1.100.0`, keyed on the OS and architecture. A VS Code download timed out once before (the 2.18 flake).
  - The latest stable is downloaded fresh each run.
- **Running one version:** `npx vscode-test --label stable` or `--label floor`, after `npm run pretest`.

## Review Triage Log

**Pass 1 (quick, inline by the parent, 2026-10-08):** I checked the config and workflow diff, both local runs and the cache key. No findings.

**Re-verification:** `npm test` 508 passing ×2 (1.141.0, 1.100.0); `npm run test:corpus` 89 passed.
