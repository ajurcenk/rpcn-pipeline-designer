---
title: 'Scaffold the extension and wire the tracer path'
type: 'feature'
ticket: '2'
created: '2026-10-06'
status: 'built'
baseline_revision: '11af6bb6e75ca17a611c50c4d50564f2a89a3614'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/spike-1-1-findings/findings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no extension code yet, so no later ticket can add behavior, and nothing proves the layers (manifest, extension host, adapter, child process, output channel, CI packaging) connect.

**Approach:** Scaffold with generator-code into the repo root, pin the stack to the architecture, set the package identity and contributions once, add the layer folders with a dependency-direction check, and wire the thinnest path: opening a YAML file runs the binary's `--version` through a minimal adapter and logs it to the "Redpanda Connect" output channel; CI builds, tests and packages a `.vsix`.

**Decision (contributions, user 2026-10-06):** contribute every `redpandaConnect.*` setting (`binaryPath`, `autoOpenGraph`, `filePatterns`, `resourceFiles`, `envFile`) and command (`showGraph`, `hideGraph`, `run`, `stop`, `refreshSchema`) now; hide each command from the Command Palette (`menus.commandPalette` with `when: false`) and register no handler until its own ticket enables it.

**Decision (bundles, user 2026-10-06):** one node/cjs extension bundle only; epic 3 adds the webview bundle and its DOM tsconfig.

## Boundaries & Constraints

**Always:** `@types/vscode` 1.100.0 exactly and `engines.vscode` `^1.100.0`; `typescript ~6.0.3`; `@types/node 20.19.43`; `esbuild 0.28.2`; CI on Node 24; `publisher` `ajurcenk`, `name` `rpcn-pipeline-designer`, `displayName` "Pipeline Designer for Redpanda Connect", `license` `Apache-2.0`, `repository` `https://github.com/ajurcenk/rpcn-pipeline-designer`, `extensionDependencies` `["redhat.vscode-yaml"]`, version `0.0.1`; Apache-2.0 `LICENSE` and `NOTICE` at the root; one OutputChannel "Redpanda Connect" created in `src/extension.ts` and passed to adapters; child processes get `NO_COLOR=1`; the minimal adapter lives in `src/adapters/redpandaConnect/` and is the only module that spawns; AD-15 directions enforced by lint (core imports nothing from `adapters/` or `vscode`; `shared/` imports nothing from `core/`, `adapters/` or `vscode`).

**Never:** full AD-9 resolution order, version floor, `binaryState` or notifications (ticket 1.3); argument builder (1.5); schema (1.6); corpus CI (1.7); Red Hat contribution, lint, Run, graph or webview behavior (later epics); publishing to a registry (parked); commit `node_modules/`, `dist/`, `out/`, `.vscode-test/`, `*.vsix`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | YAML file opened; `redpanda-connect` on PATH (or `redpandaConnect.binaryPath` set) | Output channel line `Redpanda Connect <version> (<path>)`, version parsed with `^Version: (\S+)$` | No error expected |
| NO_BINARY | Neither setting nor PATH binary | Output channel line saying no binary was found; extension stays active | No notification (ticket 1.4) |
| BAD_OUTPUT | Binary exits non-zero or prints no `Version:` line | Output channel line with exit code and first stderr line | Activation does not throw |
| NON_YAML | Only non-YAML files opened | Extension not activated | — |

</frozen-after-approval>

## Code Map

Greenfield: only planning files, `scripts/spike/`, `test/corpus/`, `test/fixtures/schema/` exist — keep them untouched.

