---
title: 'Tracer: set up log access and show a pipeline''s live log'
type: 'feature'
ticket: '2'
created: '2026-11-05'
status: 'done'
baseline_revision: '791a901fad00c070f63fec90059607ed161e980a'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/spike-6-1-findings/findings.md
  - _bmad-output/initiative-rpcn-vscode-designer/architecture-rpcn-vscode-designer/architecture-rpcn-vscode-designer.md
  - scripts/spike/logs-probe.mjs
  - src/adapters/vscode/cloudView.ts
  - src/adapters/cloud/controlPlane.ts
  - src/adapters/bloblangPanel/panels.ts
  - src/adapters/graphPanel/html.ts
  - esbuild.js
  - package.json
  - src/test/integration/suites/96-cloud.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A pipeline deployed from VS Code can be started, stopped and compared, but its log, the only place its errors are told, needs the Cloud UI.

**Approach:** The thinnest path through every layer, on AD-24: **Set up log access…** on a Cloud view cluster row (username, password in a password box, SCRAM mechanism; a test read; kept in VS Code's secret storage per cluster only once the test read passes); **Show logs** on a pipeline row (inline and menu); a **Pipeline Logs** tab in the bottom panel, next to Output, showing that pipeline's records of the last 15 minutes and then its new records live (time, level, message, instance, further fields), behind a `LogReader` interface with an `@platformatic/kafka` implementation and an in-memory fake for the integration tests.

**Decisions (user, 2026-11-05):**
- The tab shows one pipeline at a time, named in its header; Show logs on another pipeline switches to it, and the first one is no longer read.
- Decision (user, 2026-11-05): `engines.vscode` stays `^1.100.0`. `@platformatic/kafka` needs Node 22.22 or later (it uses `Promise.withResolvers`); on a VS Code whose Node is older, Set up log access and Show logs say that Pipeline logs need a newer VS Code and send nothing, and the floor run (`--label floor`, VS Code 1.100.0) checks that message.

## Boundaries & Constraints

**Always:**
- AD-24: the address from the cluster's `kafka_api.seed_brokers` (AD-23's cluster GET), TLS with the system CAs, SCRAM-SHA-256 or -512; no consumer group, no commit; the pipeline's records are those whose key is its id (every partition read, until placement is proven); start at ListOffsets(now − 15 minutes), then fetch from the end with a 2 s wait while the tab is visible.
- The password only in VS Code's secret storage (one record per cluster), passed to the client in memory; never in a setting, a file, argv, a message, a log line or the webview. Every text the panel shows is masked like every Cloud message (5.2–5.7); `license_org` is never shown.
- The client: `@platformatic/kafka` pinned to an exact version, bundled into `dist/extension.js` with `import.meta.url` defined from `__filename` and its `native.wasm` beside the bundle; no native module in the `.vsix` (its optional `@node-rs/crc32` left out, and the reader proven to work without it).
- The panel keeps at most a fixed number of records (the oldest dropped first); stopping reading when the tab is hidden or the window closes; requests only on the user's action and while the tab follows.
- Theme only, no Redpanda branding; stable APIs, `engines.vscode ^1.100.0`; the 5.2–5.8 Cloud rules stand.

**Never:**
- History beyond the first 15 minutes, filters, search, other entry points, the full set of empty and error states, the strip, export (stories 6.3–6.8); writing to Kafka; a consumer group.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SETUP | Set up log access… on a cluster row: username, password, mechanism | a test read (metadata of the topic and one fetch); passes → stored, the row says "logs: <username>", its pipelines get Show logs | refused sign-in: "<username> could not sign in to <cluster>", nothing stored; any other failure: its message, nothing stored |
| SETUP_CANCEL | Escape at any of the three steps | nothing stored, nothing sent | none |
| SHOW | Show logs on a pipeline row of a cluster with access | the Pipeline Logs tab opens, named "<pipeline> · <cluster>"; the last 15 minutes of that pipeline's records, oldest first; then new ones appended as they are written | none |
| ONLY_THIS | the topic holds records of other pipelines | only records keyed by this pipeline's id are shown | none |
| SWITCH | Show logs on another pipeline | the tab shows the new one; the first is no longer read | none |
| NO_ACCESS | Show logs where the cluster has no access set | "Set up log access for <cluster> first", with the action | none |
| RECORD | a record with extra fields, a non-JSON value, a `license_org` | time (local), level, message, instance; extra fields after the message; a non-JSON value shown as text; `license_org` never shown | none |
| CAP | more records than the cap | the oldest dropped; the footer says how many are kept | none |
| HIDDEN | the tab hidden or closed | reading stops; showing it again resumes from the last record read | none |
| NO_LEAK | any of the above | no password in a message, the output channel, a setting, a file or the webview | none |

