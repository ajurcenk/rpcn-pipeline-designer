---
title: 'No graph marker for a Bloblang error at the end of a mapping'
type: 'bugfix'
ticket: '20'
created: '2026-10-22'
status: 'built'
baseline_revision: 'fa05366dd1fd89f65617a9eceb576a40b3dbf15c'
route: 'oneshot'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/backlog/bug-no-graph-marker-for-a-bloblang-error-at-the-end-of-a-mapping.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A live Bloblang error that the binary reports past a mapping's last character is underlined, but its processor's graph node gets no marker. `statusDiagnostics` maps a non-lint diagnostic at its range start, and that offset equals the processor node's range end. `nodeAt` excludes that end (`start <= offset < end`), so the error lands on the parent or on no node.

**Approach:** In `statusDiagnostics` only (`src/adapters/graphPanel/status.ts`), a `Bloblang`-source diagnostic whose start is at a line's end, or on a blank or whitespace-only position, is mapped at the last non-whitespace character before it. That character is inside the mapping's value, so inside the processor node. Selection (`nodeAt`) and every other diagnostic are unchanged. The reproduction is confirmed with a test before the fix.

</frozen-after-approval>

## Implementation Notes

- **Oneshot route:** about 20 lines of code plus tests.
- **Files:**
  - `src/adapters/graphPanel/status.ts:25-36`;
  - the source constant `BLOBLANG_SOURCE` in `src/adapters/vscode/bloblangDiagnostics.ts`;
  - the unit tests next to the existing `statusDiagnostics` test (grep `statusDiagnostics` in `src/test`);
  - integration suite `src/test/integration/suites/91-bloblang-diagnostics.ts` (GRAPH MARKED / NESTED pattern, fake binary `ERR@L:C`).
- **Order:** write the failing integration case first, to confirm the cause.
- **Docs:** CHANGELOG ("Fixed").

## Verification

- `npm run compile`; `npm run test:webview`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone); suite 91 and suite 81 pinned to 2 CPUs (`taskset -c 0,1 xvfb-run -a`) 5 times (AI-2); `npm run test:corpus` -- all pass.
- Manual: in the dev host, type `root.x = this.y *` as the last line of a mapping, and its graph node turns red.

**Results (2026-10-22):** `npm run compile` OK; `npm run test:webview` 302; `npm run test:corpus` 156; full stable suite under `xvfb-run -a` (alone) 853 passing; suites 91 and 81 pinned to 2 CPUs, 5 runs in a row, 27 passing each. The new integration case failed before the fix (node status `{}`). Review: the orchestrator read the product diff (oneshot): status-only, Bloblang source only, and only when whitespace alone follows the start. Manual check (the user, dev host, 2026-10-22): ` *` typed at the end of the last mapping line underlines the error and turns the `total` node red; removing it clears both. No issues.
