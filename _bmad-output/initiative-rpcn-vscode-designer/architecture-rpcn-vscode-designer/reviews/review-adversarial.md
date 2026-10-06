---
review: adversarial
target: ../architecture-rpcn-vscode-designer.md
lens: "Construct two units one level down that each obey every AD to the letter yet still build incompatibly"
date: 2026-10-05
verdict: NOT READY — tighten before slicing epics
---

# Adversarial Review — Architecture Spine, RPCN VS Code Designer

## Verdict

**Not ready to slice.** The spine's host→webview paradigm, single parser (AD-2), single protocol module (AD-5) and single process owner (AD-9) are solid. The holes are all in **cross-unit shared state that the spine names as a behavior but never assigns an owner or shape**: per-node diagnostic status, "is this an RPCN file", binary state, range semantics, node identity under collisions, panel/editor identity, and run state. In every case below, two epics can each satisfy every AD literally and still not fit together. Seven holes are blocking; four more are minor.

Units used as the "one level down" set: **P** YAML→PipelineModel parser · **R** graph webview renderer · **L** graph panel lifecycle/auto-open · **D** diagnostics (lint, dedupe, node markers) · **S** schema contributor · **B** binary adapter · **X** Run/terminal · **F** file detection · **Q** Quick Fixes/hover/snippets · **G** Bloblang grammar.

---

## Blocking holes

### H1 — Diagnostics → node markers have no owner, no message and no shape (D vs R, D vs L)

**Clash construction.**
- *D* (obeys AD-12, Conventions "Text ranges") publishes lint diagnostics into a `DiagnosticCollection` as VS Code `Range`s, and considers node markers "the graph's job".
- *L* (obeys AD-5, AD-6) sends `model`, `parseError` and `selection`, the only messages named. `PipelineModel` (AD-4) has "nodes, edges, groups and text ranges". There is nothing about status, so L sends no status.
- *R* (obeys AD-3: "renders the latest model it was sent") has no input to draw error or warning borders from. Suppose R's author adds `severity` to `PipelineModel` nodes. Then P has to compute it, but P is pure (AD-15) and can't see Red Hat diagnostics. Suppose D's author adds a `diagnostics` message carrying VS Code `Range`s instead. Then R has to map ranges to nodes, which duplicates AD-8's containment logic in the webview and uses line/col where the model uses offsets.
- Further conflicts the spine leaves open: (a) Red Hat diagnostics are owned by another extension, so they can only be read via `languages.getDiagnostics(uri)` / `onDidChangeDiagnostics`. That event also fires for our own collection, so a dedupe recompute loops unless it filters by source. (b) Whether node markers use the **deduped** set or the raw set. (c) UX requires "error borders stay as they were in the last valid render" during `parseError`, but a diagnostics change that arrives during a parse error would update markers against a stale model. (d) A collapsed group header needs its descendants' worst severity (UX), and no unit owns that roll-up.

**Tightening AD (new AD-16 — Node status is host-derived and sent as its own message).**
> The `vscode` adapter owns a `NodeStatusService`. It subscribes to `languages.onDidChangeDiagnostics` (ignoring changes it caused itself), reads all diagnostics for the URI after AD-12 dedupe, converts each one to an offset with `document.offsetAt`, assigns it to the **innermost** node whose range contains the diagnostic's start (the same `nodeAt()` helper as AD-8, see H4), and rolls severities up to ancestor groups (error > warning). It sends `nodeStatus { modelVersion, byId: Record<NodeId, {severity, messages[]}> }` as a separate host→webview message. `PipelineModel` carries no diagnostics. While the latest parse failed, `nodeStatus` is not recomputed: the last sent value stays. The webview never maps ranges.

### H2 — "Is this a Redpanda Connect file" has a pure function but no single owner of the per-document answer (F vs L vs S vs D)

