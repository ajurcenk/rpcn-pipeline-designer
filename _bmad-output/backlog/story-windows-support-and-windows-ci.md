---
id: 1
type: story
title: "The extension works on Windows and CI proves it"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
estimate: ""
---

# The extension works on Windows and CI proves it

## Description

The win32 code paths (PATH lookup with `.exe`, no executable-bit check, path normalization) exist but have never run. Every test uses POSIX shell scripts as fake binaries and CI runs only on Linux. When this is done, a Windows developer gets the same binary resolution, schema and lint behavior, and CI runs the suite and the corpus harness on Windows.

## Acceptance Criteria

1. **Binary found on Windows**
   **Given** `redpanda-connect.exe` or `rpk.exe` on `PATH` on Windows
   **When** the extension activates
   **Then** `binaryState` is `ok` with that binary, and `rpk.exe` runs as `rpk connect`
2. **Paths resolved the Windows way**
   **Given** `redpandaConnect.binaryPath`, `resourceFiles` or `envFile` set to a drive-letter path or a relative path with a workspace open
   **When** the binary, lint or run arguments are resolved
   **Then** the same rules apply as on Linux and the resulting paths use the platform's separators
3. **Suite runs on Windows**
   **Given** a push
   **When** CI runs
   **Then** the unit/integration suite and the corpus harness also run and pass on a Windows runner
4. **Linux unchanged**
   **Given** the Linux CI job
   **When** it runs
   **Then** its results are unchanged

## Boundaries

- Must not change: the PATH-first resolution order (AD-9), log and notification wording, the Linux argv the builder produces.

## References

- source — _bmad-output/initiative-rpcn-vscode-designer/epic-foundation/story-refactor-sweep-plan.md, Implementation Notes (backlog list)
- architecture — _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md, AD-9

## Notes

- Assumption: macOS is not part of this ticket; it gets its own ticket if wanted.
- Open question: the Windows release archive name and format; `fetch-binaries.sh` maps Linux/macOS and `.tar.gz` only, so the corpus harness on Windows needs it extended or a PowerShell twin.
- Open question: whether a native Windows `rpk.exe` with `connect` exists; if not, the rpk half of criterion 1 is tested with a fake binary only.
- Note: the spec sets no platform constraint; this ticket adds Windows as a supported platform.
- Decision: kept as one ticket, not split into Windows CI and Windows corpus harness (user, 2026-10-06) — both only make sense together.
