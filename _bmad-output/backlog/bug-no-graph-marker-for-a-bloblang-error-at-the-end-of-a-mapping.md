---
id: 20
type: bug
title: "No graph marker for a Bloblang error at the end of a mapping"
parent: none
covers: ["CAP-15", "CAP-10"]
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
estimate: ""
---

# No graph marker for a Bloblang error at the end of a mapping

## Description

When a live Bloblang parse error sits at the very end of a `mapping` / `mutation` (for example `root.score = this.total *` typed as the mapping's last line), the editor underlines it with the binary's message, but the processor's graph node gets no error marker (ticket 4.6). The same error in the middle of the mapping marks the node. Found while recording the mapping editor demo (2026-10-20).

Likely cause: the binary reports the position just past the last character. The position map turns that into the offset where the mapping's text ends, which is also where the processor node's range ends. `nodeAt` (`src/core/nodeAt.ts`) matches a node only for `start <= offset < end`, so that offset falls outside the processor (and onto its parent, or no node). Not yet confirmed with a test.

When this bug is fixed, a Bloblang error at the end of a mapping marks its processor's node like any other Bloblang error, without changing how the cursor selects nodes (AD-16: selection and node status share `nodeAt`).

## Acceptance Criteria

1. **End-of-mapping error marks its node**
   - Given a `mapping` / `mutation` whose live Bloblang error the binary reports past its last character (for example `root.score = this.total *` as the last line), including the processor that is last in its list or last in the file,
   - When the error is published,
   - Then the processor's graph node gets the error marker with the binary's message, like a mid-mapping error.
2. **Trailing whitespace and blank lines**
   - Given the same error reported on a blank or whitespace-only position after the mapping's text,
   - When it is published,
   - Then the marker still lands on that processor's node, not on its parent or none.
3. **Selection unchanged**
   - Given the cursor at the end of a mapping's last line, or past it,
   - When the selection is computed,
   - Then the selected node is exactly what it is today. The fix is in where a Bloblang diagnostic is mapped for node status only (`statusDiagnostics`), not in `nodeAt` (AD-16).
4. **No other marker moves**
   - Given lint and Red Hat diagnostics, and Bloblang errors that are not at the end,
   - When node status is computed,
   - Then their nodes are unchanged.

Verify: a unit test of `statusDiagnostics` for criteria 1, 2 and 4 with end-of-text, line-end and blank-line positions. An integration test (suite 91, fake binary `ERR@` at the last position) checks the marker on the last processor and on a nested one. Suite 81's selection tests stay green unchanged.

## Notes

- Places to look:
  - `src/adapters/graphPanel/status.ts` (`statusDiagnostics`, the offset per diagnostic);
  - `src/core/nodeStatus.ts`;
  - `src/core/nodeAt.ts`;
  - `src/core/bloblangPositions.ts` (clamping past the end).
- A fix could map a Bloblang diagnostic at its range start clamped inside the processor's value, or treat an end-of-node offset as inside the node for status only. The latter must not change selection.
