---
title: 'Complete file detection'
type: 'feature'
ticket: '2'
created: '2026-10-07'
status: 'built'
baseline_revision: '8795d9b5833ab6a4be9f789d3e13f5656fd84ca8'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The 2.1 registry only checks for top-level keys. It ignores `redpandaConnect.filePatterns`, detects templates (which fail lint and would get the wrong schema), does not re-check when the setting changes, and gives later tickets (lint on save, Run, Show graph) no event or hook to use.

**Approach:** Complete the DetectionRegistry (AD-18): a pure predicate in `src/core` over the text plus a "matched by pattern" flag, and an adapter registry that matches `filePatterns`, recomputes on open, change and setting change, fires `onDidChangeDetection` and exposes the session mark that epic 3's Show graph calls.

**Decision (resource files, user 2026-10-07):** no automatic resource-file detection. Lint and Run pass exactly the `redpandaConnect.resourceFiles` setting (AD-9/AD-18 amended). A resource-only file (only `*_resources` keys) is still *detected* (it gets the schema), it is just never added to `--resources` automatically.

**Decision (defaults announced 2026-10-07, not objected to):** a `filePatterns` match always detects, templates included; a template (top-level `name`, `type` and `mapping` in one YAML document) is not detected unless a pattern matches it; the session mark detects a URI for the rest of the window session, even after close and reopen; `onDidChangeDetection` fires only when `isDetected(uri)` actually changes; a `filePatterns` change recomputes every open YAML document.

## Boundaries & Constraints

**Always:** Pure `detect(text, matchedByPattern)` in `src/core/detection.ts` (no `vscode`): `true` when matched by pattern; otherwise `true` when some YAML document has a detection key and that same document is not a template. Pattern matching stays in the adapter: each `filePatterns` entry is a VS Code glob, matched relative to the workspace folder that contains the file (`RelativePattern`) and also against the absolute path (so `**/x.yaml` and absolute patterns work without a folder). Only `yaml` documents are considered; keyed by `uri.toString()` (AD-1). `onDidChangeDetection` carries `{ uri, detected }` and fires on open of a detected document (false → true), on edits or setting changes that flip the value, on `markDetected` of an undetected URI, and on close of a detected, unmarked document (true → false). Close drops the entry; a marked URI reports `true` with or without an entry. `markDetected(uri)` is synchronous and idempotent. Non-array or non-string entries in `filePatterns` are ignored, not thrown on.

**Never:** Automatic resource-file lists or any `--resources` change; a YAML parser dependency (the line scan stays, known misses documented); reading files from disk that are not open; persisting the session mark across windows (no `workspaceState`); the Show graph command itself (epic 3); forcing Red Hat re-validation (no API, 2.1).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| KEYS | open YAML with top-level `pipeline:` | detected | — |
| NO_KEYS | Kubernetes manifest, no pattern | not detected | — |
| RESOURCE_ONLY | only `cache_resources:` | detected; `resourceFiles` setting untouched | — |
| PATTERN | `filePatterns: ["**/*.rpcn.yaml"]`, `a.rpcn.yaml` with no keys | detected | — |
| TEMPLATE | corpus template (`name`, `type`, `mapping`), no pattern | not detected | — |
| TEMPLATE_PATTERN | same template matched by a pattern | detected | — |
| MULTI_DOC | doc 1 is a template, doc 2 (after `---`) has `input:` | detected | — |
| SETTING_CHANGE | `filePatterns` changed while files are open | every open YAML recomputed; event only for flipped URIs | — |
| BECOMES_DETECTED | empty YAML file, user types `input:` | detected without reopening; one event `{detected: true}` | — |
| NO_FLIP | edit inside a detected file that keeps it detected | no event | — |
| MARK | `markDetected(uri)` on an undetected open file | detected, one event; stays detected after close and reopen | — |
| CLOSED | detected, unmarked file closed | entry dropped; event `{detected: false}` | — |
| BAD_SETTING | `filePatterns: "x"` or `[1, "**/*.y.yaml"]` | invalid entries ignored; valid ones used | Never throws |

</frozen-after-approval>

## Code Map

