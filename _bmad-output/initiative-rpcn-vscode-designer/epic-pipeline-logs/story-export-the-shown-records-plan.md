---
title: 'Export the shown records'
type: 'feature'
ticket: '8'
created: '2026-11-06'
status: 'done'
baseline_revision: '29698269729cdfae1ce22fa43c92908b5564bf52'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/epic-pipeline-logs.md
  - _bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/story-filter-and-search-the-log-plan.md
  - src/adapters/vscode/logsPanel.ts
  - src/adapters/logs/records.ts
  - src/shared/logsProtocol.ts
  - webview/src/logs/LogsView.tsx
  - src/test/helpers/fakeLogs.ts
  - src/test/integration/suites/97-logs.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** What the Pipeline Logs tab shows (a range, filtered and searched) cannot leave VS Code except one record at a time with Copy JSON, so it cannot be attached to an issue, diffed or processed with `jq`.

**Approach:** Board 3's **Export…** button at the end of the toolbar saves the records the panel shows, after its filters and search, oldest first, as a JSON lines file (one record per line) at a place the user picks in VS Code's save dialog, masked exactly as the panel is.

**Decisions (2026-11-06; the recommended default, the user said "continue" without choosing):**
- Each line is the record's value as shown: the JSON object of `row.json` on one line (masked, `license_org` left out, `pipeline_id` kept); a value that is not a JSON object becomes `{"time":"<ISO time>","message":"<its text>"}`. No Kafka partition, offset or timestamp is added.

## Boundaries & Constraints

**Always:**
- "Shown" is the host's kept rows at the click (the filter and search are applied on the host, 6.4), so the file holds exactly the rows the list shows, at most 5,000; records left out for the cap are not read again or exported, and the message says how many were left out.
- Every text written passes the panel's mask (secrets, the org) as the rows already do; `license_org` never appears; no credential, broker host or secret value in the file, the message or the output channel.
- A snapshot: rows that arrive while the dialog is open are not added.
- The button is disabled when no row is shown; Escape in the dialog writes nothing.
- After the save: "Exported N records to <file name>." with **Open**; a write that fails: "Could not export the records: <reason>" (masked), nothing else changed.
- 6.2–6.7 rules stand; theme colours, no branding.

**Never:**
- Formats other than JSON lines; exporting records not shown (re-reading the range, beyond the cap); a setting for the folder; writing without the save dialog.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY | Last hour, 120 rows shown | Export… → dialog with `<pipeline>-<yyyymmdd-hhmm>.jsonl` in the first workspace folder; 120 lines, oldest first; "Exported 120 records to …" with Open | none |
| FILTERED | a search and level filter, 7 of 400 match | 7 lines, those shown | none |
| MASKED | a record whose field holds a secret value and `license_org` | the line has the masked value, no `license_org` | none |
| RAW | a record whose value is not a JSON object | `{"time":"<ISO>","message":"<its text>"}` (masked) | none |
| OVER_CAP | 6,000 records read, 5,000 kept | 5,000 lines; the message adds "1,000 older records were left out for the 5,000-record limit" | none |
| NONE | no row shown | Export… disabled; the host ignores the message | none |
| CANCEL | Escape in the dialog | no file | none |
| WRITE_FAIL | the write fails | "Could not export the records: <reason>" | masked; nothing written by the extension |
| LIVE | Live on, records arriving | the rows at the click only | none |

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/logsPanel.ts` -- `kept` (:216, the shown rows, oldest first), `dropped`/`leftOutEver` (the cap's counts, :219, :248), `copyJson` (:661, the pattern for a row action), `mask` (:309), the message switch (:464); add `exportShown()` and a `pickExportUri` seam (default `vscode.window.showSaveDialog`, filters `JSON lines: jsonl`), the write with `vscode.workspace.fs.writeFile`, the message via `vscode.window.showInformationMessage`/`showErrorMessage` behind an `ui` seam the tests replace (LogsPanel has none yet: add a small `{ save, info, error }` object on the instance).
- `src/adapters/logs/records.ts` -- `toLogRow` (:69) builds `json`; add a pure `exportLine(row)` (here or a new `src/adapters/logs/export.ts`): `JSON.stringify(JSON.parse(row.json))` for a JSON row (the masking already happened before `json` was written; do not re-mask), the raw form `{"time","message"}`; unit-tested.
- `src/shared/logsProtocol.ts` -- webview → host `{ type: 'exportRequested' }` (:491–516) and its parser case.
- `webview/src/logs/LogsView.tsx` -- the toolbar `rpcn-logs-tools` (:591–601): an **Export…** button after the range menu, `aria-label="Export the shown records"`, disabled with no rows; `logs.css` only if needed.
- Tests: unit for `exportLine`; `src/test/integration/suites/97-logs.ts` every matrix row against the fake (the seam returns a temp-dir URI; read the file back; assert no secret value from `fakeLogs.ts`'s masked fixtures); `webview/src/logs/LogsView.test.tsx` for the button, disabled state and the message.
- `README.md` Pipeline logs section (:110), `CHANGELOG.md` Unreleased.
- Do not change: the reading, filter, cap or strip logic.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/logs/export.ts` + unit tests -- the line format.
- [x] `logsPanel.ts`, `logsProtocol.ts` -- the request, the dialog, the write, the messages, the seams.
- [x] `webview/src/logs/LogsView.tsx` + tests -- the button.
- [x] `97-logs.ts` -- every matrix row.
- [x] `README.md`, `CHANGELOG.md`.

