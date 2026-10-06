---
title: 'Generate, transform and cache the schema'
type: 'feature'
ticket: '6'
created: '2026-10-06'
status: 'built'
baseline_revision: 'b5f7ec8f15caddf0249a4c40e9301b237e62df8d'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 2 (Red Hat schema contribution) and epic 3 (ComponentCatalog) both need the user's binary's config schema, but nothing generates it; the raw `list --format jsonschema` output has no `$schema`, rejects `${VAR}` on non-string fields, and carries no docs (spike Q4).

**Approach:** When `binaryState` becomes `ok`, the RedpandaConnect adapter generates the schema once (single-flight), applies one versioned pure transform, caches the result in `globalStorage` under a name derived from `hash(path + version + transformVersion)`, and exposes the current schema (URI + JSON) with `onDidChange`; a `Refresh schema` command re-resolves the binary and regenerates.

**Decision (doc source, user 2026-10-06):** each generation also runs `list --format json-full` and merges into the matching schema nodes: each field's `description` (+ `examples` rendered as a fenced YAML list) as `markdownDescription`, its `default` as `default`, and each component's `summary` as the component node's `markdownDescription`. AD-10 is updated to name `json-full` as the doc source.

**Decision (snippets, user 2026-10-06):** no `defaultSnippets` in the transform; snippets belong to epic 2 (CAP-5). AD-10 no longer lists them.

**Decision (cache cleanup, user 2026-10-06, from review pass 1):** VS Code windows share `globalStorage` and may resolve different binaries, so a write never deletes another live cache file: each use refreshes the file's modification time, and cleanup removes only `schema-<16 hex>.json` files whose modification time is older than 30 days.

## Boundaries & Constraints

**Always:** Spawning only through the adapter's spawn site with the resolved `invocation` and `NO_COLOR=1`. The transform is pure (in `src/core`), deterministic and versioned by a `TRANSFORM_VERSION` constant that is part of the cache key. It adds `"$schema": "http://json-schema.org/draft-07/schema#"`; lets every `number`, `integer` and `boolean` field also accept a string matching `^\$\{[^}]+\}$` (env-var interpolation); keeps the custom `is_*` keys; merges the `json-full` docs (Decision above). A field or component missing from `json-full` is left without docs, never an error. Cache: `globalStorageUri/schema-<hash>.json`, reused on a later activation without spawning when the file exists and parses; on every use (cache hit or write) the file's modification time is refreshed, and after a successful write only `schema-<16 hex>.json` files unused for more than 30 days are removed (Decision below). Generation triggers: every `binaryState` change to `ok`, and `redpandaConnect.refreshSchema` (now visible in the Command Palette, handler calls the binary `refresh()` then regenerates). While `binaryState` is not `ok` the current schema is `undefined`. Failures (non-zero exit, unparseable JSON, write error) are logged once to the "Redpanda Connect" channel and leave the previous schema in place only if it belongs to the same `path + version`.

**Never:** Register the schema with Red Hat YAML (epic 2, AD-11); build the ComponentCatalog (epic 3, AD-20); a `HoverProvider`; network access; notifications for schema failures; new settings.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FIRST_GEN | `binaryState` → `ok` 4.112.0, no cache | One generation; file `schema-<hash>.json` written; `onDidChange` fires with URI + JSON | — |
| CACHE_HIT | Activation with a matching cache file | No spawn; cached schema exposed | — |
| CACHE_CORRUPT | Matching file exists but does not parse | Regenerated and rewritten | Logged once |
| VERSION_CHANGE | `ok` 4.100.0 → `ok` 4.112.0 (Set path / Retry) | New hash, new file, old file kept (recently used), `onDidChange` fires | — |
| OTHER_WINDOW | another `schema-<hash>.json` used within 30 days | not removed | — |
| STALE_FILE | a `schema-<hash>.json` unused for over 30 days | removed after a successful write | — |
| NOT_OK | `binaryState` → `missing` / `invalid` | Current schema `undefined`; `onDidChange` fires once | — |
| CONCURRENT | Two triggers overlap | One generation; both get its result | — |
| REFRESH_CMD | `Refresh schema` run | Binary re-resolved, schema regenerated even on a cache hit | — |
| GEN_FAILS | `list` exits non-zero / prints invalid JSON | Logged once; schema `undefined` (or kept if same `path + version`) | Never throws |
| DOC_MERGE | jsonschema + json-full for 4.112.0 | `kafka_franz.seed_brokers` has a `markdownDescription` with its description and examples; components carry their `summary` | Missing docs tolerated |
| DOC_FAILS | jsonschema ok, json-full fails | Schema produced without docs | Logged once |
| TRANSFORM_V | Same input, both spike fixtures | Output has `$schema`, interpolation on every number/integer/boolean field, `is_*` kept, deterministic | — |

</frozen-after-approval>

## Code Map