**Clash construction.**
- The Conventions put detection in a pure core function over "top-level keys plus the workspace pattern setting". Every consumer calls it, which is legal.
- *S* (AD-11: schema "only for detected files") calls it inside Red Hat's `requestSchema(resource)`, which receives a **URI only**. S therefore does pattern-only detection, or reads `workspace.textDocuments` itself.
- *L* (AD-1 auto-open) calls it with content on `onDidOpenTextDocument`.
- *D* calls it on save.
- Results: (a) S and L disagree for a file that matches by content but not pattern, or the reverse (the spine never says whether the rule is OR or AND). (b) Flow 3: Tomás types `input:` and the file becomes detected **mid-session**. L doesn't auto-open (UX says so), S starts returning a schema only if Red Hat happens to re-ask (it caches per document), and D starts linting. That gives three different flip behaviors. (c) "Show graph" on an undetected file: does that file now count as RPCN for S and D? (d) A `filePatterns` change re-evaluates nothing, because only `binaryPath` triggers re-resolution in the Config convention.

**Tightening AD (new AD-17 — One DetectionRegistry per URI).**
> The `vscode` adapter owns a `DetectionRegistry` that holds `isRpcn(uri)`, and every consumer reads it from there. No consumer calls the core function directly. The predicate is `languageId === 'yaml' && (matchesPattern(path) || hasTopLevelKeys(text))`, or whatever the spine settles on, but it must be stated once. It is recomputed on open, on change (debounced), and on a `redpandaConnect.filePatterns` change, and it fires `onDidChangeDetection(uri)`. Explicitly running Show graph marks the URI as RPCN for the session (sticky opt-in). On a flip, S forces Red Hat to re-request the schema (see H6). Auto-open happens only on the **first** detection at open time, never on a mid-session flip.

### H3 — Binary state is not observable, so the webview can't learn it, and the graph's dependency on the binary contradicts the paradigm (B vs R, B vs L, B vs S/D)

**Clash construction.**
- *B* (AD-9, Errors convention) returns typed results to callers and shows "one notification path".
- *L* asks B for nothing, because P is a pure YAML parser that needs no schema (AD-2). L therefore renders the graph whether or not a binary exists.
- *R* follows EXPERIENCE ("No Redpanda Connect binary. The graph needs it to read the schema.") and expects a binary-missing empty state. No protocol message carries it.
- So one unit renders a full graph and another expects an empty state. Both are compliant.
- Also unspecified: (a) how often B notifies. Every save-time lint call gets a "missing" result, so it could notify once per call, once per session, or once per state transition. (b) The "Binary set after missing → everything appears without reopening" state needs a **change event** that fans out to S (regenerate the schema, make Red Hat refetch), D (re-lint open files) and L (clear the empty state). B only exposes "resolution", not subscription. (c) Precedence when there is no binary **and** no pipeline keys, which are two different empty states.

**Tightening AD (tighten AD-9 + new protocol message).**
> B exposes `binaryState: 'resolving' | {ready, path, version} | {missing} | {invalid, path, reason}` plus `onDidChangeBinaryState`. It notifies only on a transition **into** missing or invalid, once per transition. The graph panel forwards `hostStatus { binary }` to every panel and resends it on `ready`. **Decide explicitly**: either the graph renders from YAML without a binary (recommended, since P needs no schema), in which case EXPERIENCE's "graph needs the binary" empty state becomes a non-blocking banner, or the panel withholds `model` while the binary is missing. Empty-state precedence: parse error > binary missing > no pipeline keys.

### H4 — Range semantics are named ("offsets [start,end)") but not defined, so the selection, reveal and marker units disagree at boundaries (P vs L vs D)

**Clash construction.**
- A `yaml` node has `range: [start, valueEnd, nodeEnd]`, and the key is *outside* the value node.
- *P* chooses the value node's `[start, valueEnd)`.
- *L* derives selection (AD-8) from that range, so a cursor on the `kafka_franz:` key line, or on `- label: foo`, highlights the **parent** node.
- *D* maps a schema diagnostic (Red Hat usually puts it on the **key**) to the parent as well, so the wrong node gets the error border.
- Another P author picks `[start, nodeEnd)`, which includes trailing comments and blank lines, so the cursor below a node still highlights it.
- Also unpinned: the lint `(line,col)` base (RPCN prints 1-based) and the column unit (bytes vs UTF-16 code units, which matters for non-ASCII YAML); `revealRange` "selects that component's YAML range", but which range: the key+value block or the value only; and the containment rule ("innermost wins", from UX) is written in the UX only, not in any AD, so AD-8 and H1 could each implement it differently.

