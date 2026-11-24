# Applying a test report

rpcn-test writes `<name>.test-report.md` and never edits the pipeline. Its
Proposed changes are diffs that rpcn-author applies (AD-6). Use the report
only after `hash --check` in Step 7 reported `data.ready: true`. The report
may have the verdict `pass` or `fail`.

## 1. Check the readiness list

Read the report and check the readiness list in `test-report-format.md`
(in this folder): the sections in order (seven for `format: test-report@2`;
six for `test-report@1`, which has no Dry run), a `**Verdict:**` line, and
each section that did not run says `Not run` and why. Both formats are read
the same way otherwise: the Dry run section only informs, and its fixes, if
any, are Proposed changes items like any other. If an item fails, treat
the report as not ready: change nothing, say which item failed, and in
headless mode report `blocked` with that as `reason`.

## 2. Find the files

The report's `inputs` are relative to the report's folder `<dir>/`:

- `<pipeline>` is `inputs[0]` (`<name>.yaml` or `<name>.yml`), so the
  pipeline is `<dir>/<pipeline>`.
- Each resources input (such as `<name>.resources.yaml` or
  `../resources.yaml`) is a `<res>`, as a path from the project root.
- `<name>` is the report's `pipeline` header field.

## 3. Pick the changes

Proposed changes holds numbered items, each a title, a `Cause:` line and
a fenced `diff` block, or `None.`. An older item with one line on why in
place of the title and `Cause:` line is applied the same way. With `None.` there is nothing to apply: change no
file, say so, and skip lint.

Apply an item, of any kind (a lint fix, a design fix or any other change),
only when its diff is against one of these files:

- the report's pipeline, `inputs[0]`
- a resources file listed in the report's `inputs`
- that pipeline's own Bloblang files, `<name>.<label>.blobl`
- `.env.example` in `<dir>/`

Skip every other target and name it in the reply, with why: the test report
itself, `<name>_benthos_test.yaml`, a samples file or any other file rpcn-test
owns (rpcn-test applies its own files), another pipeline, or any file not in
the list above. Never edit the report.

An item whose title ends with `(applied by rpcn-test)` is already applied
to rpcn-test's own file: skip it and say so. An item whose title ends with
`(unverified)` is still applied: lint decides.

## 4. Apply each diff

The `--- a/<file>` and `+++ b/<file>` paths are relative to `<dir>/`. Apply
each diff with the Edit tool, one hunk at a time, in the report's order:

- `old_string` is the hunk's context and `-` lines, exactly as in the file;
  `new_string` is the same lines with the `-` lines dropped and the `+`
  lines added. Strip the one-character diff prefix (space, `-` or `+`).
- Match on content, not on the `@@` line numbers: an earlier item may have
  moved lines.
- Before editing, Read the file and check that every hunk of the item is in
  it exactly once. If one isn't, don't guess: apply no hunk of that item,
  name the item in the reply, add it to `open_questions`, and go on with the
  next item. Items already applied stay applied.

After the edits, lint as in Step 6, but pass `--resources <res>` for each
resources input found in section 2 (paths from the project root). On a lint
failure, revise as Step 6 says.

## 5. Reply

List each item by number with its result: applied, skipped (the file and
why) or not applied (the hunk that didn't match). Then the files edited and
the lint result. The run ends `complete` even when some items were not
applied.
