# Review — Verification lens (architecture-rpcn-vscode-designer)

- Date: 2026-10-05
- Target: `../architecture-rpcn-vscode-designer.md` and `../.memlog.md` (spine not edited)
- Lens: every committed decision checked against live sources (npm registry, nodejs.org dist index, VS Code Marketplace + Open VSX APIs, microsoft/vscode `release/1.100` and `release/1.140` branches, the generator-code 1.12.0 tarball, the @types/vscode 1.100.0 / 1.140.0 tarballs, the @vscode/vsce 4.0.0 tarball, the redhat-developer/vscode-yaml source).

## Verdict

**PASS WITH REQUIRED FIXES.** Every version in the memlog's 2026-10-05 web check is still current. All named technologies exist and fit. Two Stack rows break or risk breaking the build: the @types/vscode pin is newer than the engine, so `vsce package` fails, and an unpinned TypeScript would install 7.x, which typescript-eslint does not support. Two ADs depend on VS Code behaviour that does not work as written: AD-1's group lock with `preserveFocus`, and AD-13's Stop.

## Stack — verified versions (registry, 2026-10-05)

| Package / item | Spine | Verified current | Source / note |
| --- | --- | --- | --- |
| VS Code stable | 1.140.0 | 1.140.0 | update.code.visualstudio.com/api/releases/stable |
| `engines.vscode` | ^1.100.0 | — (choice) | 1.100 = Electron 34.5.1 / Node 20.19.0 (`release/1.100/.npmrc`) |
| @types/vscode | 1.140.0 | 1.140.0 latest; **must be 1.100.0** for engine ^1.100.0 | see F1 |
| generator-code | 1.12.0 | 1.12.0 | npm |
| typescript | via scaffold | latest 7.0.2; **scaffold pins ^6.0.3 (6.0.3)** | generator-code `dependencyVersions/package.json`; see F2 |
| @types/node | unpinned | latest 26.6.4; scaffold `24.x` (24.19.1); **20.x (20.19.43) matches engine floor** | see F5 |
| Node.js LTS (dev/CI) | unpinned | **24.x "Krypton", 24.21.0** (26.10.0 is Current, not LTS yet) | nodejs.org/dist/index.json |
| esbuild | 0.28.2 | 0.28.2 | npm (scaffold ^0.28.1) |
| react | unpinned | **19.3.0** (2026-09-09) | npm |
| react-dom | unpinned | **19.3.0** | npm |
| @types/react / @types/react-dom | — | 19.3.0 / 19.3.0 | npm |
| @xyflow/react | 12.12.0 | 12.12.0 | peer `react >=17`; deps zustand ^4.4.0 (peer react >=16.8) — React 19 OK |
| elkjs | 0.12.0 | 0.12.0 | ships `lib/elk.bundled.js`, `lib/elk-worker.min.js`, `lib/elk-api.js` |
| yaml (eemeli) | 2.9.1 | 2.9.1 | npm |
| @vscode-elements/elements | 2.5.1 | 2.5.1 | peer `@vscode/codicons >=0.0.40` — satisfied |
| @vscode/codicons | 0.0.46-24 | 0.0.46-24 (`latest`; `next` = 0.0.46-43) | npm |
| redhat.vscode-yaml | 1.24.0 | **1.24.0 stable** (2026-07-07, engine ^1.63.0); Marketplace/Open VSX "latest" is pre-release 1.25.2026100308 | Marketplace + Open VSX APIs |
| vitest | unpinned | **5.0.3** | engines node `^22.12.0 \|\| ^24.0.0 \|\| >=26`; peer vite ^6.4\|^7\|^8 |
| @vscode/test-cli | 0.0.15 | 0.0.15 | npm |
| @vscode/test-electron | 3.1.0 | 3.1.0 | npm |
| @vscode/vsce | 4.0.0 | 4.0.0 | engines node >= 22 |
| ovsx | 1.2.0 | 1.2.0 | npm |
| typescript-eslint (scaffold) | — | 8.71.1, peer `typescript >=4.8.4 <6.1.0` | relevant to F2 |

## VS Code API facts the ADs rely on

All checked against `@types/vscode@1.100.0` (the engine floor), so each one exists at ^1.100.0:

| Fact | Status |
| --- | --- |
| `ViewColumn.Beside = -2`; `createWebviewPanel(viewType, title, { viewColumn, preserveFocus }, options)`; `WebviewPanel.reveal(viewColumn?, preserveFocus?)` | Present |
| `window.onDidChangeTextEditorSelection`, `TextEditor.revealRange(range, revealType?)`, `workspace.onDidCloseTextDocument`, `window.tabGroups` | Present |
| `window.createTerminal`, `Terminal.exitStatus`, `window.onDidCloseTerminal`, `onDidEndTerminalShellExecution`, `Terminal.dispose()` | Present (but see F4) |
| `workbench.action.lockEditorGroup` | Exists (`editorCommands.ts`). With no args it resolves the **active** group (`resolveCommandsContext`). Precondition `!activeEditorGroupLocked`. See F3 |
| `workbench.editor.autoLockGroups` | User setting keyed by editor id. It auto-locks only when more than one group is open and the opened editor's id is in the set (`editorGroupView.ts`). An extension cannot rely on it being enabled for its webview |
| `editorInsets` still proposed in 1.140 | Confirmed (`release/1.140/src/vscode-dts/vscode.proposed.editorInsets.d.ts`) — AD-1's rejection rationale holds |
| Red Hat YAML `registerContributor(schema: string, requestSchema: (resource) => string, requestSchemaContent: (uri) => Promise<string> \| string, label?: string)` | Confirmed in `src/schema-extension-api.ts` (main). Obtained via `extensions.getExtension('redhat.vscode-yaml').activate()` |
| `extensionDependencies: ["redhat.vscode-yaml"]` id | Correct id, published on both Marketplace and Open VSX (so Open VSX installs resolve the dependency) |
| vsce rejects @types/vscode newer than engine | Confirmed: `@vscode/vsce@4.0.0 out/validation.js:128` — "@types/vscode X greater than engines.vscode Y" |

