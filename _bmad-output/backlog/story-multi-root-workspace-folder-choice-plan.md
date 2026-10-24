---
title: 'Multi-root workspaces use a defined folder for relative path settings'
type: 'feature'
ticket: '4'
created: '2026-10-23'
status: done
baseline_revision: 'a9724766a5d55efdcb0d5f705406399c98c9d6c2'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Relative `resourceFiles` and `envFile` values always resolve against the first `file:` workspace folder (`firstWorkspaceFolderPath`, `src/adapters/redpandaConnect/args.ts`), and the two settings have no `scope`, so in a multi-root workspace a folder can't set its own, and Run's working directory (the file's folder) can differ from where they resolve.

**Approach:** `resourceFiles` and `envFile` become `resource`-scoped. Every command built for a config (lint, run, the live Bloblang parse, the Bloblang test panel) reads them for that config's URI: a value its own workspace folder's settings define resolves against that folder; a value from the workspace (`.code-workspace`) or user settings resolves against the first `file:` folder, as today. A single-folder workspace is unchanged. The live parse's cache keeps results apart per folder, so the same mapping text under different env files is parsed for each. The README's "known limit" about Run's folder is updated.

**Decisions (user, 2026-10-23):**
- `binaryPath` stays window-wide: one binary per window, a relative value resolves against the first `file:` folder, as today.
- The live Bloblang parse and the test panel follow the config's folder too, not only lint and run.

</frozen-after-approval>

## Implementation Notes

Oneshot: the folder choice in `args.ts` (pure, tested), the config's URI passed by lint, run, the test panel and the live parse, the scopes in `package.json`, README.

- `src/adapters/redpandaConnect/args.ts`: `defaultArgsEnvironment(resource?)` reads the configuration for `resource` and fills `settingFolders` per setting with `definingFolder(config.inspect(key), <resource's file: folder>)`: that folder when `workspaceFolderValue` is set, else `undefined` (the first folder, `workspaceFolder`). `resolveFileSettingPath` takes the folder. `buildLintCommand` / `buildRunCommand` default to their first target's URI (none for a relative target, which is reported anyway), so lint and Run callers are unchanged.
- `bloblang.ts`: `MappingTestDependencies` / `MappingParseDependencies` take `resource`; `commandOf` reads `defaultArgsEnvironment(resource)`. The test panel (`bloblangPanel/panels.ts`) passes its config's URI; `extension.ts` passes the parsed document's URI.
- `src/adapters/vscode/bloblangDiagnostics.ts`: `parse(source, uri)`; the cache key is `<scope>\n<text>`, scope = the config's workspace folder (`cacheScope` test seam). In-flight parses stay per document and path.
- `package.json`: `"scope": "resource"` on `resourceFiles` and `envFile`, descriptions say which folder. README: the Run "known limit" replaced, the settings rows. CHANGELOG entry.
- `binaryPath` untouched (window-wide, the user's decision).
- Tests: `args.test.ts` (a folder-scoped `envFile` against its folder, `resourceFiles` from the workspace against the first; `definingFolder` cases), `bloblangDiagnostics.test.ts` (each parse gets its config; same text parsed once per scope, a third config in a scope reuses the cache). 193 passing in the adapter suites. The real multi-root `inspect` is not exercised by a test (the test host opens one folder).

## Review Triage Log

Quick review. Verdicts: 0 high, 0 medium, 3 low; no production bug found.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The cache test passed on the old text-only cache too (both parses started before anything was cached) | low | patch | Rewritten: a's result is cached first, then the same text in scope B is parsed again, and a third config in A reuses the cache. It fails with a text-only key (checked). |
| 2 | AC 1's real path (`getConfiguration(…, resource)`, `getWorkspaceFolder`, `inspect` → `definingFolder`) has no test; only the injected folder and `definingFolder` are tested | low | defer | Real. The test host opens no folder (suites rely on that), so a multi-root case needs its own test run with a `.code-workspace`. Deferred; covered by the manual check in a multi-root dev host. |
| 3 | `package.json`'s `envFile` description still said "lint and run" | low | patch | Now names the Bloblang checks too, as the README. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "adapters/redpandaConnect|adapters/vscode BloblangDiagnostics"` -- expected: all pass; then the full stable suite (905 passing).
