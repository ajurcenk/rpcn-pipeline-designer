---
id: 13
type: story
title: "Node markers wait for Red Hat to republish after an edit"
parent: none
covers: ["CAP-10"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# Node markers wait for Red Hat to republish after an edit

## Description

Node markers (3.8, AD-17) map the file's diagnostics to nodes after every model. YAML by Red Hat's published ranges are not shifted by an edit: until Red Hat republishes (debounced, well under a second), the host maps its old ranges onto the new model, so one of its markers can sit one node off. 3.8 deferred this as known and transient (review row 10). It is noted in `GraphPanel.sendModel` (`src/adapters/graphPanel/graphPanel.ts`).

When this story is done, a Red Hat marker never shows on a node it does not belong to after an edit: the host holds or drops Red Hat's markers on a changed file until Red Hat republishes, while lint's markers keep following AD-17.

## Acceptance Criteria

1. **No wrong node**
   **Given** a Red Hat diagnostic on a node, with a node inserted above it
   **When** the edit's model is sent before Red Hat republishes
   **Then** no `nodeStatus` puts that diagnostic on another node
2. **Republished**
   **Given** the same edit
   **When** Red Hat republishes
   **Then** the marker is back on its node, sent once

## Boundaries

- Lint's clear-on-first-edit rule (AD-17) does not change.
- No change to the `nodeStatus` protocol message.

## References

- source: the 3.12 refactor sweep, item 8 (3.8 review row 10, deferred).
- architecture: AD-17 (node status from the deduplicated diagnostics).
- code: `src/adapters/graphPanel/graphPanel.ts` (`sendModel`, `diagnosticsChanged`), `src/adapters/vscode/diagnostics.ts`.

## Notes

- **Candidate approach:** remember the document version each Red Hat diagnostic set was published for, and skip Red Hat's diagnostics in `statusDiagnostics` while the document is newer.