- `src/adapters/redpandaConnect/version.ts` — the only spawn site (`readVersion(invocation, timeoutMs)` returns the raw outcome; `NO_COLOR=1`, no shell, timeout). Generalize or add a sibling that runs `invocation + ['list', '--format', 'jsonschema']` and returns stdout; keep it the only `child_process` import (AD-15 lint).
- `src/adapters/redpandaConnect/binary.ts` — `RedpandaConnect`: `state`, `onDidChange`, single-flight `refresh()`, `scheduleRefresh()`, no spawn after `dispose()`; `BinaryState.ok{path, version, invocation}`.
- `src/extension.ts` — composition root: channel log, `RedpandaConnect` with the VS Code notifier, `ExtensionApi { redpandaConnect, activationResolved, outputLines() }`; `context.globalStorageUri` is available here.
- `package.json` — `redpandaConnect.refreshSchema` contributed in 1.2 and hidden (`menus.commandPalette` `when: "false"`, lines ~93/117): remove the hiding and register the handler.
- Schema shape (spike Q4, fixtures `test/fixtures/schema/jsonschema-{4.100.0,4.112.0}.json`, ~0.8 MB each): top-level `definitions` + `properties`; 9 categories at `definitions.<cat>.allOf[0].anyOf[i].properties.<name>`; 118 `$ref`s to `#/definitions/<cat>`; leaf nodes like `{"type":"array","items":{"type":"string",…},"is_advanced":…}`; no `description`/`examples`/`default` keywords.
- Doc source found during planning: `list --format json-full` (~2.6 MB, exit 0) has per-component `summary`/`description` and per-field `name`, `type` (`string|int|float|bool|object|…`), `kind`, `description`, `examples`, `default`, `interpolated` under `config.children[]`. `json` (6.7 KB) is names only.
- Tests: mocha/tdd under `@vscode/test-cli`; fake binaries via `src/test/helpers/fakeBinary.ts`; state-owner tests inject environment via options.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/schema.ts` -- pure versioned transform and json-full doc merge -- testable against the spike fixtures (capture a json-full fixture per version into `test/fixtures/schema/`, gzip if > 2 MB)
- [x] `src/adapters/redpandaConnect/version.ts` (or a sibling spawn helper in the same file) -- run `list --format …` and return stdout -- single spawn site
- [x] `src/adapters/redpandaConnect/schema.ts` -- `SchemaStore`: single-flight generation, cache read/write/cleanup, `current`, `onDidChange` -- one owner of the schema
- [x] `src/extension.ts`, `package.json` -- wire the store to `binaryState` and `globalStorageUri`; un-hide and register `redpandaConnect.refreshSchema` -- triggers
- [x] `src/test/` -- transform tests on both fixtures; store tests for every matrix row with a fake binary -- verify

**Acceptance Criteria:**
- Given an Extension Development Host with a valid binary, when the extension activates a second time, then no `list` process is spawned and the cached schema is exposed.
- Given a cached schema, when `Refresh schema` runs or `Set path` selects a binary of another version, then a new schema is produced without reopening any file.

## Implementation Notes

- Interpolation rewrite: `{type: T, …rest}` → `{…rest, anyOf: [{type: T}, {type: 'string', pattern: '^\$\{[^}]+\}$'}]}`; `is_*` and docs stay on the outer node.
- Doc merge walks json-full `config.children[]` by `kind` (`scalar` → node, `array` → `items`, `2darray` → `items.items`, `map` → `patternProperties["."]`); a component's `config` root maps onto the component node (for example `switch` is an array of cases). Examples are rendered by a small conservative YAML emitter in `src/core/schema.ts` (doubtful scalars are JSON-quoted; multi-line strings become `|`/`|-` literals).
- Cache key: `sha256(path \0 version \0 TRANSFORM_VERSION)`, first 16 hex characters. A cache file must parse and carry the draft-07 `$schema` to count as a hit. A read error counts as a miss (the write then reports any real problem once).
- `SchemaStore.refresh()` marks the binary re-resolution as forced, so a state change it causes regenerates without the cache and the command's own request shares that run.
- All store log lines start with `Schema`; the integration tests filter them out when asserting binary lines.
- Fixtures: `test/fixtures/schema/json-full-{4.100.0,4.112.0}.json.gz` (gzip -9 -n of the spike binaries' output, exit 0).

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-06):** 5 findings — medium 2, low 2 patched, low 1 rejected; one medium is an **intent_gap** (cleanup rule in the frozen Boundaries).

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | YAML emitter leaves `a #b` unquoted, so examples read truncated | low | patch | `isPlainSafe` checks `[:#]\s`, not `\s#`; reviewer reproduced with the compiled module. Quote any scalar containing ` #`; add a test. |
| 2 | A stale generation still writes its file and deletes the current binary's cache (and writes after `dispose()`) | medium | patch | `stillWanted` is checked only before each `runList`, not before `writeFile` / `removeOtherCacheFiles`. Re-check before both. |
| 3 | Windows on different binaries delete each other's live cache file (shared `globalStorage`) | medium | intent_gap | The frozen rule "other `schema-*.json` files removed after a successful write" causes it; `binaryPath` is `machine-overridable` and PATH can differ per window. Human decision needed. |
| 4 | `SCHEMA_FILE_PATTERN` matches any `schema-*.json` | low | patch | `schemaFileName` always yields `schema-[0-9a-f]{16}.json`; tighten the pattern. |
| 5 | AC1 not tested through a real second `activate()` | low | reject | Needs a second extension host; covered by the manual check (same call as ticket 1.4 #4). |

Resolution: the human chose option (a) for #3 (mtime-based 30-day cleanup, decision added to the frozen block) and a single patch round for #1–#4 instead of revert-and-re-derive.

Patches 1–4 applied by the re-engaged implementer. Re-verification (parent): clean `out/`, `npm run compile` exit 0, `npm test` all passing, `vsce package` ok.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0
- `npm test` -- expected: all tests pass, including every matrix row

**Manual checks (if no CLI):**
- Activate twice in the Extension Development Host with a valid binary: the second activation logs a cache hit and spawns no `list`; `Refresh schema` regenerates.
