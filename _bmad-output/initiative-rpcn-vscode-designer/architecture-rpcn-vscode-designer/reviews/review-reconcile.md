---
review: reconcile-inputs
target: ../architecture-rpcn-vscode-designer.md
inputs:
  - ../../brief-rpcn-vscode-designer/brief-rpcn-vscode-designer.md
  - ../../brief-rpcn-vscode-designer/addendum.md
  - ../../ux-rpcn-vscode-designer/EXPERIENCE.md
  - ../../ux-rpcn-vscode-designer/DESIGN.md
  - ../.memlog.md
date: 2026-10-05
verdict: revise (moderate) — no blockers to the paradigm, but several cross-unit seams are unspecified
---

# Reconcile-inputs review

Scope: things in the brief, addendum, EXPERIENCE.md and DESIGN.md that should constrain architecture but did not land in the spine, or where the spine contradicts an input. Only items where two independently built units could diverge are flagged.

## Verdict

**Revise (moderate).** The paradigm, layering and the major ADs reconcile cleanly with the inputs. The gaps sit at the seams between units: how diagnostics reach the graph, what the graph needs from the schema, what states the webview can be in, what one shared "this is a Redpanda Connect file" decision means, and how lint and run build their command lines. Each is a place where the graphPanel, vscode, redpandaConnect and redhatYaml adapters (or host and webview) would each invent their own answer.

## Intentional overrides — confirmed

| Override | Spine location | Listed as UX change? |
| --- | --- | --- |
| Two editor groups (WebviewPanel beside) instead of single tab with sash + Split/Graph/YAML switcher | AD-1 | Yes — Open Questions item 1 |
| Lint on save only (schema validation still live) | AD-12 | Yes — Open Questions item 2 |

Not flagged as misses. However, the knock-on effects of override 1 are not enumerated in the UX-change list (see F7).

## Findings

### F1 — Diagnostics → graph markers: no owner, no protocol message, no severity rule (HIGH)

