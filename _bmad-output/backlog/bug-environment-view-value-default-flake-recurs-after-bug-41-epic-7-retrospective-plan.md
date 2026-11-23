---
title: 'Bug 61: a removed secret''s record can come back for good (the VALUE_DEFAULT flake)'
type: 'bugfix'
ticket: '61'
created: '2026-11-23'
status: 'built'
baseline_revision: '05a32d23aa67d0ea8c32b95a49450a93f3020765'
route: 'oneshot'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The flaky check is "its record goes too" in `95-environment-view.ts`. It fails because the record write is really lost, not because it is slow. VS Code's `ExtensionMemento` (bundled 1.147.0, `extensionHostProcess.js`) keeps the extension's whole `globalState` object in `_value`. `update()` sets a key and schedules a 0 ms flush that sends `this._value` as it is when the flush fires. The main thread echoes every change to that storage back through `$acceptValue`, and the ext host then sets `this._value` to the echoed object. So an echo of an earlier write (here, the `set` of BOTH_39 a few ms before) that lands between our `update()` and its flush replaces our value. The flush then sends the old object. The main thread sees no change and sends no further echo, so the record keeps the removed key for good. The same race can drop a `set`'s record, and then "Clear stored secrets" misses a stored value.

**Approach:** `SecretVariables` checks every write of the recorded keys (`record`, and `clear`'s update) once `memento.update` resolves. If `recordedKeys()` doesn't hold what was just written, it writes again, up to 3 times. If the record is still wrong after that, it logs a line and doesn't throw. The fix stays inside `secrets.ts`. The test's 5 s `waitFor` (bug 41) stays.

</frozen-after-approval>

## Code Map

- `src/adapters/vscode/secrets.ts` L191-194 `recordedKeys`; L478-494 `record` and `serialized` (writes are serialized, read-modify-write); L326-329 `clear`'s update. These are the only writes of `SECRET_KEYS_STATE`.
- `src/test/integration/suites/60-run.ts` L243-340: `SecretVariables` built with fake mementos. New tests go here.
- `src/test/integration/suites/95-environment-view.ts` L281-310: the flaky test. Leave it unchanged.

## Tasks & Acceptance

- [ ] `secrets.ts`: a helper that writes the recorded keys, reads them back, and rewrites while they differ (up to 3 times), used by `record` and `clear`. It runs inside `serialized`.
- [ ] `60-run.ts`, tests named "bug 61", each failing without the fix: a fake memento whose next `update` of `SECRET_KEYS_STATE` is replaced by the earlier value before it resolves (the echo race). After a remove, the key is not recorded. After a set, the key is recorded. A memento that always loses the write gives a log line and no throw.

**Acceptance Criteria:**
- Given an echo of an earlier write that replaces the record's update once, when a secret is removed or set, then `recordedKeys()` ends right.
- Given a memento that never keeps the write, when a secret is removed, then the command still succeeds and logs that the record could not be written.

## Implementation Notes

- Oneshot: one guarded write in `secrets.ts` plus tests (about 60 lines).
- Evidence (2026-11-23):
  - Ext host: `xS.update` sets `_value[t]` and schedules `Hn(..., 0)`, which sends `this._value`. The `onDidChangeStorage` listener assigns `this._value = o.value`.
  - Main thread: the `onDidChangeValue(0, …)` listener calls `$acceptValue(!0, key, getExtensionStateRaw(key, !0))` for every watched key.

- `secrets.ts`: a new private `writeRecorded(keys)` writes, reads back with `recordedKeys()`, and writes again while the lists differ (3 writes in all), then logs. `record` and `clear` both use it, inside `serialized`.
- `60-run.ts`: `losingSecrets()` is a fake whose memento puts back the value from before an update, for the next `n` updates, before they resolve. Two "bug 61" tests: one lost update on a remove and on a set; a memento that never keeps the update (the log line, no value, the remove still `true`). Both fail on the baseline source and pass with the fix.
- Surprise: a `--grep` run of `60-run.ts` needs the activation suite as well (`--grep "Extension tracer path|bug 61"`), or its `before all` fails with "not known or not activated".
- Review patch: `writeRecorded(change)` now applies the change (add or drop a key, or `clear`'s filter) to the list it reads before each write, instead of writing a list made before the first write. A retry then keeps another window's newer record. A third "bug 61" test covers this: another window adds a key during this window's remove. `losingSecrets()` now builds on `fakeSecrets()` and loses only updates of `SECRET_KEYS_STATE`.

- Verification (2026-11-23, after the review patches): compile clean; test:webview 421 passed; test:corpus 182 passed; layering grep empty; multiroot 15 passing. Stable 3 times in a row: 1742 passing, 1 pending; 1741 passing, 1 pending, 1 failing; 1742 passing, 1 pending. "ticket 39 VALUE_DEFAULT …" passed in all three. The one failure (run 2) was the 7.5 metrics feed test "ACCESS REPLACED: a read in flight with the old access is dropped …" ("not stuck in refused": `refused` instead of `live`). It is unrelated to this change (no secrets code), passed in runs 1 and 3 and in the bug 59 and bug 60 runs, and is a separate flake to file.
- The first stable runs, on the code before the review patch, were stopped. They left `redpandaConnect.binaryPath` (a deleted temp path) in `.vscode-test/user-data/User/settings.json`, which was cleared before the final runs.

## Review Triage Log

**Pass 1 (quick):** high 0, medium 1, low 3, false 0, maybe-false 0. Routes: 3 patch, 1 defer.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The retry rewrites a list made before the first write, so another window's record of a key, landing around this window's write, is erased (before this change, only this window's write could be lost) | medium | patch | Confirmed: `globalState` is shared across the profile's windows, and the listener takes any change as `_value`. Fix: each attempt applies the change to the list as it is now. Covered by a new test (another window adds a key during a remove). |
| 2 | The fake's `lose(n)` counts updates of any key, not just `SECRET_KEYS_STATE` | low | patch | Confirmed. It is harmless today (the only memento key `SecretVariables` writes), but a later key would hide the race silently. Fix: only `SECRET_KEYS_STATE` updates are lost. |
| 3 | `losingSecrets()` copies `fakeSecrets()` | low | patch | Confirmed. `fakeSecrets(extra)` takes `memento` and `log`. Fix: `losingSecrets()` builds on it. |
| 4 | The same race applies to `workspaceState` (the graph panel's hidden files) | low | defer | Confirmed by reading the code (same `ExtensionMemento` class), but it is outside the plan's scope (the fix stays in `secrets.ts`) and has never been seen to fail. Added to `deferred-work.md`. |

## Verification

**Commands:**
- `npm run compile` -- expected: no errors
- `npm run test:webview` and `npm run test:corpus` -- expected: all pass
- `grep -rn "from 'vscode'" src/core src/shared src/adapters/metrics` -- expected: no output
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: all pass, the new tests included; run 3 times, and the VALUE_DEFAULT test never fails
- the same with `--label multiroot` -- expected: all pass
