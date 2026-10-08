---
title: "Detected config gets completion and hover from the binary's schema"
type: 'feature'
ticket: '1'
created: '2026-10-06'
status: done
baseline_revision: '11565f1f0219a4e7d9c2572cbd5aa61f5f1939e9'
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

**Problem:** The extension generates and caches the binary's schema (1.6), but nothing hands it to the editor, so a Redpanda Connect config gets no completion or hover from the user's own binary.

**Approach:** The tracer path for epic 2: a minimal DetectionRegistry decides which open YAML documents are Redpanda Connect configs, and a Red Hat YAML contributor serves the current schema to those documents only — as content under our own URI scheme, from the in-memory schema store (AD-10, AD-11, AD-18).

## Boundaries & Constraints

**Always:** Register exactly one contributor via `registerContributor` on the activated `redhat.vscode-yaml` exports, with scheme key `rpcn-schema`. `requestSchema(resource)` answers synchronously: a URI `rpcn-schema://schema/<hash>.json` (the hash of the current schema snapshot) when the registry says the resource is detected and a schema exists, otherwise nothing. `requestSchemaContent(uri)` returns the current snapshot's JSON as a string cached once per snapshot; a URI whose hash is not current returns the current schema. Detection (minimal, pure in `src/core`): a document is a Redpanda Connect config when it has a top-level `input`, `pipeline`, `output`, `buffer`, `cache_resources`, `rate_limit_resources`, `processor_resources`, `input_resources` or `output_resources` key; computed for YAML documents on open and on change, keyed by `uri.toString()` (AD-1), dropped on close. A missing or inactive Red Hat YAML, or a `false` from `registerContributor`, is logged once to the "Redpanda Connect" channel and never throws. The cache file is never read by the contributor.

**Never:** `filePatterns`, template exclusion, resource-file lists, `onDidChangeDetection` or the Show graph hook (ticket 2.2); our own YAML completion, hover or validation provider (AD-11); writing `yaml.schemas` or any user setting; a modeline or `$schema` key in documents; lint or Run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DETECTED | open YAML with top-level `input:`; schema ready | completion under `input:` offers component names (e.g. `generate`, `kafka_franz`); hover on a known field shows its merged description | — |
| NOT_DETECTED | YAML with none of the keys (e.g. a Kubernetes manifest) | no Redpanda Connect completion or hover; `requestSchema` returns nothing | — |
| RESOURCE_ONLY | YAML with only `cache_resources:` | detected; schema served | — |
| NO_SCHEMA | binary missing (no schema snapshot) | `requestSchema` returns nothing; no error | — |
| SCHEMA_CHANGES | Set path / Refresh Schema produces a new snapshot | next completion/hover in the already open file uses the new schema (new hash URI), no reopen | — |
| BECOMES_DETECTED | a new YAML file gets `pipeline:` typed into it | detected after the change; completion appears without reopening | — |
| CLOSED | detected document closed | its registry entry is removed | — |
| NO_REDHAT | `redhat.vscode-yaml` absent or its activation fails | one log line; rest of the extension works | Never throws |
| REGISTER_FALSE | `registerContributor` returns `false` | one log line naming the scheme key | Never throws |

</frozen-after-approval>

## Code Map

- `src/adapters/redpandaConnect/schema.ts` (1.6) — `SchemaStore`: `current: SchemaSnapshot | undefined` (`{ uri, json, path, version }`; `uri` is the cache file `schema-<16 hex>.json`), `onDidChange`, `settled()`, `refresh()`. Use the snapshot's hash (from its file name or recomputed via `schemaHash` in `src/core/schema.ts`) for the `rpcn-schema://` URI; serve `json`, never read `uri`.
- `src/extension.ts` — composition root: creates the channel `log`, `RedpandaConnect`, `SchemaStore`, the Refresh Schema command; returns `ExtensionApi { redpandaConnect, activationResolved, schemaStore, outputLines() }`. Wire the registry and the contributor here and expose them on `ExtensionApi` for tests.
- New: `src/core/detection.ts` (pure predicate over document text), `src/adapters/vscode/detection.ts` (minimal registry), `src/adapters/redhatYaml/contributor.ts` (Red Hat wiring). AD-15 lint applies to `src/core` (no `vscode`).
- Red Hat YAML 1.24.0 API (read from its bundled `dist/extension.js` / `dist/languageserver.js`, 2026-10-06):
  - `vscode.extensions.getExtension('redhat.vscode-yaml').activate()` resolves with the API (it is an `extensionDependency`, so it activates first).
  - `registerContributor(schema, requestSchema, requestSchemaContent, label?)` → `boolean` (`false` if the key exists).
  - `requestSchema(resource: string)` must return a URI string synchronously (a Promise is sent as `{}`); falsy = no schema. Called on every validation, hover and completion; never cached.
  - `requestSchemaContent(uri: string)` may return a string or a Promise; routed by `URI.parse(uri).scheme === schema key`; called on every validation/hover/completion, not cached — return a cached string.
  - Contributors beat `yaml.schemas` and the schema store; a document modeline or `$schema` key beats contributors.
  - No API forces re-validation; Red Hat's own diagnostics refresh on the next edit, hover and completion use new content immediately.
  - Documents validated before registration are not re-validated until edited.
