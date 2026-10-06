# Rubric Walker Review: architecture-rpcn-vscode-designer

- **Spine:** `architecture-rpcn-vscode-designer.md` (status: draft, altitude: initiative, greenfield, POC stakes)
- **Lens:** good-spine checklist (`references/reviewer-gate.md`)
- **Date:** 2026-10-05
- **Deterministic pre-pass:** `lint_spine.py` reports 0 findings. It misses the two `latest stable at scaffold` Stack rows and the TypeScript row that names no TypeScript version (see H-1).

## Verdict

The spine is sound and unusually crisp. The paradigm, the host/webview split, process ownership and the dependency rules are well fixed. It is not ready for handoff yet, though: four real divergence points are unfixed (how diagnostics reach graph nodes, resource-file and env wiring for lint and run, the Quick Fix edit policy, and who owns webview view state), there is a build-breaking version mismatch, and three Stack versions are unpinned. The release, versioning and support side of the operational envelope is only partly decided.

## Checklist walk

| Checklist item | Result |
| --- | --- |
| Fixes the real divergence points for the level below, misses none | **Partial.** Misses: node diagnostics markers (H-2), resource/env file wiring (H-3), Quick Fix edit policy (H-4), webview ephemeral view state (H-5). More in Medium. |
| Every AD Rule is enforceable and prevents its stated divergence | **Mostly.** AD-7, AD-8 and AD-12 have gaps where they are ambiguous (M-1, M-2, M-4). AD-15 is silent on imports between adapters (M-6). |
| Nothing in Deferred lets two units diverge | **Mostly.** "Telemetry: Not decided" could let a unit add telemetry on its own (M-9). The other Deferred items are safe. |
| Named tech is verified-current | **Partial.** Checked against the npm registry on 2026-10-05: every pinned npm version matches latest. React (latest 19.3.0), vitest (latest 5.0.3) and TypeScript (latest 7.0.2, a major rewrite) are unpinned. `@types/vscode 1.140.0` vs `engines ^1.100.0` makes `vsce package` fail (H-1). On Open VSX, redhat.vscode-yaml is 1.25.x against the pinned 1.24.0 (L-1). |
| Ratifies, not contradicts, a brownfield codebase | N/A (greenfield). |
| Covers the driving spec/brief capabilities | **Partial.** Brief items not covered: node error markers, resource files, Quick Fix safety, the "groundwork for debugging/profiling" PRD note (M-7), Apache-2.0 license and publisher identity (H-6). The divergences from the brief that came from the custom-editor → WebviewPanel switch are listed honestly as open UX questions. |
| Parent spine inherited | N/A (initiative altitude, none). |
| Every dimension decided / deferred / open, especially the operational envelope | **Partial.** Build (esbuild, two bundles), CI (GH Actions) and distribution (tag → vsce + ovsx) are decided. Silent: the extension versioning scheme and pre-release channel, publisher identity and secrets, the supported Redpanda Connect version range and the binary version CI uses, remote-dev `extensionKind`, log levels and error reporting. Telemetry is only "not decided" (H-6, M-8, M-9). |
| Mermaid validity | **Pass.** Both diagrams (`graph LR` with cylinder nodes, and a `sequenceDiagram` with `alt/else/end`) are syntactically valid on inspection. |
| No template comments / placeholders | **Pass.** No `<!-- -->`, TODO or `{var}`. Six `[ASSUMPTION]` tags remain (4 conventions, 2 stack rows). They are triage items for Finalize step 4 and are acceptable in a draft. Clear them, or say they are accepted, before `status: final`. |

## Critical

None. Nothing blocks the POC outright. H-1 breaks packaging but is a one-line fix.

## High

