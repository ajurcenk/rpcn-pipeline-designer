---
id: 20
type: bug
title: "No graph marker for a Bloblang error at the end of a mapping"
parent: none
covers: ["CAP-15", "CAP-10"]
after: []
assignee: ""
refined: false
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

## Notes

- Places to look:
  - `src/adapters/graphPanel/status.ts` (`statusDiagnostics`, the offset per diagnostic);
  - `src/core/nodeStatus.ts`;
  - `src/core/nodeAt.ts`;
  - `src/core/bloblangPositions.ts` (clamping past the end).
- A fix could map a Bloblang diagnostic at its range start clamped inside the processor's value, or treat an end-of-node offset as inside the node for status only. The latter must not change selection.