</frozen-after-approval>

## Code Map

- AD-24 (architecture doc) and `spike-6-1-findings/findings.md` §8 "For the stories" -- the contract; `scripts/spike/logs-probe.mjs` `platformaticClient` (~:488) -- a working groupless Consumer/Admin use (connect, metadata, offsets by time, fetch) to start the real reader from; its esbuild attempt `import-meta-shim` (capture `07-client-platformatic-bundle.json`) is the bundling recipe.
- New `src/adapters/logs/` -- `logReader.ts` (the `LogReader` interface: `test()`, `tail(pipelineId, fromTime, onRecords, signal)`; record shape `{ partition, offset, timestamp, key, value }`), `platformaticReader.ts` (the implementation), `records.ts` (pure: JSON value → shown record, extra fields, `license_org` dropped, masking hook; unit-tested). No `vscode` import.
- `src/adapters/cloud/controlPlane.ts` -- keep `kafka_api.seed_brokers` from the cluster GET on `CloudCluster`.
- `src/adapters/vscode/cloudView.ts` -- cluster row: Set up log access…, its description "logs: <username>" and a context flag; pipeline row: Show logs (inline icon and menu); the credentials per cluster in `context.secrets` (`redpandaConnect.cloud.logs.<clusterId>`, one JSON record); its `mask` reused by the panel.
- New `src/adapters/vscode/logsPanel.ts` -- the `WebviewViewProvider` for the panel tab: the one pipeline shown, the reader's session, the cap (5,000 records), stop on hide or dispose, postMessage to the webview.
- `package.json` -- `contributes.viewsContainers.panel` ("Pipeline Logs") with a `webview` view; the commands `redpandaConnect.cloud.setUpLogAccess`, `redpandaConnect.cloud.showLogs` (rows only); menus; `dependencies` gains `@platformatic/kafka` at an exact version.
- `esbuild.js` -- the extension bundle gets the `import.meta.url` define and banner; `native.wasm` copied into `dist/`; `@node-rs/crc32` left out; a new IIFE webview bundle `dist/logs.js` from `webview/src/logs/main.tsx` (the table, the header, the footer), with the existing html/CSP helper (`src/adapters/graphPanel/html.ts`).
- `.vscodeignore` -- `dist/native.wasm` kept in the `.vsix`.
- Tests: `src/test/helpers/fakeLogs.ts` (an in-memory `LogReader`: records by key and time, a live push, a refused sign-in); a new integration suite `src/test/integration/suites/97-logs.ts` for every matrix row; unit tests for `records.ts`; a webview test (vitest) for the table rendering.
- `README.md` (a Pipeline logs section), `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/logs/*` + unit tests -- the interface, the record shaping, the `@platformatic/kafka` reader.
- [x] `package.json`, `esbuild.js`, `.vscodeignore` -- the dependency, the bundle recipe, the panel container and view, the commands and menus.
- [x] `src/adapters/vscode/cloudView.ts`, `src/adapters/vscode/logsPanel.ts`, `src/extension.ts`, `webview/src/logs/*` -- setup, Show logs, the panel.
- [x] `src/test/helpers/fakeLogs.ts`, `src/test/integration/suites/97-logs.ts`, the webview test -- every matrix row.
- [x] A check that the packaged `.vsix` holds no `.node` file and that the reader loads from `dist/extension.js` without `@node-rs/crc32`.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a fake topic with records of two pipelines, when Show logs is chosen on one, then the tab shows only that pipeline's records of the last 15 minutes and appends its new ones as the fake writes them.
- Given `npx vsce package`, when the `.vsix` is listed, then it holds `dist/native.wasm` and no `.node` file.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute, then all pass.

## Implementation Notes

