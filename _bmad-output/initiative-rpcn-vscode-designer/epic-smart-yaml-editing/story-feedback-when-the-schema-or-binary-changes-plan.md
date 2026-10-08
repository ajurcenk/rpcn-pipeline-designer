---
title: 'Feedback when the schema or binary changes'
type: 'feature'
ticket: '8'
created: '2026-10-08'
status: 'built'
baseline_revision: 'c3150a5f4053fc380d80550917951532b32ccc2b'
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

**Problem:** Refresh Schema with no usable binary cleared the schema silently (retro F3 / A1). Nothing showed that editor features follow Set path, Retry or Refresh Schema in files that are already open.

**Approach (E2 inception decision, 2026-10-06; ticket entry 8):**
- With no usable binary, Refresh Schema logs one line and shows the binary warning again, through `showBinaryWarning` (2.7).
- An integration test shows that after Set path, an already open file gets completion and lint on save without being reopened.

## Boundaries & Constraints

**Always:**
- **Warning:** the same copy and actions as at activation.
- **Reading at use time:** every editor feature reads the binary and schema when it is used, never a copy taken when the file was opened. This covers the contributor (2.1), lint (2.4), the Quick Fix (2.5/2.14), gap completion (2.16) and Run (2.7).

**Never:**
- a second warning when the binary is usable;
- reopening documents.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| REFRESH_NO_BINARY | Refresh Schema, binary missing or invalid | one log line, then the warning again; no schema | — |
| REFRESH_OK | Refresh Schema, binary usable | regenerated schema; no extra line or warning | — |
| SET_PATH_OPEN_FILE | file open while the binary is missing, then Set path | completion appears in that file; lint on save runs | — |

</frozen-after-approval>

## Implementation Notes

- **Command:** `refreshSchema(deps)` in `src/extension.ts` awaits `schemaStore.refresh()`, then checks `binary.state`. The log line is `REFRESH_NO_BINARY_LINE`.
- **Tests:**
  - `src/test/refreshSchema.test.ts` (unit, with fakes);
  - the integration suite "Binary and schema changes reach open files". It starts with a missing `binaryPath`, opens a detected file, writes the setting as the warning's Set path does, then checks the open file's completion (`address`, `network` in an empty `socket` block) and lint on save (`field nope not recognised`).
- **Retry and Refresh Schema** go through the same `RedpandaConnect.refresh()` → `onDidChange` → `SchemaStore` path as Set path.

## Review Triage Log

**Pass 1 (quick, inline by the parent, 2026-10-08):** I checked the diff, the order (feedback after the refresh settles) and that no warning appears for a usable binary (unit test). No findings.

**Re-verification:** `npm test` 467 passing; `npm run test:corpus` 65 passed.
