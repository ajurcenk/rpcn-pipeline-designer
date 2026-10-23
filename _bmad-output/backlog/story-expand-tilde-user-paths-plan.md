---
title: '~user paths in path settings resolve to that user''s home'
type: 'feature'
ticket: '2'
created: '2026-10-23'
status: done
baseline_revision: 'e60c84f2bec9441b5c0a75139424c9c4b331d49e'
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

**Problem:** `redpandaConnect.binaryPath`, `resourceFiles` and `envFile` expand only `~`, `~/…` and `~\…` (`resolveSettingPath`, `src/adapters/redpandaConnect/binary.ts`). `~name` and `~name/…` are treated as paths relative to the workspace folder.

**Approach:** On Linux and macOS, a leading `~<user>` (a POSIX user name, followed by `/` or the end of the value) becomes that user's home directory, then the rest of the path. Node only knows the current user's home, so the lookup asks the system: `getent passwd <user>` on Linux (it covers LDAP and NIS users; `/etc/passwd` when `getent` can't run), Directory Services (`dscl`) on macOS. When no such user exists (or the lookup can't tell), the value resolves as before, as a path relative to the workspace folder, the way a shell keeps an unmatched `~word`: a file named `~draft.yaml` keeps working. `~`, `~/…`, absolute, relative and bare-name values resolve as before, PATH still comes first for `binaryPath` (AD-9), and Windows keeps `~` only.

**Decisions (user, 2026-10-23):**
- Linux and macOS both expand `~user`; Windows does not.
- ~~The unknown-user reason reads "there is no user named `<user>` on this machine".~~ Superseded after review (user, 2026-10-23): with no such user the value falls back to a relative path, as before, so there is no unknown-user reason. This replaces the ticket's AC 2 (an unknown user is reported as unusable).

</frozen-after-approval>

## Implementation Notes

Oneshot: a lookup module, `resolveSettingPath` taking it, the new reason in `binary.ts`, `notify.ts`, `args.ts` and `commandLine.ts`, and unit tests.

- `src/adapters/redpandaConnect/userHome.ts` (new): `userHomeLookup(platform)`, `undefined` on Windows; `getent passwd` (exit 2: no such user; `/etc/passwd` only when `getent` is not installed), `dscl /Search -read /Users/<user> NFSHomeDirectory` on macOS (local and network accounts); `execFileSync` with a 2 s limit. A definite answer is cached per user for the session; a failed lookup (a timeout) is not.
- `binary.ts`: `resolveSettingPath(…, homeOf?)` matches `~<user>` (POSIX name `[A-Za-z_][\w.-]*$?`, then `/` or the end) and, when the user exists, joins the rest to their home; otherwise, and without `homeOf` (Windows), the old rules apply. `ResolveEnvironment` / `ArgsEnvironment` get `homeOf`, filled by `userHomeLookup()` in production; `args.ts` passes it through.
- After review the unknown-user reason (`InvalidReason`, `notify.ts`, the `unusableSetting` failure) was taken out again: the user chose the relative fallback.
- Tests: `binary.test.ts` (resolution with a lookup, `~draft.yaml` and an unknown user relative, other forms unchanged, `resolveBinaryState` for a known user and an unknown one, with and without a workspace), `args.test.ts` (`~alice/…` in both settings, `~draft.yaml` relative), `userHome.test.ts` (the real lookup for the current user and an unknown one; Windows has none). The adapter suites: 184 passing. The macOS lookup is not run here (Linux machine).
- Docs: README and the three `package.json` setting descriptions, CHANGELOG.

## Review Triage Log

Quick review. Verdicts: 1 medium, 4 low; one intent question answered by the user.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | A failed lookup (a `getent` timeout on a slow LDAP server, any `dscl` failure) was cached as "no such user" for the session; Retry could not recover | medium | patch | Confirmed. Only definite answers are cached; `/etc/passwd` is read only when `getent` is not installed. |
| 2 | macOS `dscl .` sees local users only | low | patch | Now `dscl /Search`, local and network accounts, like `getent` on Linux. |
| 3 | A file named `~draft.yaml` (or `~old.env`) became an "unknown user" error | low | intent (asked) | The user chose the relative fallback; the frozen intent records it, and the unknown-user reason is gone. |
| 4 | `unusableSetting.user` optional, not tied to its reason | low | moot | The reason was removed with 3. |
| 5 | The test did not check that nothing is spawned for an unknown user | low | moot | With 3 an unknown user is a relative path; the test now resolves it against a workspace binary. |

## Verification

**Commands:**
- `npm run compile` -- expected: passes.
- `npm run pretest && xvfb-run -a npx vscode-test --label stable --grep "adapters/redpandaConnect"` -- expected: all pass (184).
