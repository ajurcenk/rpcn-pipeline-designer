# Status block

In headless mode, end the reply with exactly one fenced `json` block, then
nothing:

```json
{"status": "<complete|blocked>", "skill": "rpcn-test", "reason": null, "artifacts": [], "checks": {"lint": "<pass|fail|skipped>", "tests": "<pass|fail|skipped>"}, "open_questions": []}
```

Fill it this way:

- `status`: `blocked` (with `reason` the first error) only after an exit 2
  in Steps 1–4 (but the design note's `hash --check`, `blobl`, `run` and
  `test`, which `design-check.md`, `samples.md`, `dry-run.md` and
  `unit-tests.md` handle) or a report that stays not ready; otherwise
  `complete`, even when lint, a sample, the dry run, a unit test or the
  Design check fails.
- `checks.lint`: `pass`, `fail`, or `skipped` when lint did not run.
- `checks.tests`: the Bloblang samples (`samples.md`), the dry run
  (`dry-run.md`), the unit tests (`unit-tests.md`) and the Design check
  (`design-check.md`) together: `fail` when any sample row is `fail`, the
  dry run failed, any unit test case failed or any Design check row is
  `mismatch`; `pass` when at least one of them ran and none failed;
  `skipped` when none ran (a `Not run` section did not run). There is no
  separate key for the Design check (AD-8 has only `lint` and `tests`).
- `artifacts`: the report path and, when written or edited in this run
  (an `(applied by rpcn-test)` fix), the samples file and
  `<dir>/<name>_benthos_test.yaml`; or `[]`.
- Questions go in `open_questions`, with a not-ready design note's reason.
