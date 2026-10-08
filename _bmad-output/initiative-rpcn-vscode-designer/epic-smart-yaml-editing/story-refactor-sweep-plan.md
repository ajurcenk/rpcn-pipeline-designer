---
title: 'Refactor sweep'
type: 'refactor'
ticket: '12'
created: '2026-10-08'
status: 'done'
baseline_revision: '98c8b8267ac1eb7fb76a59ff3aa5383e3b38df37'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-foundation/epic-foundation-retrospective.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Building E2 left cleanup behind:
- every provider re-parses the document per request;
- the integration tests sit in one file of about 1,070 lines with duplicated helpers;
- `src/core/bloblang.ts` and the composition root have grown;
- answered open questions remain in the E2 notes;
- the E1 retro reconciliation actions A2 and A3 are still open;
- deferred review items are not yet tickets.

**Approach (user, 2026-10-08: "continue with 2.12", on the proposed list):** one behaviour-neutral pass over exactly these items, each as its own commit:
1. A shared parse cache per document version, used by the gap completion, Bloblang, snippet and Quick Fix providers.
2. Split `src/test/extension.test.ts` into per-feature files under `src/test/integration/`, with shared helpers and the same tests in the same order.
3. Split `src/core/bloblang.ts` into the catalog (`bloblangCatalog.ts`) and the context and scanner.
4. Group the provider registrations in `src/extension.ts` into one function, with the same wiring.
5. E2 notes: mark the inception open questions that later tickets answered.
6. Retro A2 and A3: reconcile the spec and architecture with what was built. The items are the spec's answered open questions, CAP-14 "cookbook", the AD-9 long-flag wording, mocha vs vitest, the Node pin, and the 1.6 entry's `defaultSnippets`, each with a memlog line.
7. README and CHANGELOG checked against the code.
8. `scripts/dev-host.sh`: starts the manual-test VS Code from a folder outside `/tmp` (dev tooling).
9. Backlog stories for the deferred items:
   - the Quick Fix in name-keyed maps;
   - Bloblang methods on the left of `=`;
   - multi-root settings (the story exists; it gets a note);
   - an automated real-binary Run UI check.

## Boundaries & Constraints

**Always:**
- **Behaviour-neutral:** no change to settings, commands, log or notification text, completion items, diagnostics, argv or the schema transform output.
- **Green after every item:** `npm test` (stable and 1.100.0), `npm run test:corpus` and CI.
- **Tests:** the count stays the same or grows.

**Never:**
- new features (anything new becomes a backlog story);
- skipped or weakened tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SUITE | `npm test` before and after | the same 508 tests pass on both VS Code versions | — |
| CORPUS | `npm run test:corpus` | 89 passed, no record changes | — |
| PARSE_CACHE | two providers on the same document version | one parse | — |
| CI | a push after each item | green | — |

</frozen-after-approval>

## Implementation Notes

One commit per item, in the approved order:

| # | Commit | What changed |
|---|---|---|
| 1 | a46d244 | `src/adapters/vscode/parseCache.ts`: `parsedDocument(doc)` keeps one `parseYaml` result per URI and document version; the Quick Fix, gap completion, Bloblang and snippet providers use it, and `forgetDocument` drops the entry on close. One new test (PARSE_CACHE), so the suite has 509 tests, not 508. |
| 2 | c742d9e | `src/test/extension.test.ts` split into `src/test/integration/suites/00-activation` … `70-feedback`, with shared `helpers.ts` and `schemaHarness.ts`. `integration/index.test.ts` imports the suites in order, because mocha loaded the split files in reverse. Same tests, same order. |
| 3 | 1a55e6a | `src/core/bloblangCatalog.ts` (146 lines: catalog types, builder, docs, snippets, type narrowing) split from `bloblang.ts` (300 lines: regions, scanner, context, items, hover), which re-exports the catalog; `schema.ts` imports the catalog directly. |
| 4 | 3d5eb85 | `registerEditorProviders(schema, detection)` in `src/extension.ts` registers the five editor providers and the parse-cache cleanup, in the same order with the same selectors and trigger characters. |
| 5 | b3743e7 | Each inception open question in the E2 notes names the ticket or decision that answered it. |
| 6 | a7b6b77 | Spec Open Questions closed (1.1 spike), CAP-14 and E1 name the Apache-2.0 corpus, AD-9 and E1 R4 use the long flags (plus lint's `--deprecated`), the Tests convention is mocha via `@vscode/test-cli` plus vitest for the corpus, Node is 24.x, and the 1.6 entry no longer lists `defaultSnippets`. Memlog lines in the spec and architecture; retro A2, A3 and A4 marked done. |
| 7 | c126c0c | README: status note, a "Bloblang" section title, and the `resourceFiles` / `envFile` settings no longer marked unused. CHANGELOG: the builder and runner lines no longer say unused. |
| 8 | 1941be3 | `scripts/dev-host.sh [folder] [file...]`: rebuilds and (re)starts VS Code with the extension from source, its own profile and Red Hat YAML 1.24.0 under the git-ignored `.dev-host/` (also in `.vscodeignore`); README Development section. Tried once: the window started. |
| 9 | ef69504 | Backlog 7 (Quick Fix inside name-keyed maps), 8 (no Bloblang methods on the left of an assignment), 9 (automated Run and Stop check with a real binary); a note on backlog 4 (multi-root). |

- **Flake (item 1):** one run on VS Code 1.100.0 had a single failure that did not reproduce; four later full runs on both versions were green. Not investigated further.
- **Pushes:** items 1–8 were pushed together, then item 9, not one push per item. The CI run for 1941be3 failed while installing YAML by Red Hat (Marketplace 503), before any test ran.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-08; subagent, read-only, over `98c8b82..HEAD` in `src`, `scripts` and the ignore files):** no behaviour change found. Parse cache keyed by URI and version with close cleanup; 41 integration tests before and after, bodies identical apart from the `h.` helper prefix; the Bloblang move is verbatim with every export kept; the provider wiring is unchanged. 4 low findings: 3 patched, 1 accepted.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The BECOMES_DETECTED, PATTERN and SCHEMA_CHANGES tests now run before the gap, Bloblang and snippet tests, and the old "Schema contributor" suite is four suites (`--grep` by that name selects fewer tests) | low | accept | Each suite sets up its own fake binary, so this is more isolation; SCHEMA_CHANGES stays last in its suite. |
| 2 | `dev-host.sh` waited a fixed 2 s after `pkill`, so a slow exit could hand the new window to the dying instance | low | patch | Polls `pgrep` up to 10 s and stops with a message if the old window is still there; restart checked by hand (new PID). |
| 3 | The `pkill -f` pattern was an unescaped regex of the repo path | low | patch | Regex metacharacters are escaped. |
| 4 | A file passed as the first argument was `mkdir -p`'d (error or a directory named `foo.yaml`) | low | patch | An existing non-folder is rejected with a usage message (exit 2); checked by hand. |

## Verification

**Commands:**
- `npm test`: 509 passing on VS Code stable and on 1.100.0, after every code item (508 plus the PARSE_CACHE test).
- `npm run test:corpus`: 89 passed, no record changes.
- `npx tsc --noEmit`, `npx eslint src`: clean.
- CI: green on the final push (see the commit after ef69504); the 1941be3 run failed on a Marketplace 503 before the tests.