## Findings

### F1 — @types/vscode 1.140.0 breaks packaging with engines ^1.100.0 [HIGH]
vsce 4.0.0 fails packaging when the `@types/vscode` range is higher than `engines.vscode`. generator-code also writes the *latest* VS Code version into both fields (`env.js` `versions["@types/vscode"] = vscodeVersion`), so the scaffold will not produce ^1.100.0 by default.
**Fix:** If you keep the ^1.100.0 floor, pin `@types/vscode` to `1.100.0` and edit `engines.vscode` after scaffolding. Otherwise raise the engine to `^1.140.0`. Record which one you choose in the Stack row.

### F2 — TypeScript must be pinned to 6.0.x, not "latest" [HIGH]
npm `latest` is 7.0.2, the native port. It exposes only `unstable/*` APIs, not the classic compiler API. typescript-eslint 8.71.1 (the scaffold's linter) requires `typescript <6.1.0`. generator-code 1.12.0 pins `^6.0.3`.
**Fix:** Change the Stack row to `typescript ~6.0.3` (6.0.3 verified), and use `~` rather than `^` so 6.1 cannot slip in before typescript-eslint supports it.

### F3 — AD-1 "lock the graph group" does not work with `preserveFocus: true` as written [MEDIUM]
`workbench.action.lockEditorGroup` with no arguments locks the *active* group. With `preserveFocus: true` the active group is still the text editor's, so the wrong group would be locked. The extension API exposes no group id to pass instead. `autoLockGroups` is a user setting the extension cannot count on.
**Fix:** On the panel's first creation, reveal it *with* focus, run `lockEditorGroup`, then call `showTextDocument(doc, originalColumn)` to return focus, and only if `tabGroups` shows that group is not already locked. Otherwise downgrade the lock to best-effort. Either way, state the mechanism in AD-1 and cover it with an integration test.

### F4 — AD-13 Stop has no defined mechanism on a shell `Terminal` [MEDIUM]
The `Terminal` API cannot signal the child process. The only options are `dispose()`, which kills the whole terminal and so breaks "reused on re-run", or `sendText('\x03')`, which is shell-dependent and fire-and-forget. If you use `shellPath` set to the binary, the terminal dies on exit and cannot be reused. Having the shell spawn the process also sits awkwardly with AD-9's "only the adapter spawns".
**Fix:** Use `createTerminal({ name, pty })` (ExtensionTerminalOptions / Pseudoterminal). The pty is backed by a `child_process.spawn` owned by `src/adapters/redpandaConnect`, Stop calls `child.kill('SIGINT')`, and the exit code is reported to the status bar. Write this mechanism into AD-13.

### F5 — Pin @types/node and Node LTS; plan elkjs worker loading [LOW]
- Leaving @types/node unpinned installs 26.6.4. The engine floor 1.100 runs Node 20.19.0 (1.140 runs Node 24.21.0 / Electron 43.7.3), so 26.x types let you use APIs that are missing at runtime. **Fix:** pin `@types/node 20.x` (20.19.43) while the floor is 1.100, or `24.x` if F1 raises the engine. Pin dev/CI Node to **24.x LTS (24.21.0)**, which satisfies vitest 5 (`^22.12 || ^24`) and vsce 4 (`>=22`). Node 26 enters LTS late October 2026, so recheck then.
- elkjs: `elk.bundled.js` runs on the webview main thread with no worker and is fine for POC-sized configs. A worker would have to load `elk-worker.min.js` from a webview resource URI, which needs a fetch→Blob URL workaround plus CSP `worker-src blob:`. That loading limitation is from known VS Code webview behaviour and was not re-tested in this review. **Fix:** say "elk.bundled.js, main thread" in AD-4/Stack, and treat the worker as deferred.

## Notes (no action needed)
- redhat.vscode-yaml: 1.24.0 is the latest *stable* release. The Marketplace "latest" is a nightly pre-release (1.25.x). `extensionDependencies` cannot pin a version, so users on the pre-release channel get 1.25.x. The `registerContributor` signature is unchanged on main.
- react 19.3.0 + @xyflow/react 12.12.0 + zustand 4 peer ranges are compatible.
- vitest 5.0.3 needs vite 6.4–8 as a peer. That is fine for core-only Node tests, and no React plugin is needed unless webview components get unit tests.
- Two claims were not re-verified here; both are memlog-sourced and outside this lens's registry scope: the `rpk connect lint` output format and `list --format jsonschema` behaviour. Re-check them against the user's installed binary in the first spike.
