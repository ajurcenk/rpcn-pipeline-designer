---
title: "DESIGN — Redpanda Connect Designer for VS Code"
status: final
created: 2026-10-05
updated: 2026-10-05
sources:
  - ../brief-rpcn-vscode-designer/brief-rpcn-vscode-designer.md
  - ../brief-rpcn-vscode-designer/addendum.md
  - ../architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
name: Redpanda Connect Designer (working name)
description: VS Code extension showing a read-only pipeline graph panel beside the native YAML editor. Inherits the active VS Code theme wholesale; no brand layer.
colors:
  # UI system = VS Code. Every value is a VS Code theme CSS variable, resolved at
  # runtime in light, dark and high-contrast themes. No hex values on purpose:
  # the active theme owns rendered colors (spec "UI-system inheritance" pattern).
  surface: 'var(--vscode-editor-background)'
  on-surface: 'var(--vscode-editor-foreground)'
  on-surface-muted: 'var(--vscode-descriptionForeground)'
  node-surface: 'var(--vscode-editorWidget-background)'
  node-border: 'var(--vscode-editorWidget-border, var(--vscode-panel-border))'
  group-border: 'var(--vscode-panel-border)'
  edge: 'var(--vscode-editorLineNumber-foreground)'
  focus: 'var(--vscode-focusBorder)'
  selection: 'var(--vscode-list-activeSelectionBackground)'
  on-selection: 'var(--vscode-list-activeSelectionForeground)'
  error: 'var(--vscode-errorForeground)'
  error-border: 'var(--vscode-inputValidation-errorBorder)'
  warning: 'var(--vscode-editorWarning-foreground)'
  warning-border: 'var(--vscode-editorWarning-border, var(--vscode-editorWarning-foreground))'
  banner-surface: 'var(--vscode-inputValidation-warningBackground)'
  banner-border: 'var(--vscode-inputValidation-warningBorder)'
  hover-surface: 'var(--vscode-editorHoverWidget-background)'
  hover-border: 'var(--vscode-editorHoverWidget-border)'
  link: 'var(--vscode-textLink-foreground)'
  button-surface: 'var(--vscode-button-background)'
  on-button: 'var(--vscode-button-foreground)'
  contrast-border: 'var(--vscode-contrastBorder, transparent)'
typography:
  ui:
    fontFamily: 'var(--vscode-font-family)'
    fontSize: 'var(--vscode-font-size)'
    fontWeight: 'var(--vscode-font-weight)'
  ui-muted:
    fontFamily: 'var(--vscode-font-family)'
    fontSize: 'var(--vscode-font-size)'
    note: 'Rendered in {colors.on-surface-muted}'
  code:
    fontFamily: 'var(--vscode-editor-font-family)'
    fontSize: 'var(--vscode-editor-font-size)'
rounded:
  # [ASSUMPTION] Matches VS Code widget corners.
  sm: 2px
  md: 4px
spacing:
  # [ASSUMPTION] 4-based scale, matching VS Code widget density.
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  '6': 24px
components:
  pipeline-node:
    background: '{colors.node-surface}'
    foreground: '{colors.on-surface}'
    border: '1px solid {colors.node-border}'
    radius: '{rounded.md}'
    padding: '{spacing.2}'
    title: '{typography.ui}'
    subtitle: '{typography.ui-muted}'
  pipeline-node-selected:
    background: '{colors.selection}'
    foreground: '{colors.on-selection}'
  pipeline-node-focused:
    outline: '1px solid {colors.focus}'
  pipeline-node-error:
    border: '2px solid {colors.error-border}'
    icon: 'codicon-error in {colors.error}'
  pipeline-node-warning:
    border: '2px solid {colors.warning-border}'
    icon: 'codicon-warning in {colors.warning}'
    note: 'Error wins when a node has both'
  group-box:
    background: 'transparent'
    border: '1px solid {colors.group-border}'
    radius: '{rounded.md}'
    padding: '{spacing.3}'
    header: '{typography.ui-muted}'
  graph-edge:
    stroke: '{colors.edge}'
  invalid-yaml-banner:
    background: '{colors.banner-surface}'
    border: '1px solid {colors.banner-border}'
    foreground: '{colors.on-surface}'
    icon: 'codicon-warning in {colors.warning}'
    padding: '{spacing.2}'
  graph-empty-state:
    foreground: '{colors.on-surface-muted}'
    action: '{colors.link}'
  graph-toggle:
    icon: 'codicon-type-hierarchy'  # [ASSUMPTION]; label 'Show graph' / 'Hide graph'
    note: 'Native VS Code editor-title action on the YAML editor; no custom styling'
---

## Brand & Style

The designer is a VS Code citizen, not a product with its own skin. It should read as though it shipped inside the editor: same colors, same fonts, same density, and same icons. The graph is a tool for understanding a pipeline, so it stays quiet. Structure carries the meaning, not decoration. There is no brand accent, no Redpanda branding (per the brief, the name must not imply official Redpanda branding), and no color coding by component type.