**Tightening AD (tighten Text ranges convention → AD).**
> Each model node carries `range: [start, end)` = **from the start of the owning map key, or the `-` sequence item, to the node's valueEnd**, in UTF-16 offsets (JS string indexes) into `document.getText()`, plus an optional `headerRange` for group labels. Core exports one pure `nodeAt(model, offset): NodeId | undefined` (innermost containing range wins, ties broken by depth). AD-8 selection and AD-16 node status must both use it. Lint `(line,col)` is parsed as 1-based line and 1-based UTF-16 column (verify against RPCN output; if the column is in bytes, convert in core) and converted to a `Range` in one adapter function.

### H5 — Node IDs collide or flip under normal editing, and the webview's per-ID state isn't sanctioned (P vs R)

**Clash construction.**
- *P* follows AD-7 literally. Mid-edit duplicate labels (copy-paste a processor) give **two nodes with the same ID**. React Flow keys collide and one node vanishes or both flicker.
- Labels and YAML paths share one namespace. A resource labelled `output.switch` is unlikely, but AD-7 doesn't exclude it.
- `cache_resources[].label: foo` and a processor `label: foo` can coexist while typing, before lint rejects it.
- Adding a label to an unlabelled node changes its ID from a path to the label, so collapse state is lost.
- *R* has to keep **collapse state, viewport and previous layout** keyed by ID (UX: "unchanged nodes keep their position, collapse state preserved"). But AD-3 calls the webview "stateless". One R author keeps no state and violates the UX. Another keeps state and arguably violates AD-3, and then H1's `nodeStatus` and AD-8's `selection` key into an ID that may be ambiguous.

**Tightening AD (tighten AD-7 + AD-3).**
> IDs are kind-prefixed and unique by construction: `label:<label>` for pipeline components, `res:<kind>:<label>` for resources, `path:<yaml.path>` otherwise. When a label is duplicated, the first occurrence in document order keeps `label:<x>`, later ones get `path:<yaml.path>` and a `duplicateLabel: true` flag, so the renderer can mark them. Core guarantees uniqueness per model and has a unit test for it. AD-3 is amended: the webview may keep **view-only state keyed by NodeId** (collapse, viewport, last layout positions) and nothing else. That state is discarded for IDs absent from the new model.

### H6 — Schema cache key and Red Hat refresh are not tied together, and version staleness is built in (B vs S)

**Clash construction.**
- *B* follows AD-9 and AD-10 literally. The version is read **once per resolved binary path**.
- A user upgrades `rpk` in place (`rpk connect upgrade`), so the path is unchanged. The version is never re-read and the schema is stale for good.
- `rpk connect` may lazily install or upgrade its plugin on first use, which changes the version behind the same path.
- *S* follows AD-11. It hands Red Hat a schema via `registerContributor(scheme, requestSchema, requestSchemaContent)`. Red Hat caches content by the **schema URI**. If S always returns the same URI (`redpandaconnect://schema`), a regenerated schema in `globalStorage` never reaches Red Hat until reload. That is legal under every AD, and it breaks the UX row "Binary set after missing → diagnostics appear without reopening".
- Also: several files opening at activation trigger concurrent `list --format jsonschema` runs, and nothing says single-flight. And a PATH change (a new `rpk` installed) doesn't re-resolve, because only the `binaryPath` setting triggers it.

**Tightening AD (tighten AD-10).**
> The schema URI handed to Red Hat embeds the cache key, as `redpandaconnect-schema://<sha(path+version)>.json`, so any key change makes Red Hat refetch. B re-reads the version on activation, on a `binaryPath` change, when the window regains focus (cheap and debounced), and on explicit `redpandaConnect.refreshSchema`. Schema generation is single-flight per key. S is the only module that reads the cache, and it reads it through B.

### H7 — Panel/editor identity is unspecified for split editors, untitled files, Save As and webview reload (L vs X, L vs D)

