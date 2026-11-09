---
id: 41
type: bug
title: "CI timing flakes in the integration suites (epic 6 findings)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: low
severity: P2
estimate: ""
---

# CI timing flakes in the integration suites (epic 6 findings)

## Description

Four integration tests fail now and then in a full stable run, locally or in CI, and pass when rerun on the same code. A red run then has to be rerun by hand, and a real failure can hide among them. None of the changes that saw them touched the code the tests cover. When this bug is fixed, each test passes in repeated full runs, or is proven to depend on something else and fixed there.

## Reproduction

Run the full stable suite (`npm run pretest`, then `vscode-test --label stable` under `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`, capped with `timeout`) several times on one commit, or rerun CI. Seen so far:

1. Graph markers, "HELD (story 13): a Red Hat marker stays on its node when a node is inserted above it before Red Hat republishes": "the edit's model and status". In the 5.5 implementer's full run (passed alone), CI run 42058471336 (VS Code 1.145.0), CI run 42334757404.
2. Environment view, "ticket 39 VALUE_DEFAULT … its record goes too": in 6.3's floor run and 6.5's stable run (VS Code 1.145.0, 1319 passing, 1 failing); the suite alone passed 34 of 34 both times.
3. "Live Bloblang diagnostics (integration, 4.5)": a full stable run stalled 44 minutes in this suite (VS Code 1.145.2, newly downloaded, 2026-11-06); the rerun passed in 9 minutes. The stalled run, stopped by PID, left a `binaryPath` in the test settings.
4. Bloblang test panel, "RENAME (4.17): the same panel under the new name, its snapshot names the new files, the samples file moved and still shown": "the old samples file is gone". CI run 42334757404 (stable, 1356 passing, 2 failing with item 1); the rerun passed.

## Cause Hypothesis

Each looks like a wait that is too short or ends on the wrong signal under load: a marker republish or diagnostics racing the edit (1, 3), a settings or secret-storage write not yet seen (2), a file move reported before it is done (4). The 4.5 stall may be a wait with no time limit. These are guesses from the failure texts; each test's own wait needs reading.

## Acceptance Criteria

1. **The tests pass reliably**
   **Given** one commit
   **When** the full stable suite runs 8 times (locally or in CI)
   **Then** none of the four tests fails, and no run stalls
2. **Tests cover the condition found and fixed**
   **Given** each test's cause found
   **When** the fix lands
   **Then** the test waits on the condition it checks (or the code it covers stops racing), with its assertions unchanged, and the 4.5 suite cannot wait without a time limit
3. **Or: no change is needed, with proof**
   **Given** the reproduction
   **When** it runs on the current code
   **Then** the failures no longer occur, with the run count and the commit recorded in Notes — this supersedes 1 and 2

## References

- parent — none
- source — _bmad-output/initiative-rpcn-vscode-designer/deferred-work.md, the entries for these four tests
- related — _bmad-output/backlog/bug-graph-webview-ready-timing-flakes-in-ci.md (bug 21, done)

## Notes

- Decision: moved here from epic 6's refactor sweep (6.9) rather than fixed there (user, 2026-11-09).
- Decision: no floor (VS Code 1.100.0) runs (user).