- `src/core/detection.ts` (2.1) — `DETECTION_KEYS`, `TOP_LEVEL_KEY` regex, `isRedpandaConnectConfig(text)` line scan; header comment lists known misses. Extend: split into YAML documents on column-0 `---` lines, collect each document's top-level keys, add template check and `detect(text, matchedByPattern)`. Keep `isRedpandaConnectConfig` only if a caller remains (otherwise replace).
- `src/adapters/vscode/detection.ts` (2.1) — `DetectionRegistry(source = vscode.workspace)` with `DetectionSource` (textDocuments, open/change/close events), `entries: Map<string, boolean>`, `isDetected`, `has`, `update(doc)`. Extend `DetectionSource` with `onDidChangeConfiguration` and a config reader, plus a pattern matcher seam so unit tests need no workspace.
- `src/adapters/redhatYaml/contributor.ts` — uses only `DetectionLookup.isDetected(resource: string)`; unchanged.
- `src/extension.ts:94-96` — creates the registry and passes it to the contributor; `ExtensionApi.detection` already exposed.
- `package.json` — `redpandaConnect.filePatterns` (array of string, default `[]`) already declared; extend its description with the matching rule.
- Corpus templates (`input_sqs_example.yaml`, `processor_hydration.yaml`, `processor_log_and_drop.yaml`): already not detected in 2.1 because they have no top-level detection key (`src/test/core/detection.test.ts:88`). The template rule matters for a template that also has such a key; the TEMPLATE row uses a synthetic one, and the corpus test stays green.
- Tests: `src/test/core/detection.test.ts`, `src/test/adapters/vscode/` (registry unit tests with fake events), `src/test/extension.test.ts` (integration: BECOMES_DETECTED via `WorkspaceEdit`, PATTERN via `ConfigurationTarget.Global` update and restore).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/detection.ts` -- per-document keys, template rule, `detect(text, matchedByPattern)` -- pure predicate
- [x] `src/adapters/vscode/detection.ts` -- patterns, setting-change recompute, `onDidChangeDetection`, `markDetected` -- complete registry
- [x] `package.json` -- `filePatterns` description states the matching rule -- docs
- [x] `src/test/` -- unit tests for every matrix row; integration tests for BECOMES_DETECTED and PATTERN -- coverage
- [x] `README.md`, `CHANGELOG.md` -- detection rules, `filePatterns`, templates excluded -- docs

**Acceptance Criteria:**
- Given an open untitled-then-saved empty YAML file, when `input:` is typed, then the registry reports it detected and fires one event, without reopening.
- Given `filePatterns: ["**/*.rpcn.yaml"]`, when a template or key-less file matching it is open, then it is detected; when the setting is cleared, it is recomputed and no longer detected.

## Implementation Notes

- Core: `topLevelKeysByDocument` splits on column-0 `---` / `...` markers (a marker followed by text such as `--- # c` still splits; `---x` does not); `isRedpandaConnectConfig` is now template-aware per document; `detect(text, matchedByPattern)` is the full rule. The corpus templates were already undetected (no top-level detection key), so the TEMPLATE rows use synthetic templates.
- Registry: `DetectionSource` gains `onDidChangeConfiguration`; the constructor takes a `PatternReader` and a `PatternMatcher` seam. `isDetected` = marked or entry `true`; one private `set` computes before/after and fires on a flip, so open, edit, close, setting change and mark share one rule. The match result is cached per URI and cleared on a `filePatterns` change or close.
- Matching uses `vscode.languages.match` with `RelativePattern(folder, p)` and the bare string (matched against `fsPath`); a pattern that throws counts as no match. The folder lookup is injectable so the folder-relative branch is tested without a workspace (the test host opens none).
- README's Schema section said the schema was not yet supplied to the editor (stale since 2.1); corrected along with the new detection section.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-07):** 7 findings — medium 2, low 4 patched, low 1 deferred (intent_gap outside this ticket's boundary). No bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | BAD_SETTING untested; `readFilePatterns` never runs in tests | medium | patch | Extract pure `filePatternsFrom(value)` and unit-test it. |
| 2 | Folder-relative `RelativePattern` branch untested (test host has no workspace folder) | medium | patch | Injectable folder lookup; real-matching tests for `configs/*.yaml`, `*.yaml` (root only), `**/`, absolute, unmatchable `[`. |
| 3 | Argument builder still accepts `detectedResourceFiles`, contradicting the resource-file decision | low | defer | Outside Never (`--resources` change); noted in the E2 epic Notes for the first ticket that calls the builder. |
| 4 | Pattern match recomputed on every keystroke | low | patch | Cache per URI; clear on setting change and close. |
| 5 | A throwing match would abort the setting-change recompute | low | patch | `matchesFilePattern` catches per pattern and returns no match. |
| 6 | PATTERN integration test does not check events | low | patch | Assert one `detected: true` and one `detected: false` per file. |
| 7 | Docs do not say a pattern without `**/` matches only at a folder root | low | patch | README and `package.json` description updated. |

Re-verification (parent): `npm test` 239 passing (compile, type-check and lint run in `pretest`), `npm run test:corpus` 34/34 before the patches (no corpus-relevant change after).

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (type-check, lint incl. AD-15, bundle)
- `npm test` -- expected: all pass, every matrix row covered
- `npm run test:corpus` -- expected: 34/34, unchanged

**Manual checks (if no CLI):**
- In the Extension Development Host, open a corpus template: no Redpanda Connect completion; add its name to `filePatterns`: completion appears on the next request.
