# Writing the test report

Follow `test-report-format.md` and `handoff-header.md` (both in this folder).

**Header:**
- `format: test-report@2`
- `status: ready`
- `produced_by: rpcn-test@<data.plugin_version>`
- `rpcn_version` from `binary.version`
- `inputs` from Step 2, in that order. Record each `file` relative to the
  report's folder, not as `hash` printed it:
  - the pipeline as `<pipeline>` alone, never `pipes/<pipeline>`
  - the design note as `<name>.design.md`, last, only when the Design
    check ran (it wrote rows; not with any `Not run` line,
    `design-check.md` section 1)
  - any other input as its path from the pipeline's folder. For example, with
    the pipeline in `pipes/`:
    - hashed as `resources.yaml` from the project root: record
      `../resources.yaml`
    - hashed as `pipes/orders.resources.yaml`: record `orders.resources.yaml`
    - hashed as `pipes/orders.enrich.blobl`: record `orders.enrich.blobl`

**Sections:**
- Summary: `**Verdict:** pass` only with 0 lint errors, no `fail`
  sample row, a Dry run that did not fail, no failed unit test case and no
  Design check `mismatch`, else `fail`.
- Lint: `0 errors.` or the error table.
- Bloblang samples: as `samples.md` says.
- Dry run: as `dry-run.md` says.
- Unit tests: as `unit-tests.md` says.
- Design check: as `design-check.md` says; with no design note,
  `Not run: no design note.` without reading it.
- Proposed changes: one numbered item per cause, each a title, a
  `Cause:` line and a `diff` block (`fix-check.md`): lint fixes against the
  pipeline, sample fixes against the `.blobl`, dry-run and unit-test fixes
  against the file that holds the failing processor, design fixes against
  the pipeline, or `<res>` when the component is there. Or `None.`
  End an unverified fix's item title with `(unverified)`, and a fix
  rpcn-test applied to its own file with `(applied by rpcn-test)`.

**Check it** with Step 2's line 1, `<file>` = `<name>.test-report.md`. It
must report `data.ready: true`.

**Not ready:** when that `hash --check` does not report
`data.ready: true`, fix only the report's header or format once and
recheck; never re-hash an input or change a `sha256`. Still not ready: set
`status: draft`, say why, and in headless mode report `blocked`.

## The reply

Short, with only what the user needs:

- the verdict
- each failure: its cause and its fix as a diff, copied exactly from its
  Proposed changes item (in the report's order). If that diff is a no-op
  (`fix-check.md` step 2), it goes back to `fix-check.md`: revise it, or
  mark it `(unverified)`, in the report first, then copy it.
- the report path, and any other file rpcn-test wrote (such as `<tests>` or
  `<samples>`)
- each question or reason the references send to the reply, such as the
  question on a sample or unit case whose intent is unclear, or why a design
  note is not ready (`design-check.md` section 1). In headless mode these go
  in `open_questions` instead.
- Next, then the status block in headless mode

Otherwise leave out the checks that did not run: no `Not run:` line, and
no note on why a check was skipped (such as "lint failed", "there is no
design note" or "no `.blobl` files"). Those stay in the report only.