- Tests: `@vscode/test-cli` (mocha/tdd); `src/test/helpers/fakeBinary.ts` has `connectScript` / `fixtureBodies` serving `list --format jsonschema` and `json-full` from `test/fixtures/schema/`; completion and hover can be driven with `vscode.executeCompletionItemProvider` / `vscode.executeHoverProvider`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/detection.ts` -- pure top-level-key predicate -- unit-tested core
- [x] `src/adapters/vscode/detection.ts` -- minimal registry over open YAML documents (open, change, close) with a synchronous `isDetected(uri)` -- what `requestSchema` asks
- [x] `src/adapters/redhatYaml/contributor.ts` -- activate Red Hat, register `rpcn-schema`, URI per snapshot hash, cached JSON string per snapshot, logging for absent/failed/false -- the schema path
- [x] `src/extension.ts` -- wire registry and contributor, expose them on `ExtensionApi` -- composition root
- [x] `src/test/` -- unit tests for the predicate and the contributor callbacks (fake Red Hat API); integration tests for DETECTED, NOT_DETECTED, SCHEMA_CHANGES and BECOMES_DETECTED through `executeCompletionItemProvider` / `executeHoverProvider` -- matrix coverage

**Acceptance Criteria:**
- Given a detected corpus config open in the Extension Development Host with a working binary, when completion is requested under `input:`, then component names from the binary's schema are offered, and hover on a known field shows its merged description.
- Given that open file, when the schema store produces a snapshot for another binary version, then the next completion uses the new schema without reopening the file.

## Implementation Notes

- Predicate is a line-based scan (no YAML parser is installed yet): a column-0 plain or quoted key followed by `:` and whitespace, a comment or end of line. A top-level flow mapping (`{input: …}`) is not detected.
- `DetectionRegistry` takes an injectable `DetectionSource` (defaults to `vscode.workspace`) so open/change/close, including CLOSED, are unit-tested with fake events; a document that is no longer `yaml` is dropped.
- The URI hash is `schemaHash(snapshot.path, snapshot.version)` (equal to the cache-file name's hash). Refresh Schema for the same binary keeps the URI, but the content cache is keyed by snapshot identity, so the new snapshot's JSON is served.
- `registerSchemaContributor` logs nothing on success; every failure line starts with `Schema` so the existing HAPPY_PATH binary-line assertion is unaffected. `ExtensionApi` gains `detection`, `schemaContributor`, `contributorRegistered`.
- Test helper `fixtureBodies` now calls `cat` / `gzip` by absolute path (`toolPath`), because the integration tests hide PATH directories holding a real `rpk` (here `/usr/bin`). SCHEMA_CHANGES uses a fake 4.113.0 binary serving the 4.112.0 schema plus a synthetic `rpcn_test_only_input` component.
- Review fixes: `requestSchemaContent` serves `'{}'` with no snapshot (Red Hat 1.24.0 throws on `undefined` and reports a served URI as unloadable); the DETECTED integration test uses `test/corpus/joining_streams.yaml` (completion at `input.broker`, hover on `redpanda.seed_brokers`); the predicate is checked against every corpus file by its SOURCES.md kind; the extension lookup is injectable via `createRedHatYamlLoader`. Known false positives of the line scan (multi-line quoted scalar, `--- |` document block scalar) are named in `src/core/detection.ts`.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-06):** 6 findings — medium 1, low 4 patched, low 1 rejected. No intent_gap or bad_plan.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | AC1 integration test uses synthetic files, not a corpus config | low | patch | `extension.test.ts` opens `detected.yaml`/`hover.yaml`; open `test/corpus/joining_streams.yaml` for completion and hover. |
| 2 | Detection predicate never tested against the corpus | low | patch | Core tests use inline strings only; add a test: every non-template corpus config detected, the three templates not. |
| 3 | `requestSchemaContent` returns `undefined` without a snapshot; Red Hat 1.24.0 throws a TypeError (content provider) or reports "Unable to load schema … No content" for a previously served `rpcn-schema://` URI | medium | patch | `contributor.ts:171-181`; reviewer traced `provideTextDocumentContent` / `loadJSONSchema` in the bundle. Return `'{}'` for our scheme when there is no snapshot. |
| 4 | Header comment overstates the line scan's safety (multi-line quoted scalar, document-level block scalar) | low | patch | `detection.ts:7-8`; correct the comment (a real fix needs a YAML parser). |
| 5 | `loadRedHatYaml` untested (missing extension, activation rejects, no `registerContributor`) | low | patch | `contributor.ts:187-202`; add unit tests with an injected extension lookup. |
| 6 | Refresh Schema with the same URI not tested end to end | low | reject | Unit-tested; Red Hat 1.24.0 re-requests content on every call (API research); an e2e test adds fixture plumbing for a third-party behavior. |

Patches 1–5 applied by the re-engaged implementer; the new loader tests exposed a real ReferenceError (a local named `exports` shadowing CommonJS `exports`), fixed. Re-verification (parent): clean `out/`, `npm run compile` exit 0, `npm test` all passing, `npm run test:corpus` 34/34, `vsce package` ok.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (type-check, lint incl. AD-15, bundle)
- `npm test` -- expected: all tests pass, including every matrix row
- `npm run test:corpus` -- expected: 34/34, unchanged

**Manual checks (if no CLI):**
- In the Extension Development Host (no `yaml.schemas` setting), open `test/corpus/joining_streams.yaml`: completion and hover come from the schema; a non-pipeline YAML gets none.
