---
id: 32
type: story
title: "The test panel offers to set a variable its run found unset"
parent: none
covers: []
after: [31]
assignee: ""
refined: false
hitl: false
risk: low
estimate: ""
---

# The test panel offers to set a variable its run found unset

## Description

When a test run stops because the config uses a variable nothing sets, the panel shows "The test could not run" with the binary's message and nothing to do about it. When this is done, that result names the unset variables and offers "Set NAME…" for each, which runs ticket 31's set action (plain or secret); after it, the panel runs again with Run on change.

## Acceptance Criteria

1. **The unset variables are offered**
   **Given** a test run stopped by `required environment variables were not set: [REGION ZONE]`
   **When** the panel shows the result
   **Then** it offers "Set REGION…" and "Set ZONE…", reachable by keyboard and named for screen readers
2. **The action sets it and the panel runs again**
   **Given** the panel offers "Set REGION…"
   **When** the user chooses it and sets a value (plain or secret)
   **Then** the variable is set as ticket 31's set action does, and with Run on change the panel runs again with it
   **And** cancelling changes nothing
3. **Other errors are unchanged**
   **Given** any other "could not run" result
   **When** the panel shows it
   **Then** it looks and behaves as today

## Boundaries

- Must not change: the other result kinds, the panel's other messages, how variables reach the commands.

## References

- parent — none
- related — _bmad-output/backlog/story-an-environment-view-shows-each-configs-variables.md (ticket 31, the set action)
- design — https://claude.ai/artifact/DaPANUeVy98mvkMr1YxtP5, artboard "C · A missing variable, fixed from the test panel"

## Notes

- Decision (user, 2026-10-28): split from ticket 31.
- Assumption: only the `${VAR}` lint message names unset variables; an unset `env("VAR")` in a mapping is a mapping result, not this one, and gets no button.
