---
id: 40
type: story
title: "The test panel shows line numbers and formats JSON input"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
estimate: ""
---

# The test panel shows line numbers and formats JSON input

## Description

The Bloblang test panel's input is a plain text box and its output a block of text, neither with line numbers, and a JSON input pasted on one line stays hard to read. When this is done, the input and the output content have a line-number gutter, and the input has a **Format JSON** button that pretty-prints valid JSON.

## Acceptance Criteria

1. **Line numbers on the input**
   **Given** the input content (any text, JSON or not)
   **When** the panel shows it
   **Then** a gutter numbers each line from 1, stays aligned with the text while typing and scrolling (also for long lines and empty lines), and screen readers are not read the numbers as content
2. **Line numbers on the output**
   **Given** an output content (any text)
   **When** the panel shows it
   **Then** each line has its number in a gutter, the change marks stay on their lines, and copying the output copies the text without the numbers
3. **Format JSON**
   **Given** an input that is valid JSON
   **When** the user chooses Format JSON
   **Then** the input becomes the same JSON indented with 2 spaces, as an edit: the selected sample is saved and, with Run on change on, the test runs again
4. **Not valid JSON**
   **Given** an input that is not valid JSON (or empty)
   **When** the panel shows the button
   **Then** it is disabled and says why (the input is not valid JSON); nothing changes
5. **Keyboard and screen reader**
   **Given** the button
   **When** it is reached by Tab and used with Enter or Space
   **Then** it works as a click and has a name for screen readers
6. **Nothing else changes**
   **Given** samples, metadata, Run, the generate input panel and the error cards
   **When** they are used
   **Then** they behave as today

## Boundaries

- Must not change: how the input is saved or run (beyond the format being an edit), the output's content or change marks, the host protocol.
- No new editor library (the input stays a text box).

## References

- parent — none
- related — the test panel (stories 4.2, 4.8, 4.9; `webview/src/bloblang/TestPanel.tsx`, `OutputView.tsx`)

## Notes

- Decision (user, 2026-10-30): 2-space indent; the button is disabled with a reason for input that is not valid JSON; line numbers on the input and the output always, JSON or not; formatting is an edit (saved and re-run like typing).
- Decision (user, 2026-10-30): Format JSON keeps the key order and number text as `JSON.parse`/`JSON.stringify` give them (a number like `1.0` becomes `1`, large integers may lose precision); the README says so.
- Decision (user, 2026-10-30): the generate input panel (output only) gets the output gutter; it has no input, so no button.
