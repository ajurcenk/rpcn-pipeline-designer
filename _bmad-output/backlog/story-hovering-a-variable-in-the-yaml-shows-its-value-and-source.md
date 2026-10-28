---
id: 34
type: story
title: "Hovering a variable in the YAML shows its value and source"
parent: none
covers: []
after: [31]
assignee: ""
refined: true
hitl: false
risk: low
estimate: ""
---

# Hovering a variable in the YAML shows its value and source

## Description

A config's variable values show only in the Environment view (ticket 31), away from the line that uses them. When this is done, hovering `${NAME}`, `${NAME:default}` or Bloblang's `env("NAME")` in a detected config shows the value the commands would get, its source, and what it overrides. The sources, precedence and masking are the Environment view's. A masked value can be revealed in the Environment view, and a missing variable can be set from the hover with ticket 31's set action.

## Acceptance Criteria

1. **The value the commands get**
   **Given** a detected config using `${NAME}` or `env("NAME")` with a literal name, and a source that sets NAME
   **When** the user hovers the variable
   **Then** the hover shows NAME, the source it comes from (with the settings level for `redpandaConnect.env`), and each weaker source it overrides, in the Environment view's precedence
2. **Masked values stay masked**
   **Given** the value comes from a secret, the env file or VS Code's environment
   **When** the hover shows it
   **Then** the value is masked as in the Environment view, and a "Show value" link reveals that variable's row in the Environment view; the hover never holds the value in clear
   **And** a plain value from `redpandaConnect.env` is shown in clear
3. **A missing variable**
   **Given** nothing sets NAME and it has no default
   **When** the user hovers it
   **Then** the hover says it is missing, and a "Set variable…" link runs ticket 31's set action for NAME and the config
4. **A default**
   **Given** `${NAME:default}` and nothing sets NAME
   **When** the user hovers it
   **Then** the hover says the default is used and shows it
5. **Current values**
   **Given** a change of `redpandaConnect.env`, `secretEnv`, `envFile`, a secret or the env file on disk
   **When** the user hovers again
   **Then** the hover shows the new state
6. **Nothing else changes**
   **Given** a file that is not a detected config, text that is not a variable, or a non-literal `env(...)` name
   **When** the user hovers
   **Then** no variable hover is shown, and the other hovers (Bloblang, YAML by Red Hat) are as today

## Boundaries

- Must not change: how variables reach the commands, their precedence, the Environment view and its set action (ticket 31).
- No value in a log line or message; masked values never appear in clear in a hover.

## References

- parent — none
- related — _bmad-output/backlog/story-an-environment-view-shows-each-configs-variables.md (ticket 31: sources, precedence, masking, the set action)
- related — _bmad-output/backlog/story-the-test-panel-offers-to-set-an-unset-variable.md (ticket 32: the set action from another place)

## Notes

- Decision (user, 2026-10-28): the hover first; inline value hints and the graph were offered and not chosen.
- Decision (user, 2026-10-28): the hover appears beside the existing Bloblang hover on `env("NAME")` inside a mapping (VS Code shows both), rather than replacing it.
- Decision (user, 2026-10-28): "Show value" opens the Environment view on the config and reveals that one row, as the view's own Show value does; the hover itself stays masked.