- `LogReader.tail` delivers every record it reads (any key) with the positions to resume at; the panel keeps the pipeline's (`isPipelineRecord`, unit-tested), so the in-memory fake is a plain topic and ONLY_THIS is exercised end to end. `tail` takes an optional `resumeAt` (HIDDEN: showing the tab again goes on from the reader's positions).
- Errors cross the bundle boundary by `name === 'LogReadError'` and `kind`, not `instanceof` (the tests' fake is compiled apart).
- Context flags: a cluster row with access is `cloudCluster logs` (Refresh's two menu entries now match `/^cloudCluster( logs)?$/`), its pipeline rows get ` logs`; Show logs is inline only with ` logs`, in the menu always (so NO_ACCESS is reachable).
- esbuild: a plugin rewrites the one `require('@node-rs/crc32')` of `@platformatic/kafka/dist/protocol/crc32c.js` into a throw (the build fails if that line moves), so the wasm CRC-32C is used even with the optional package installed in `node_modules`; another copies `native.wasm` into `dist/`. The library is loaded by dynamic `import()`, so it is evaluated on first use only.
- `@types/debug` (dev) is needed to type-check `@platformatic/kafka`'s declarations. NOTICE lists the 16 bundled packages (ajv, ajv-draft-04 and json-schema-traverse nested under @platformatic/kafka included). `npm run check:vsix` packages to a temporary path and fails without `dist/native.wasm` or with any `.node` file.
- Test seams: `api().logs` (the panel, plus `checkClient()`), `cloud().logReader`, `storedLogAccess`, `removeLogAccess` (no user command removes log access yet). BUNDLE and the main 97-logs suite skip on Node < 22.22 (the library's `engines`); there `runtime.ts` makes Set up log access and Show logs say "Pipeline logs need a newer VS Code (Node 22.22 or later; this one has <version>)" and send nothing, checked by NEEDS_NEWER in the floor run.
- The tail reads the leaders again and retries a failed fetch (NOT_LEADER_OR_FOLLOWER, LEADER_NOT_AVAILABLE, a connection error) up to 3 times with a growing backoff; the start checks the signal after each step, so a hide or switch during the connect sends nothing more.
- Every `license_org` seen is masked in later records and in the panel's title, status and log lines (`maskOrgs`); the title is masked like the rest.
- The tab shows a status line; a failed read says "Reading stopped: <reason>" and is not retried (states are story 6.6).

## Verification

**Commands:**
- `npm run compile`; `npm run pretest && xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass.
- `npx vsce package` then list the `.vsix` -- `dist/native.wasm` present, no `.node`.
- `npm run pretest && env -u WAYLAND_DISPLAY -u DISPLAY xvfb-run -a npx vscode-test --label floor` -- the logs commands' "needs a newer VS Code" message on VS Code 1.100.0; the rest of the floor passes.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: Set up log access with the spike's Redpanda user (a wrong password first: refused, nothing stored); deploy `vscode-tracer.yaml`; Show logs on it: its last 15 minutes and then new records live in the Pipeline Logs tab next to Output; Show logs on another pipeline switches.

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | NOTICE leaves out three bundled packages (`ajv`, `ajv-draft-04`, `json-schema-traverse`, nested under `@platformatic/kafka`) | medium | `dist/extension.js` bundles them; MIT notices must ship | patch |
| 2 | On VS Code whose Node is older than 22.22, every read fails with "Promise.withResolvers is not a function"; nothing explains it; the floor run is not in Verification | medium | `@platformatic/kafka` `engines.node`; `dist/apis/callbacks.js:9` | patch (user decision 2026-11-05: a "needs a newer VS Code" message, checked by the floor run) |
| 3 | The live tail stops for good on a partition leadership move (NOT_LEADER_OR_FOLLOWER, 6): leaders read once, never refreshed | medium | `platformaticReader.ts` `tail`/`fetchFrom`; AD-24: "anything else is a connection error, retried" | patch |
| 4 | `license_org` is scrubbed only inside the record that carries it; a record quoting the org without the field shows it | medium | `records.ts` `toLogRow` takes the value per record | patch |
| 5 | The panel's title (pipeline and cluster names) reaches the webview header and the view description unmasked | low | `logsPanel.ts` `postShow`, `updateDescription` | patch |
| 6 | NO_LEAK does not inspect other secret-storage keys' values or files | low | `97-logs.ts` NO_LEAK asserts only a key prefix | patch |
| 7 | The `.vsix` check (AC 2) is not automated | low | no script or test packages and lists the `.vsix` | patch |
| 8 | Hiding the tab or switching during the first connect still signs in and sends metadata and ListOffsets | low | `tail` checks `signal` only after `open()`, `partitions()`, `offsetsAt()` | patch |

**Manual check result (user, 2026-11-05):** passed on the 1.143.1 dev host against the real organization: "tested, no issues" (Set up log access refused with a wrong password and stored nothing, then stored with the right one; Show logs on vscode-tracer showed its last 15 minutes and then new records live in the Pipeline Logs tab next to Output; switching pipelines; hiding and showing the panel). Automated: stable 1261, multi-root 10, corpus 156, webview 337, check:vsix; the 1.100.0 floor passed NEEDS_NEWER, its one failure the recorded RETAKE_STEAL flake.