**Acceptance Criteria:**
- Given a fake pipeline with 400 records in the last hour, 7 of them WARN with "secret" and a secret value in a field, when Last hour is read with Warn only and the search "secret" and Export… saves, then the file has 7 lines equal to the shown rows' values in order, and contains no secret value and no `license_org`.
- Given the change, when compile, unit, webview, stable, multi-root and corpus runs execute (vscode-test under `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a`, each capped with `timeout`), then all pass.

## Implementation Notes

- `src/adapters/logs/export.ts`: `exportLine`, `exportText` (a line break after every line), `exportFileName` (the masked pipeline name, characters outside `[A-Za-z0-9._-]` as `-`, `pipeline` when nothing is left; local time), `exportedMessage` (also "N newer records were dropped for the 5,000-record limit." when Load older dropped the newest), `EXPORT_FAILED_PREFIX`.
- `LogsPanel.exportShown()` returns `{ kind: 'nothing' | 'cancelled' | 'exported' | 'failed' }` (test seam); the seam is `ui: LogsExportUi` (`save`, `info`, `error`); Open runs `vscode.open`. With no workspace folder the dialog offers the home folder. The output channel gets "Pipeline logs: exported N records of <title> to <path>." or the failure (masked). `ExtensionApi.logs` gains `exportShown` and `ui`.
- The webview button `rpcn-logs-export` ("Export…", `aria-label`/`title` "Export the shown records") is disabled while the view has no row; no CSS change.

## Plan Change Log

## Review Triage Log

Quick review (2026-11-06): 0 high, 0 medium, 3 low patched, 1 low rejected, 1 false.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | A write failing partway (disk full) leaves a truncated file | low | `workspace.fs.writeFile` has no temp-and-rename; the matrix's "nothing written by the extension" is met for the tested failure | reject (rare in everyday use; the fix, a temp file and rename or a cleanup that could also delete a file the user chose to overwrite, adds branches) |
| 2 | Errors outside the write (the dialog, building the text, `vscode.open`) reject a promise the message switch discards: no message, no log line | low | only `writeFile` is in the `try`; `void this.exportShown()` | patch (one masked error path for the whole export) |
| 3 | README and CHANGELOG omit the "N newer records were dropped" note `exportedMessage` adds | low | `export.ts` `exportedMessage` | patch |
| 4 | The `ExtensionApi.logs` doc comment does not mention `exportShown` and `ui` | low | `src/extension.ts` | patch |
| 5 | No unit run recorded; the manual check not done | false | `.vscode-test.mjs` runs `out/test/**/*.test.js`, `export.test.ts` included, in the stable run; the manual check is the user's step | reject |

## Verification

**Result (2026-11-06):** compile passes; stable 1358 passing, 1 pending (NEEDS_NEWER, skipped on a new VS Code); multi-root 10; corpus 156; webview 378. No floor run. After the review's patches (2026-11-06, run by the orchestrator): compile, corpus 156, webview 378, stable 1358 passing (1 pending), multi-root 10; no floor run. After review: every error in the export (the dialog, building the text, the write) takes the masked "Could not export the records: <reason>" path with an output-channel line; one after the write (the message, Open) is shown masked and the result stays `exported`.

**Manual check result (user, 2026-11-06):** passed on the 1.143.1 dev host against the real organization: "tested, no issues" (`errors.yaml` on rpc-vilnius: Export… at the end of the toolbar; Last hour with the search `failure` exported to the suggested `<pipeline>-<yyyymmdd-hhmm>.jsonl`, the message's count matching the list, Open showing one object per line, oldest first, no `license_org`; Escape writing nothing; the button disabled with no match; an export while Live). Automated: stable 1358, multi-root 10, corpus 156, webview 378; no floor run.

**Commands:**
- `npm run compile`; `npm run pretest && timeout -k 15 1500 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a npx vscode-test --label stable` (alone, the dev host closed); `--label multiroot`; `npm run test:corpus`; `npm run test:webview` -- all pass. No floor run.

**Manual checks:**
- Dev host 1.143.1 on `rpc-vilnius`: `errors.yaml`, Last hour, search `failure`, Export… → the file has the shown records only, one per line; Open shows it.
