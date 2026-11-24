# Bloblang samples

Do this for each `<blobl>` from Step 2, after lint. `blobl-files.md` (in
this folder) says how a `from` path maps to the file's path. Only `.blobl`
files get samples; inline mappings don't. With no `<blobl>`, the Bloblang
samples section is `Not run: no .blobl file.`

`<samples>` is `<dir>/<name>.samples.json`, in `samples-format.md` (in this
folder). rpcn-test is its only writer (AD-6), whoever last changed it, and
never edits the pipeline or a `.blobl`.

**Non-deterministic mappings:** a `<blobl>` that calls `now()`,
`timestamp_unix()` (or another clock function), `uuid_v4()` or a random
function can't be sampled. Its rows are one line
`Not run: non-deterministic (<function>)`, with the same line in
`open_questions`, and no samples are written or run for it.

## 1. Write samples when there are none

If `<samples>` is missing, or has no `mappings` key for a `<blobl>` (its
bare file name), write the missing entries with Write before running.
Keep every existing sample exactly as it is.

- Write 2 to 4 samples per mapping: a typical message, and one for each
  case the intent names (a threshold, a dropped message, a missing field).
- **Expected outputs come from intent:** the user's request, a ready
  `<dir>/<name>.design.md`, and what the mapping's file name and label say
  it does. Never run the mapping to get them, never copy what it printed,
  and never work them out from its code: if the code is wrong, the sample
  must catch it. Read the mapping only to learn its input fields.
- When the intent for a case is unclear, leave that sample out and add a
  question to `open_questions` (headless) or the reply. With no sample left
  for a mapping, its row is `Not run: intent unclear.`
- Name the file you wrote in the reply and in `artifacts`.

## 2. Run the samples

Run the Step 3 `blobl` command for each `<blobl>`, with `--env-file` when
lint had one:

- **Exit 0, or exit 1 with `data.samples` filled:** one row per entry.
- **Exit 1 with `data.samples` empty:** the mapping didn't run (it does not
  parse, or the binary failed on it); `errors[0]` is the reason. One `fail`
  row, counted as 1 failed. This is a check failure, not a blocked run.
- **Exit 2:** the samples file is invalid, or has no entry for the mapping
  (`errors[0].message` names the key or line). Fix the file's shape once,
  whoever wrote it, and run again: JSON syntax, keys, a missing entry
  (written as in section 1). Never change an expected value here. A shape
  fix to a file that existed before this run is an item
  `(applied by rpcn-test)` (`fix-check.md`). If it still
  exits 2, that mapping gets one `fail` row with the message as `actual`,
  counted as 1 failed, and the same message goes in `open_questions`. The
  run goes on.

## 3. Fill the section

Columns as `test-report-format.md` says, one row per sample, each cell
in backticks, with values copied verbatim from `data.samples[]`:

- `mapping`: the `.blobl` file name
- `sample`: `name`, then `input`, each in its own backticks
- `expected`: `expected`, or `deleted` when `deleted` is true
- `actual`: `actual`, `deleted` when it is `""`, or `error` when it is null
- `result`: `result`

A row for a mapping that didn't run (or an exit 2 that stayed) has empty
`sample` and `expected`, and `errors[0].message`, with its line when it has
one, as `actual`. The Summary line is
`Bloblang samples: <passed> passed, <failed> failed`, each summed over
every `<blobl>` (`data.passed` and `data.failed`, plus 1 failed for each
such row). Any `fail` row makes the verdict `fail`.

**Never change an expected value to make a sample pass.** A mismatch stays
a `fail` row, and the expected values stay as they were. The one exception:
a sample in an existing `<samples>` whose expected value the request or a
ready design note states differently. Fix that value to what they say, as
`fix-check.md` says for rpcn-test's own files, and quote the sentence in
the item. Never change a value to what the mapping printed.

## 4. Propose the fix

For each cause of a `fail` row from the mapping's code (not from an exit
2), add one Proposed changes item as `fix-check.md` says: a title naming
the failed samples, the cause, then a `diff` against the `.blobl` file
(`--- a/<name>.<label>.blobl`, `+++ b/<name>.<label>.blobl`, relative to
the report's folder) for rpcn-author to apply. A mapping that didn't run
(it does not parse) gets one too.

Check it: run the `blobl` command on the fixed copy in the temp folder with
the same `--samples <samples>`. Every sample of that mapping passes.

## 5. Status block

The samples feed `checks.tests` together with the dry run, as
`status-block.md` says: any `fail` sample row makes it `fail`.