**H-1. Stack: build-breaking version mismatch, plus unpinned versions.**
- `@types/vscode 1.140.0` with `engines.vscode ^1.100.0`: `vsce` refuses to package when `@types/vscode` is newer than the `engines` floor. It also lets units call APIs that are newer than 1.100 without noticing.
- React and vitest are "latest stable at scaffold". The TypeScript row names generator-code 1.12.0, not a TypeScript version. TypeScript latest is now 7.0.2, the native-port major, so units scaffolded at different times would get different compilers.
- **Fix:** pin `@types/vscode` to `1.100.0`, matching the engines floor (or raise `engines` to `^1.140.0`). Pin React 19.3.0, vitest 5.0.3 and an explicit TypeScript version, either 5.9.x if the generator-code toolchain or typescript-eslint is not TS7-ready, or 7.0.2 after you check it. Remove the two `[ASSUMPTION]` tags. Extend `lint_spine.py` so it catches "latest" wording.

**H-2. Missed divergence: how diagnostics reach graph nodes.**
- The brief requires "nodes with errors or warnings are marked, with the message on hover". The spine never says which diagnostics feed the markers: Red Hat schema diagnostics (another extension's collection, read with `languages.getDiagnostics`), our lint diagnostics, or both after the AD-12 dedupe.
- It also doesn't say how a diagnostic maps to a node: by range containment, and innermost or outermost.
- It also doesn't say how they travel to the webview: inside `PipelineModel` or as a separate message. The graph-panel and diagnostics units would each pick their own answer.
- **Fix:** add an AD. The host maps the final, deduped set from `languages.getDiagnostics(uri)` (all sources) to the innermost node whose range contains the diagnostic start. It sends a separate `diagnostics` message keyed by node ID, re-sent on `onDidChangeDiagnostics`. The webview never computes markers.

**H-3. Missed divergence: resource-file and env-file wiring for lint and run.**
- The brief scopes "single-file configs plus resource files". `lint` and `run` both take `-r` (resources) and `-e` (env file). Configs that use `${ENV}` vars can fail lint unless `--skip-env-var-check` is passed.
- The spine doesn't say how a config is associated with its resource files, or which flags lint and run share. If lint and run diverge here, lint passes while run fails (or the reverse), and the diagnostics-parity success criterion can't be measured.
- **Fix:** add an AD in the RedpandaConnect adapter. One function builds the shared argument set (`-r` from a `redpandaConnect.resourceFiles` setting or glob, `-e` from a `redpandaConnect.envFile` setting, and an env-var-check policy). Lint and run both use it. The graph shows resources only from the open file (or state otherwise).

**H-4. Missed divergence: the Quick Fix edit policy.**
- Quick Fixes are the only edits the extension makes in this release, and the brief promises that comments, `${ENV}` and formatting are never at risk. The addendum says to apply them "as minimal text edits … never by re-serializing the whole file".
- AD-2 and AD-3 cover parsing and the webview but not edits. Deferred covers only graph write-back. One Quick Fix author could round-trip through `yaml.Document.toString()`.
- **Fix:** add an AD. All document edits are `WorkspaceEdit`s that replace only the minimal range (for example a mistyped key token), computed from core ranges. Re-serializing a document is never allowed. Core may compute edit ranges, but only `src/adapters/vscode` applies them.

**H-5. Missed divergence: who owns webview view state (collapse, viewport).**
- The brief requires collapsible groups. AD-3 says the webview is "stateless" and "renders the latest model", yet group collapse state and pan/zoom must survive full-model resends (AD-6) and the panel being hidden or restored.
- One unit could put collapse state in the host model while another keeps it in React state. If it isn't persisted, it is lost when the panel is hidden.
- **Fix:** amend AD-3. The webview is stateless with respect to document content. It owns only ephemeral view state (collapsed group IDs, viewport), keyed by AD-7 node IDs and persisted with `vscode.getState/setState`. The host never stores view state. Also decide `retainContextWhenHidden` (recommend false plus state restore) and whether a `WebviewPanelSerializer` restores panels after a reload.

**H-6. Operational envelope: release, versioning and support matrix are silent.**
- The table decides distribution and CI. It doesn't decide:
  - the extension version scheme and pre-release channel (vsce's odd-minor `--pre-release` convention, tag format)
  - the Marketplace/Open VSX publisher identity (an open question in the brief, with trademark constraints)
  - the CI secrets (`VSCE_PAT`, `OVSX_PAT`)
  - the minimum supported Redpanda Connect version and which binary version CI installs for the integration and parity tests. The lint text format and `list --format jsonschema` are version-sensitive, and the addendum flags `redpanda-connect` vs `rpk connect` subcommand parity as unverified.
  - the extension license (Apache-2.0 per the brief). Only elkjs licensing is recorded.
- **Fix:** add rows for Versioning (semver, `vX.Y.Z` tags, odd minor = pre-release), Publisher (open question: name and trademark), Secrets, Supported binary (min version X, CI pins version Y, parity corpus run against Y) and License (Apache-2.0). Move "standalone binary subcommand parity" to Open Questions.

## Medium

- **M-1 (AD-7):** labels can collide while the user is mid-edit (duplicate labels before lint flags them), and adding a label to a component changes its ID. Fix: on a duplicate label, fall back to the YAML path for the second and later occurrences. Accept the ID change when a label is added (reconcile treats it as a new node).
- **M-2 (AD-8):** nested ranges overlap (a `switch` group contains its cases). It isn't specified whether the highlight goes to the innermost or the outermost node. Fix: the innermost node whose range contains the cursor offset.
- **M-3 (AD-6):** "if parsing fails" is ambiguous with `yaml`, which tolerates errors and returns a Document with `errors[]`. Fix: a model is valid iff `doc.errors.length === 0`. Warnings don't block.
- **M-4 (AD-12):** dedupe against Red Hat diagnostics depends on timing, because Red Hat's validation is asynchronous and changes after our lint runs. Lint also never runs on open, so a freshly opened file shows no lint diagnostics until it is saved. Fix: recompute suppression on `onDidChangeDiagnostics`, and also lint on open.
- **M-5 (AD-9):** `rpk` on PATH without the connect plugin can trigger rpk's auto-download/install flow. It isn't defined what counts as an "invalid" binary. Fix: validate by running the version command with a timeout and no interactive install, and treat failure as invalid.
- **M-6 (AD-15):** it is ambiguous whether adapters may import each other (the redpandaConnect adapter produces the schema that redhatYaml consumes). Fix: say explicitly that adapters do not import each other, and that `extension.ts` passes ports/callbacks between them.
- **M-7 (brief coverage):** the PRD note "lay groundwork for debugging and profiling (a run panel with per-processor output or metrics, not just raw logs)" isn't addressed. AD-13 uses a plain terminal. Fix: either defer it explicitly with a revisit condition, or keep run output parsing behind the RedpandaConnect adapter so a run panel can be added later.
- **M-8 (ops):** remote dev (SSH, WSL, Codespaces) is undecided. The binary lives where the workspace lives. Fix: declare `extensionKind: ["workspace"]` and no web-extension support. Also decide on `LogOutputChannel` (`{ log: true }`) and how users report errors (attaching logs).
- **M-9 (Deferred):** "Telemetry: Not decided" lets any unit add telemetry. Fix: make it a rule, "no telemetry in this release; if added later, use `@vscode/extension-telemetry` and respect `isTelemetryEnabled`".
- **M-10 (security):** webview CSP and `localResourceRoots`/nonce aren't fixed. Neither is validating incoming messages against the protocol union. Fix: add a convention row covering a strict CSP with nonce, `localResourceRoots` limited to the webview dist folder, and the host ignoring unknown message types.

## Low

- **L-1:** redhat.vscode-yaml on Open VSX is now 1.25.x (dated 2026-10-03), against the pinned 1.24.0. Check the Marketplace stable version and whether 1.25 is a pre-release.
- **L-2:** elkjs is dual EPL-2.0/GPL-3.0 (per the memlog). Record that the project uses it under EPL-2.0.
- **L-3:** AD-13 doesn't say how Stop terminates the process (`terminal.dispose()` or sending Ctrl+C). Pick one so the status bar and the command behave the same.
- **L-4:** the sequence diagram shows the selection being sent after every change, including after a parse error. Confirm that selection is derived against the last valid model while a parse error is showing.

## Counts

Critical 0, High 6, Medium 10, Low 4.
