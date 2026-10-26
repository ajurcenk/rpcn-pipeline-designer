---
title: 'Spike scripts handle unusual repo paths and re-check extracted binaries'
type: 'chore'
ticket: '6'
created: '2026-10-26'
status: done
baseline_revision: '45f85a6fb23a91151309a4359f0bc9180d444da3'
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

**Problem:** `scripts/spike/run-matrix.sh` uses the repo path as an ERE pattern in `normalize` (`s#${ROOT}#<ROOT>#g`), so a checkout path with regex characters (`.`, `[`, `(`, `#`, …) is not replaced, or breaks the `sed`. `scripts/spike/fetch-binaries.sh` re-verifies the archive's sha256 but reuses an already extracted binary whatever it contains, and CI depends on it.

**Approach:** `run-matrix.sh` escapes the repo path once for ERE (every regex character and the `#` delimiter) and uses that in `normalize`, so captures show `<ROOT>` for any checkout path. `fetch-binaries.sh` reuses an extracted binary only when its sha256 equals that of the `redpanda-connect` member of the verified archive (read from the archive, about a second per version; no extra file to trust); otherwise it re-extracts it from the archive and says so. A normal second run downloads and re-extracts nothing, and the captures, corpus records and schema fixtures stay byte-identical. The pinned versions do not change (the CI cache key, a hash of `fetch-binaries.sh`, changes once).

</frozen-after-approval>

## Implementation Notes

Oneshot: two small script changes, checked by hand (the scripts have no test harness).

- `run-matrix.sh`: `ROOT_RE`, the repo path with `][\.^$*+?(){}|#/` escaped by `sed`, is what `normalize` replaces. In a `git worktree` at `~/odd.path[1](x)#y/repo` the run succeeded (34 s) and no capture held the raw path. Its `lint-absolute-path` captures differ there (exit 0, no findings): lint reads the path as a glob, and `[1]` matches no file. That is the binary's glob handling (the extension escapes such paths, ticket 5), not the scrubbing; AC 1 holds.
- `fetch-binaries.sh`: the extracted binary is reused only when its sha256 equals the archive member's (`tar -xzOf … redpanda-connect`, about 1 s per version), else re-extracted with a line saying so. Two runs: nothing downloaded or extracted; `/bin/true` over 4.100.0's binary: re-extracted, sha256 equal to the archive's, `Version: 4.100.0`.
- AC 3: `run-matrix.sh` twice here: `git status` shows no capture, corpus record or schema fixture changed.

## Review Triage Log

Quick review. Verdicts: 0 high, 0 medium, 2 low, 1 rejected low.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | AC 1's evidence proved nothing: in the `[1]` worktree lint found no file, so no capture held the path to scrub | low | patch | Confirmed. Rerun from `~/odd.path+v1(x)#y{z}/repo` (`.`, `+`, `(`, `#`, `{` but no glob characters): exit 0, `lint-absolute-path.stderr` shows `<ROOT>/test/corpus/fixtures/invalid_field.yaml(6,1) …`, no capture holds the raw path, and every capture equals the committed one. |
| 2 | The re-extract message says "differs from the archive" also for an identical binary that only lost its execute bit | low | patch | Now "differs from the archive or is not executable". |
| 3 | A checkout path with a newline still breaks `normalize` | low | reject | Practically never met; handling newlines in a sed expression is more than a correction. |

## Verification

**Commands:**
- `scripts/spike/fetch-binaries.sh` twice -- expected: the second run prints cached and checked, downloads and extracts nothing.
- A replaced binary (`cp /bin/true .cache/redpanda-connect/4.100.0/redpanda-connect`), then `fetch-binaries.sh` -- expected: re-extracted; the binary's sha256 equals the archive member's.
- `scripts/spike/run-matrix.sh` in a `git worktree` whose path contains `.`, `[`, `(` and `#` -- expected: succeeds; no capture contains the path, only `<ROOT>`.
- `scripts/spike/run-matrix.sh` twice in this checkout -- expected: `git status` shows no change to captures, corpus records or schema fixtures.