- **Inputs:** brief ("Nodes with errors or warnings are marked, with the message on hover"); EXPERIENCE (error vs warning states, "error wins", "Node error/warning treatments update whenever either result arrives", hover shows message verbatim, collapsed group header shows contained error; error borders frozen during unparseable YAML); DESIGN (`pipeline-node-error` / `pipeline-node-warning`).
- **Spine:** AD-12 covers squiggles and dedupe only. Protocol convention lists `model`, `parseError`, `selection` — nothing carries diagnostics. Nothing says who maps diagnostics (Red Hat's, which our extension does not own, plus our lint collection) onto nodes, how severity is decided, or that `rpk connect lint` text output carries no severity at all (so the source of "lint warnings" is undefined).
- **Divergence risk:** graphPanel could read `languages.getDiagnostics` and map by range; core could attach diagnostics into the model; webview could try to match by message. Error-vs-warning precedence, innermost-node attribution, and group-header rollup would be implemented ad hoc.
- **Suggested fix (new AD):** "The host merges all diagnostics for the document (`languages.onDidChangeDiagnostics`, all sources incl. Red Hat) and maps each to the innermost node whose range contains it; it sends a `diagnostics` message `{nodeId → {severity, messages[]}}` (error wins). Severity: schema diagnostics keep Red Hat's severity; lint lines are Error unless matched by a documented rule (e.g. `--deprecated` output → Warning). On `parseError` the host does not send `diagnostics`, so the webview keeps the last markers." Add `diagnostics` to the message-type convention.

### F2 — Does the graph need the schema? Core's component-structure knowledge is unspecified, and contradicts the binary-missing state (HIGH)

- **Inputs:** EXPERIENCE/mockup binary-missing: graph shows empty state "The graph needs it to read the schema"; "Binary set after missing → graph renders without reopening". Brief success criterion **graph accuracy 100% of reference corpus** for every component, route and nested group (`switch`, `branch`, `workflow`, `try`/`catch`, brokers, resources).
- **Spine:** AD-2/AD-7 have core parse YAML to `PipelineModel` purely, with no schema input. Nothing says how core knows which fields hold child components (e.g. `branch.processors`, `switch.cases[].output`, `retry.processors`, `cached`, `for_each`, `while`, plugin components) or which key under `input:` is the component type vs `label`/`processors`.
- **Divergence risk:** one builder hard-codes a structural table, another derives it from the JSON schema; the empty-state UX implies graph is schema-gated, the spine implies it is not. Either way the graph and the binary-missing behaviour will disagree with the UX.
- **Suggested fix (new AD):** decide explicitly. Either (a) core takes a `ComponentCatalog` (plain value derived from the cached schema by the redpandaConnect adapter: component kinds, child-component field paths) and the graph is schema-gated — host sends a `schemaUnavailable` state → empty state; or (b) core uses a built-in structural table, the graph renders without a binary, and the UX empty-state copy is added to the UX-change list. Option (a) matches UX and handles custom plugins (brief: "including custom plugins").

### F3 — Webview state set incomplete in the protocol (MEDIUM)

- **Inputs:** EXPERIENCE State Patterns: no-pipeline-keys empty state, binary-missing empty state with **Install guide / Set path** buttons, schema loading (progress), unparseable on first open (banner over empty canvas), binary set after missing (auto-recover); banner click jumps to first parse error; Enter on a node moves focus to the YAML (mouse click does not necessarily).
- **Spine:** only `model`, `parseError`, `selection`, `nodeClicked`, `ready` are named.
- **Divergence risk:** host and webview each invent state names and payloads; empty-state buttons need intents (AD-3 forbids the webview calling commands), the banner click needs an offset in `parseError` and an intent back; focus behaviour of click vs Enter needs a flag.
- **Suggested fix (convention / AD-5 addendum):** enumerate the minimum union: host→webview `model`, `parseError {offset, message}`, `selection {nodeId|null}`, `diagnostics`, `status {kind: 'ready'|'schemaLoading'|'binaryMissing'|'binaryInvalid'}`; webview→host `ready`, `nodeActivated {id, via: 'click'|'keyboard'}` (keyboard ⇒ focus editor), `parseErrorBannerClicked`, `installGuideRequested`, `setPathRequested`. "No pipeline keys" = model with zero nodes, rendered by the webview.

### F4 — "Is this a Redpanda Connect file?" is consumed by four units with no single shared answer (MEDIUM)

- **Inputs:** brief/EXPERIENCE: detection by content (top-level `input`/`pipeline`/`output`/resource keys) + workspace pattern setting; "Open in Designer" for files that are not (yet) detected (Flow 3: file created as plain YAML, then content becomes RPCN); resource files are first-class ("single-file configs plus resource files").
- **Spine:** file detection is a pure core function (good), but consumers are the Red Hat contributor (AD-11, URI-based callback), graph auto-open (AD-1), lint-on-save (AD-12), Run (AD-13). Nothing says when detection is re-evaluated (on every change? on open only?), and what "Show graph" on an undetected file does to schema/lint (manual opt-in). The "Open in Designer" command from the inputs has no mapping to `showGraph`.
- **Divergence risk:** schema applied but graph not offered, or graph shown but no schema/lint, for the same file; Flow 3 breaks if the contributor only evaluates at open.
- **Suggested fix (convention):** "One `RpcnDocumentRegistry` in `src/adapters/vscode` caches per-URI detection (core function, re-evaluated on change) plus a session manual opt-in set by `showGraph`; the contributor, auto-open, lint and Run all query it. `showGraph` is the 'Open in Designer' command (alias title)." Also define resource-file detection (only `*_resources` keys) here.

### F5 — Lint and Run command lines: resources, env files and env-var interpolation not shared (MEDIUM)

- **Inputs:** brief "single-file configs plus resource files"; `${ENV}` must not be at risk; addendum CLI flags `-r` (resources), `-e` (env file), `--skip-env-var-check` on lint, `-r`/`-e`/`--set` on run; success criterion **diagnostics parity** with `rpk connect lint`.
- **Spine:** AD-9 owns spawning, AD-13 owns the run terminal, but no rule says lint and run build arguments from the same source (which resource files, which env file, whether unset env vars are checked).
- **Divergence risk:** lint passes no `-r` and reports unknown resource references that run would resolve (or vice-versa); lint without `-e` errors on unset env vars that run would have. Parity becomes undefined.
- **Suggested fix (extend AD-9):** "The RedpandaConnect adapter has one argument builder used by both lint and run: resource files (setting `redpandaConnect.resourcePaths`, plus detected resource files in the workspace `[ASSUMPTION]`) → `-r`, env file (setting `redpandaConnect.envFile`) → `-e`. Lint passes `--skip-env-var-check` unless an env file is configured." Note the setting names in the ID convention.

### F6 — Schema transform: diagnostics parity, `${ENV}` interpolation, hover examples and snippets need one place (MEDIUM)

- **Inputs:** diagnostics parity criterion; `${ENV}` / `${! }` interpolation in values; "hover docs with examples"; snippets; completion offers only valid keys/values; memlog constraint: generated jsonschema has `definitions`/`$ref`, no `$schema`, custom `is_*` keys.
- **Spine:** AD-10 caches the raw generated schema; AD-12 says "our own providers add … hover examples and snippets" while Red Hat already supplies hover from the schema.
- **Divergence risk:** (1) Red Hat flags `count: ${COUNT}` on an integer field as a type error that lint does not → parity broken and dedupe (AD-12 suppresses lint, not schema) cannot fix it; (2) our hover provider and Red Hat's hover both show the field docs, stacked; (3) snippets defined both as VS Code snippets and as schema `defaultSnippets`.
- **Suggested fix (new AD or extend AD-10):** "Before caching, the RedpandaConnect adapter applies one schema transform: add `$schema`, allow interpolation strings (`^\$\{.*\}$`) on every non-string scalar, fold examples into `markdownDescription`, attach `defaultSnippets`. Hover and snippets are delivered through the schema; we register no HoverProvider. Diagnostics parity is tested against the transformed schema." Bump the cache key with a transform version.

### F7 — Knock-on UX changes from AD-1 not listed; addendum's CustomTextEditorProvider note overridden silently (LOW–MEDIUM)

- **Inputs:** EXPERIENCE: per-file last-used view persistence; Graph-only view; "in Graph-only, click switches to Split"; Flow 1 step 3 (Graph-only + fit); "Open in Designer" naming. Addendum technical note: use `CustomTextEditorProvider`. Brief: "custom editor … Tabs switch to the graph alone or the YAML alone".
- **Spine:** Open Questions item 1 covers the switcher only.
- **Divergence risk:** UX/story writers keep building per-file view memory or Graph-only behaviour from EXPERIENCE.md; no AD says what is remembered (graph visible/hidden per file? panel restore after window reload via `WebviewPanelSerializer`?).
- **Suggested fix:** extend Open Questions item 1 to list: drop per-file view persistence (or redefine as per-file graph visible/hidden), drop Graph-only click→Split, map "Open in Designer" → `showGraph`, rewrite Flow 1 step 3; note in AD-1 that it supersedes the addendum's `CustomTextEditorProvider` note and the brief's "tabs"; state whether the graph panel is restored on reload (serializer yes/no).

### F8 — Webview-local view state is real but AD-3 calls the webview "stateless" (LOW)

- **Inputs:** EXPERIENCE: groups always expanded on open; collapse state not persisted across sessions but preserved across re-renders when the node still exists; layout stable across re-renders; selection preserved; keyboard focus / arrow navigation in flow order.
- **Spine:** AD-3 "stateless renderer"; AD-6 "reconciles by node ID"; AD-8 says neither side stores a selected node ID.
- **Divergence risk:** implementers either push collapse state to the host (breaking AD-3 intent-only) or persist it via `vscode.setState` (breaking "not persisted"). Hidden panels without `retainContextWhenHidden` lose it silently.
- **Suggested fix (clarify AD-3):** "The webview owns ephemeral view state only — collapse set, viewport, keyboard focus — keyed by node ID, never sent to the host, never written to `setState`. Groups default to expanded." State the `retainContextWhenHidden` choice. Also: core must keep node IDs unique when duplicate `label`s appear mid-edit (AD-7: fall back to YAML path on collision).

### F9 — Quick Fix edit discipline (addendum) not carried into an AD (LOW)

- **Inputs:** brief "the only edits it makes are Quick Fixes the developer chooses"; addendum "apply them as minimal text edits … never by re-serializing the whole file".
- **Spine:** AD-2 says only core parses YAML; nothing forbids `doc.toString()` re-serialization in a CodeActionProvider, nor says Quick Fixes target Red Hat-owned schema diagnostics (the "did you mean `topic`" case is a schema diagnostic, not a lint one).
- **Suggested fix (convention):** "Quick Fixes are `WorkspaceEdit` range replacements of the offending token only; never re-serialize the document. The CodeActionProvider handles diagnostics from both Red Hat (source `yaml-schema`) and our lint collection; suggestions come from the cached schema."

### F10 — Success-criteria testing needs a binary in CI and a parity test (LOW)

- **Inputs:** brief graph-accuracy and diagnostics-parity criteria over a reference corpus (incl. cookbook examples); addendum "build the reference corpus early".
- **Spine:** Tests convention covers vitest on `test/corpus/`; CI row does not install `rpk`/`redpanda-connect`, so parity cannot be measured.
- **Suggested fix (convention):** "`test/corpus/` holds cookbook + community configs, each with an expected-graph fixture; a CI job installs a pinned Redpanda Connect binary and asserts editor diagnostics (schema-transformed + lint) equal `rpk connect lint` output."

### F11 — Minor items (no AD needed, note only)

- Project license Apache-2.0 not in the Operational envelope; elkjs EPL-2.0 bundling note should be stated relative to it.
- Deployment-target separation: addendum asks to keep it separate "in the data model" now; spine defers it. Acceptable since there is no deploy model yet; suggest one line: the run target (local binary) is a parameter of the RedpandaConnect adapter, not baked into commands.
- Addendum's "run groundwork for per-processor output/metrics" is a PRD note; not reflected in Deferred. Add a Deferred row so it is a conscious omission.
- Theme variables / high-contrast / codicons (DESIGN) need no AD; webview CSS uses `--vscode-*` variables, consistent with the stack (`@vscode/codicons`, `@vscode-elements/elements`). No conflict.
- Accessible node labels ("Processor switch, 3 cases, has error") require `PipelineModel` nodes to carry role, component type, label and child-count summary; worth a one-line note on the model shape in AD-4/AD-5.

## Reconciled (no action)

Graph read-only; YAML single source of truth; last valid graph + banner on parse error; cursor→innermost node highlight (AD-8, innermost rule implicit in range containment — could be stated); node click reveals range; binary detection order and path setting; schema per version cache; Bloblang highlighting incl. `${! }`; snippets/hover/Quick Fixes named; Run auto-save + reused terminal + status-bar Stop; terminal name matches UX string; Open VSX + Marketplace distribution; Red Hat available on Open VSX; streams mode, graph editing, bundled schema, BYOC, testing/AI/metrics deferred; large configs out of scope.