- Scaffold command (verified): `npx -y --package yo@latest --package generator-code@1.12.0 -- yo code rpcn-pipeline-designer --extensionType ts --extensionId rpcn-pipeline-designer --extensionDisplayName "Pipeline Designer for Redpanda Connect" --extensionDescription "<desc>" --bundler esbuild --pkgManager npm --gitInit false --skipOpen --quick` — creates a subfolder; move its contents to the repo root and merge its `.gitignore` into the existing one. It pins `@types/vscode`/`engines` to `^1.140.0` and `@types/node` to `24.x` — re-pin per Boundaries. Remove `vsc-extension-quickstart.md`; replace template `README.md` (vsce rejects template text).
- Generated shape to keep: `esbuild.js` (single node/cjs context, `external: ['vscode']`, `--production`, `--watch`), `eslint.config.mjs` (typescript-eslint flat config — add `no-restricted-imports` per-folder overrides for AD-15), `.vscode-test.mjs` (`files: 'out/test/**/*.test.js'`), scripts `compile`, `package`, `pretest`, `test`.
- Tests: `npm test` runs `@vscode/test-cli` (downloads VS Code); CI needs `xvfb-run -a npm test` on ubuntu-latest.
- Packaging: `@vscode/vsce` 4.0.0 (Node ≥ 22) `npx @vscode/vsce package --no-dependencies`; it rejects `@types/vscode` newer than `engines`.
- Version output (spike Q7): `Version: 4.112.0` / `Date: …` on stdout, exit 0; same for `rpk connect`.
- Local env: Node 22.23.1; `redpanda-connect` 4.100.0 on PATH.

## Tasks & Acceptance

**Execution:**
- [x] repo root (`package.json`, `package-lock.json`, `tsconfig.json`, `esbuild.js`, `eslint.config.mjs`, `.vscode-test.mjs`, `.vscodeignore`, `.vscode/`, `CHANGELOG.md`, `README.md`, `.gitignore`) -- scaffold, re-pin, identity, `activationEvents` `onLanguage:yaml`, contributions -- one owner of manifest and toolchain
- [x] `LICENSE`, `NOTICE` -- Apache-2.0 text and notice naming the project and the bundled-dependency notice slot -- redistribution requirement (spike follow-up)
- [x] `src/extension.ts` -- create the OutputChannel, call the adapter on activation, log the result -- tracer entry point
- [x] `src/adapters/redpandaConnect/version.ts` -- spawn `<binary> --version` (binaryPath setting else `redpanda-connect` on PATH) with `NO_COLOR=1` and a timeout, return a typed result -- minimal adapter
- [x] `src/core/version.ts` -- pure parser for `--version` output -- core layer seed, unit-tested
- [x] `src/shared/` -- create the folder with an index for shared types -- AD-15 layer seed
- [x] `eslint.config.mjs` -- AD-15 `no-restricted-imports` overrides -- enforce dependency direction
- [x] `src/test/` -- unit tests for the parser and adapter (fake binary script), an integration test that opens a YAML file and asserts the channel line -- matrix coverage
- [x] `.github/workflows/ci.yml` -- on push: Node 24, `npm ci`, `npm run compile`, `xvfb-run -a npm test`, `vsce package --no-dependencies`, upload the `.vsix` artifact -- delivery

**Acceptance Criteria:**
- Given a push to `main`, when CI runs, then compile, lint, tests and packaging pass and a `.vsix` artifact is uploaded.
- Given the `.vsix` installed in VS Code without `redhat.vscode-yaml`, when it installs, then VS Code also installs `redhat.vscode-yaml`.
- Given a file in `src/core/` that imports `vscode` or `../adapters/...`, when `npm run lint` runs, then it fails.

## Implementation Notes