**Clash construction.**
- AD-1 says "one graph panel per YAML document". *L* keys panels by `TextDocument` object, and another reasonable L keys by `uri.toString()`.
- Save As on an untitled document changes the URI, so one L orphans the panel and the other duplicates it.
- The same document can be open in two text editors (split right). AD-8's "cursor" is undefined: which editor's selection drives highlight, and which editor does `nodeClicked` `revealRange` into? One implementer uses `activeTextEditor`, which is the graph panel itself after a click, so it is `undefined`. Another uses `visibleTextEditors[0]`.
- "Closing the YAML closes its graph": `onDidCloseTextDocument` fires late or never after a tab closes (documents linger), so the panel survives. The correct signal is `window.tabGroups.onDidChangeTabs`.
- The locked editor group holding graph A: Show graph for file B with `ViewColumn.Beside` from the YAML group opens into that same locked group in some layouts and a third group in others.
- Hidden panel without `retainContextWhenHidden`: the webview reloads and has no model until the next keystroke. AD-6 doesn't say the host resends on `ready`.
- *X* (AD-13) "one terminal per file", keyed by file name, while L keys by URI. Two `pipeline.yaml` files in different folders share a terminal name, and Stop's lookup by name can kill the wrong one.

**Tightening AD (tighten AD-1/AD-13 + AD-6).**
> Every per-file registry (graph panels, run terminals, detection, node status) is keyed by `document.uri.toString()`. They are re-keyed on `workspace.onDidRenameFiles` and on Save As (match the old untitled URI). Untitled documents get a graph but not Run, which is disabled with an explanation, so Run's auto-save never opens a Save As prompt. The "driving editor" for a URI is the most recently focused `TextEditor` showing that URI. AD-8 selection uses it, and `revealRange` targets it, or opens one in the last YAML column if none is visible. A panel closes when `tabGroups` has no text tab left for its URI. On `ready` the host always sends a full snapshot (`model` or `parseError`, then `hostStatus`, `nodeStatus` and `selection`). Terminals are tracked by URI in a map, never looked up by name, and the display name disambiguates with a relative path on a collision.

---

## Minor holes (fix while tightening)

| # | Units | Hole | Tightening |
| --- | --- | --- | --- |
| M1 | D vs D/R | Lint runs on save against the on-disk file. Its diagnostics don't shift as the user then types, so line-based markers point at the wrong node within seconds. The dedupe rule (same line as a schema diagnostic) is also evaluated against moved lines. | On the first `onDidChangeTextDocument` after a save, D clears (or marks stale and hides from node status) that URI's lint collection. Dedupe is recomputed whenever either source changes. |
| M2 | D vs R | The lint line format has **no severity**, yet UX has a warning state "from lint". One D author maps all lints to Error, so the warning state is never reachable. Another maps them to Warning, so the "error" in Flow 3 (`topci`) shows as a warning if Red Hat misses it. | Add a severity table to AD-12: Red Hat severity is passed through; lint is `Warning` by default (escalated to Error only for documented fatal patterns, e.g. parse failure). |
| M3 | X vs D/B | Run auto-saves, which triggers a save-time lint, so there are two concurrent spawns. Format-on-save may change content. If X uses `sendText` into a shell, the "running" state and exit can't be known (no status-bar removal, UX "Run exited"), and Stop vs "terminal stays open" conflict. | AD-13: the terminal is created with `shellPath` = the resolved binary and `shellArgs` = run args (no shell), so terminal process exit = pipeline exit. Stop sends SIGINT (`\x03`) and doesn't dispose, so output stays. Running state is a per-URI map in B with an event, and the status bar renders it for the active editor's URI. |
| M4 | L vs R | The banner click "jumps to the first parse error", but `parseError` has no specified payload, and a `bannerClicked` intent isn't listed. | `parseError { message, range: [start,end) }`; intent `bannerClicked`; the host reveals it. |
| M5 | Spine vs UX | EXPERIENCE still specifies a custom editor, a single tab with a sash, a view switcher, per-file view memory, and debounced lint while typing. R/L teams that read the UX build the wrong thing. | Already in Open Questions. Make it a **precondition** for slicing the R/L epics, not an open question. |

## What survived the attack

- AD-2 + AD-15 (one parser, pure core) can't be split between two units. Good.
- AD-5 (one protocol file) stops message-shape drift *once the missing messages above are added to it*.
- AD-9 single spawner stops divergent binary lookup. Its weakness is observability (H3), not ownership.
- AD-14 Bloblang (G) is isolated and can't conflict with anything.
- Q is safe as long as it keys Quick Fixes off diagnostics by `source` and code, not by message text. Consider adding that to AD-12: Red Hat message strings aren't a contract.