Visual references: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html), [mockups/key-binary-missing.html](mockups/key-binary-missing.html), [mockups/key-run.html](mockups/key-run.html). **This spine wins on any conflict with a mockup** (mockups embed sample hex values only to simulate a theme outside VS Code).

## Colors

Every color token is a VS Code theme variable, so light, dark, and high-contrast themes work without extra effort.

**Accepted deviation:** no hex values and no contrast-ratio targets are specified, because the active VS Code theme (including high-contrast themes) owns both color and contrast.

- **Surface / on-surface** come from the editor, so the graph panel looks like the YAML editor next to it.
- **Node surface / borders** use editor-widget tokens: nodes look like VS Code widgets placed on the editor canvas.
- **Error** (`{colors.error}`, `{colors.error-border}`) and **warning** (`{colors.warning}`, `{colors.warning-border}`) are the only signal colors on the graph, and each always comes with its own icon.
- **Warning** tokens mark lint-warning nodes; the **banner** tokens are used only for the invalid-YAML ("last valid state") banner.
- **Focus** (`{colors.focus}`) is VS Code's `focusBorder`, so keyboard focus looks the same as everywhere else in the editor.
- **Contrast border** is present only in high-contrast themes; every node, group, and banner adds it to its outline.

Avoid: per-component-type hues (input/processor/output are told apart by position and label, not color), gradients, and any color outside the theme.

## Typography

There are two font families, both inherited. `{typography.ui}` (the workbench font) is used for node titles, group headers, the banner, and empty states. `{typography.code}` (the editor font) is used wherever a literal YAML value or component name appears inline, for example, `kafka_franz` or a `check` expression in a node subtitle. The font size follows the user's VS Code setting, and the graph sets no sizes of its own.

## Layout & Spacing

The window uses **two VS Code editor groups** (architecture AD-1): the native YAML editor on the left and the graph panel on the right, in a locked group. VS Code's own group divider separates and resizes them; the extension draws no sash or pane chrome of its own. The graph canvas fills its panel, with no fixed width.

Inside the graph, spacing follows a 4-based scale (`{spacing.1}`–`{spacing.6}`) `[ASSUMPTION]`. Nodes are laid out automatically in flow order, left to right: input → processors → output `[ASSUMPTION]`. Group boxes indent their children by `{spacing.3}`. Resources sit in a separate area outside the main flow `[ASSUMPTION]`. Mock: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html).

## Elevation & Depth

None. Nodes and groups are flat, separated by borders only, as VS Code widgets are. The banner and hovers use VS Code's own hover/notification chrome.

## Shapes

Corners are `{rounded.md}` on nodes and group boxes and `{rounded.sm}` on the banner `[ASSUMPTION]`. Edges are plain lines with arrowheads. No pills or circles.

## Components

- **Pipeline node.** Shows a codicon `[ASSUMPTION: Codicons for all icons]`, the component type as the title, and the `label` (if set) as a muted subtitle `[ASSUMPTION]`. The selected state uses VS Code's list-selection tokens, and the focused state adds a `{colors.focus}` outline.
- **Pipeline node (error).** A 2px `{colors.error-border}` border plus a `codicon-error` in the node's top-right corner. Never signal by color alone. Mock: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html).
- **Pipeline node (warning).** A 2px `{colors.warning-border}` border plus a `codicon-warning` (distinct from the error icon) in the same top-right position. Error treatment wins if both apply. Mock: [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html).
- **Group box.** For `switch`, `branch`, `try`/`catch`, `workflow`, and brokers: a transparent box with a `{colors.group-border}` outline and a header row (chevron codicon + block type). Children are nested inside.
- **Graph edge.** A `{colors.edge}` stroke. Edges have no labels, except `switch` cases, which show the case index or `check` excerpt in `{typography.code}` `[ASSUMPTION]`.
- **Invalid-YAML banner.** A full-width strip across the top of the graph panel, using banner tokens and a `codicon-warning`. Mock: alt state in [mockups/key-editor-and-graph.html](mockups/key-editor-and-graph.html).
- **Graph empty state.** Centered muted text with link-styled actions, filling the graph panel. Mock: [mockups/key-binary-missing.html](mockups/key-binary-missing.html).
- **Show / Hide graph toggle.** A native editor-title action on the YAML editor, `codicon-type-hierarchy` `[ASSUMPTION]`, tooltip "Show graph" / "Hide graph". No custom chrome. It replaces the earlier Split/Graph/YAML switcher.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Use VS Code theme variables for every color | Ship hex colors or a brand accent |
| Pair every error and warning with its own icon and a border | Use red alone to signal state |
| Use Codicons | Bundle a third-party icon set |
| Inherit the workbench and editor fonts and sizes | Set custom font sizes in the graph |
| Test in Light+, Dark+, and both High Contrast themes | Color nodes by component type |