- Scaffold generated in a scratch dir (generator-code also ran `git init` despite `--gitInit false`; its `.git` and `vsc-extension-quickstart.md` were not copied). The existing `.gitignore` already covered every generated entry, so nothing was merged.
- Pins: `@types/vscode` 1.100.0, `engines` ^1.100.0, `@types/node` 20.19.43, `esbuild` 0.28.2, `typescript` ~6.0.3, `@vscode/test-cli` 0.0.15, `@vscode/test-electron` 3.1.0; `@vscode/vsce` 4.0.0 added as a devDependency so CI's `npx vsce` is pinned. `tsconfig.json` gained `include: ["src"]`.
- `.vscodeignore` also excludes `_bmad*/`, `.agents/`, `.claude/`, `.cache/`, `scripts/`, `test/`, `.github/`, `skills-lock.json`; the `.vsix` holds only `dist/extension.js`, `package.json`, README, CHANGELOG, LICENSE, NOTICE.
- Adapter: `binaryPath` wins; a value without a path separator is looked up on PATH like `redpanda-connect`. The log path is the resolved absolute path. 10 s timeout then SIGKILL. ENOENT maps to the NO_BINARY line.
- `activate` returns `{ versionChecked, outputLines() }` so the integration test can assert the channel line (VS Code has no API to read an output channel). The version check is not awaited by activation.
- Lint also forbids `child_process` in `src/core` and `src/shared` (AD-2/AD-9 "no process spawning" in core).
- Core parser tests run under mocha inside `@vscode/test-cli` for this ticket; the architecture's vitest for core is not set up yet.
- The local `redpanda-connect` prints `Version: v4.100.0` (with `v`), unlike the spike captures (`4.112.0`). The parser keeps the token as printed; ticket 1.3's version floor must normalise a leading `v`.
- `redhat.vscode-yaml` is installed into the test VS Code automatically by `@vscode/test-cli` (it installs `extensionDependencies`), so tests need marketplace network access.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-06):** 8 findings — medium 2, low 4 patched, low 2 rejected. No intent_gap or bad_plan → patch round.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Timeout resolves only on `close`; non-exec wrapper keeps the check pending past the cap | medium | patch | Reviewer reproduced exit 204 ms / close 3005 ms; existing test uses `exec sleep`. Resolve in the timer. |
| 2 | Relative / `~` `binaryPath` resolved against the extension host cwd | low | reject | Unusual setting value; the fix needs a resolution policy (workspace-relative, `~` expansion) that belongs to ticket 1.3's AD-9 resolution. |
| 3 | ENOENT from a missing `#!` interpreter reported as "binary not found" | low | patch | `spawnFailure` maps every ENOENT to notFound; check the path exists first. |
| 4 | win32 `.CMD`/`.BAT` matched on PATH but unspawnable with `shell: false` | low | patch | Node refuses `.cmd`/`.bat` without a shell (EINVAL); restrict to `.EXE`. |
| 5 | AD-15 lint patterns also flag npm packages (`@babel/core`) | low | patch | Reviewer reproduced via `eslint --stdin`; anchor to relative paths. |
| 6 | `src/shared` may import `../extension`; `require('child_process')` in core not caught | medium | patch | AD-15: shared imports nothing internal; `no-restricted-imports` ignores `require`. |
| 7 | OutputChannel not passed to adapters | low | patch | Boundaries require it; `readConfiguredBinaryVersion()` takes no channel. |
| 8 | Tests POSIX-only; win32 branches untested | low | reject | CI and plan target ubuntu only; Windows CI is more than a direct correction. |

Patches 1, 3–7 applied by the re-engaged implementer. Re-verification (parent): `npm run compile` exit 0, `npm test` 26 passing, `vsce package --no-dependencies` 8 files / 10 KB, no build output tracked. Matrix audit: parent added `src/test/describeVersionResult.test.ts` for the NO_BINARY and BAD_OUTPUT channel lines. Note for 1.3: local binary prints `Version: v4.100.0` (leading `v`); relative/`~` `binaryPath` resolution unhandled (finding 2).

## Verification

**Commands:**
- `npm ci && npm run compile` -- expected: exit 0
- `npm test` -- expected: unit and integration tests pass
- `npx @vscode/vsce package --no-dependencies` -- expected: `rpcn-pipeline-designer-0.0.1.vsix` created, no errors
- `git status --short` -- expected: no `node_modules/`, `dist/`, `out/`, `.vscode-test/` or `.vsix` listed

**Manual checks (if no CLI):**
- Install the `.vsix` in VS Code, open a YAML file: the "Redpanda Connect" output channel shows the local binary's version.
