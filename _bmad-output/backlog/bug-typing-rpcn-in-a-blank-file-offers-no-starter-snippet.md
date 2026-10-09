---
id: 11
type: bug
title: "Typing rpcn- in a blank file offers no starter snippet"
parent: none
covers: ["CAP-5"]
after: []
assignee: ""
refined: false
hitl: false
risk: low
severity: P3
estimate: ""
---

# Typing rpcn- in a blank file offers no starter snippet

## Description

The whole-pipeline starter and the section snippets are offered in a blank YAML file only while the file is completely empty. `SnippetCompletionProvider` (`src/adapters/vscode/snippets.ts`) treats a file as blank only when `text.trim() === ''`. When the user types the first letter of `rpcn-pipeline`, VS Code asks for completions with that letter in the file, which is now neither blank nor a detected config, so the provider returns nothing. Ctrl+Space before typing works, and the integration test only covers that path. The README says to type `rpcn-` for the sections. Found while recording the plugin demo (2026-10-09).

## Acceptance Criteria

1. **Typing in a blank file**
   **Given** an empty, undetected `.yaml` file
   **When** the user types `rpcn`
   **Then** the completion list offers "Redpanda Connect pipeline" and the section snippets
2. **Other content still excluded**
   **Given** an undetected YAML file with any other content (for example a Kubernetes manifest)
   **When** completion is requested
   **Then** no snippets are offered

## Boundaries

- Must not change: snippets in detected files; the integration test for Ctrl+Space in an empty file.

## References

- code — src/adapters/vscode/snippets.ts (`blank = text.trim() === ''`)
- source — _bmad-output/initiative-rpcn-vscode-designer/epic-smart-yaml-editing/story-pipeline-snippets-plan.md

## Notes

- A likely fix: treat the file as blank when its only content is the word under the cursor.
