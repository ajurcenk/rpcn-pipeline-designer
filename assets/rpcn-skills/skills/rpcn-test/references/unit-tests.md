# Unit tests

Do this once per pipeline, after the dry run. The unit tests are
`rpk connect test` cases that check what the whole of `pipeline.processors`
outputs against what it should output. They live in `<tests>`:
`<dir>/<name>_benthos_test.yaml`, beside the pipeline, so the developer
keeps them and can run them with their own
`rpk connect test [--resources <res>] <dir>/<pipeline>` (or
`rpk connect test ./...` when there is no `<res>`).

rpcn-test is the only writer of `<tests>` (AD-6). It never edits the
pipeline or a `.blobl` to make them testable: the cases fit the pipeline as
it is.

## 1. When it does not run

The section is one line, the Summary line is `Unit tests: not run`, no file
is written, and the verdict and `checks.tests` are unaffected, when:

- **Lint has errors:** `Not run: lint failed.`
- **Intent is unclear** (and there is no `<tests>` yet): nothing in the
  user's request, a ready `<dir>/<name>.design.md` or
  `<dir>/<name>.samples.json` says what the pipeline should output.
  `Not run: intent unclear.`, and a question in `open_questions`
  (headless) or the reply asking what the output should be.

## 2. An existing file

When `<tests>` exists, whoever wrote it, run it (section 4). Never add or
remove cases, or rewrite it, and write no other test file. Edit it only for a fault in
the file itself, found from the run:

- its shape: YAML or keys the binary can't parse
- a missing or stale mock: a mock keyed by a label or path the pipeline no
  longer has (`mock for label '<label>' could not be applied as the label
  was not found`), or a processor that calls an outside service with no
  mock. Key it by the processor's current label or path, as section 3 says.
- an expected value that the request or a ready design note states
  differently; the item quotes that sentence.

Never change a value to match what the pipeline outputs. Apply the fix,
re-run, and fill the section from the re-run, as `fix-check.md` says for
rpcn-test's own files. Any other failing case is reported like any other
(sections 5 and 6).

## 3. Write the cases when there is none

Write `<tests>` with Write: 2 to 4 cases, a typical message and one for
each kind of message the intent names (a threshold, a dropped message, a
missing field). Each case:

```yaml
tests:
  - name: small order gets total in cents
    target_processors: /pipeline/processors
    mocks:
      lookup:
        mapping: 'root = this.merge({"customer": {"tier": "gold"}})'
    input_batch:
      - content: '{"id":"o1","total":12.5}'
    output_batches:
      - - json_equals: {"id": "o1", "total": 12.5, "total_cents": 1250, "customer": {"tier": "gold"}}
```

- `name`: what the case checks, in a few words. Names are unique.
- `target_processors: /pipeline/processors` always. Input and output
  processors are not tested.
- `input_batch`: one entry per message, `content` the message as its input
  delivers it, JSON written compact. Reuse the dry-run messages where they
  fit.
- `output_batches`: one batch holding one condition list per output
  message, in order. A message the pipeline drops has no entry; a case
  whose every message is dropped has `output_batches: []`.
  - `json_equals` with the whole expected message.
  - `json_contains` with only the deterministic fields, when the output
    has a field from `now()`, `timestamp_unix()` or another clock,
    `uuid_v4()`, `ksuid()`, `nanoid()` or a random function, anywhere in
    the processors or a `.blobl`.
  - `content_equals` for output that is not JSON.

**Expected outputs come from intent:** the user's request, a ready
`<dir>/<name>.design.md` and the samples in `<dir>/<name>.samples.json`
(their inputs and outputs). Never run the pipeline or any part of it to
get them, never copy the dry run's outputs, and never work them out from
the code: if the code is wrong, a case must catch it. Read the pipeline
only to learn its input fields, the labels and paths of what to mock, and
what is non-deterministic. When the intent for a case is unclear, leave it
out and add a question; with no case left, see section 1.

**Mocks:** a case never calls an outside service. Each processor that calls
one (the list in `dry-run.md` section 1, at any depth, including a
`resource` processor whose resource calls one) gets a `mocks:` entry in
every case: keyed by its `label`, or, when it has none, by its path as a JSON
pointer (such as `/pipeline/processors/1`, or
`/pipeline/processors/0/branch/processors/0` inside a branch). The mock is
a `mapping` giving what the intent says the service returns (for an `http`
processor, the response body that replaces the message; inside a `branch`,
what its `result_map` reads). When the intent says nothing about the
response, use `root = this`, and the expected output keeps the message as
the mock leaves it.

Name the file in the reply and in `artifacts`.

## 4. Run them

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py test [--resources <res>] <dir>/<pipeline>
```

Pass `--resources <res>` when `<res>` exists (the same `<res>` as lint: a
cache or rate-limit resource in it stops the target from starting without
it), and no other flag: never `--env-file`. The developer's own command is
then `rpk connect test [--resources <res>] <dir>/<pipeline>`. The binary finds
`<tests>` beside the pipeline; an unset `${VAR}` does not stop a test, and
`from "<path>"` resolves from the project root, as in lint.

**Counts**, from `<tests>`: `<n>` is the number of cases under `tests:`.

- **Exit 0:** `<n>` passed, 0 failed.
- **Exit 1 with `data.failures`:** one row per entry, `case`, `line`
  (empty for `null`) and the first line of `message`, verbatim. `<f>` is
  the number of distinct failing case names, `<p>` is `<n>` − `<f>`.
- **Exit 1, `No tests were found`:** `<tests>` has no cases; one row with
  that message, and the line is `0 passed, 1 failed`.
- **Any other exit 1 with no `data.failures`** (such as `failed to execute
  test target` when a processor fails to initialise, `test target failed`,
  or `test exited <n>` when the binary can't parse `<tests>`): the target
  failed to start. One row with empty `case` and `line` and
  `errors[0].message`. Every case counts as failed (at least 1), so
  `<p>` is 0. A check failure, not `blocked`.
- **Exit 2:** the section is `Not run: <errors[0].message>`, the Summary
  line `Unit tests: not run`, the same message in `open_questions`, and the
  verdict is unaffected.

## 5. Fill the section

As `test-report-format.md` says: the line
`` `<name>_benthos_test.yaml`: <p> passed, <f> failed. ``, then the line
`` Run with `rpk connect test [--resources <res>] <dir>/<pipeline>`. `` with
the command as run (`<res>` and `<dir>/` as given), then the table
`case`, `line`, `message` when any case failed. The Summary line is
`Unit tests: <p> passed, <f> failed`. Any failed case or failed target
makes the verdict `fail`.

**Never change a case to make it pass**, nor rerun with another file.
A section 2 fault fix is not that: it never takes a value from the output.

## 6. Propose the fix

For cases rpcn-test wrote in this run, add one Proposed changes item per
cause, as `fix-check.md` says: a title naming the failing cases, the
cause, then a `diff` against the file that holds the wrong processor, the
pipeline (`+++ b/<pipeline>`) or its `.blobl`, so it outputs what the
intent says. For a failed target, the fix makes the pipeline start. A
dry-run or sample fix that already covers the cause is not repeated.

For cases in an existing file (after any section 2 fix), propose a
pipeline fix when the request or design note agree with the case. When
they don't settle it, propose the pipeline fix the case implies as
`(unverified)` and add a question saying which case and the intent
disagree, as `fix-check.md` step 3 says.

Check it in the temp folder `dry-run.md` names: write the fixed pipeline
there as `<pipeline>` (for a `.blobl` fix, a copy of the pipeline whose
`from` path is the fixed copy's absolute path), copy `<tests>` beside it
unchanged as `<name>_benthos_test.yaml`, and run the `test` command, with
the same `--resources`, on `<temp>/<pipeline>`. Every case passes.
Revisions and `(unverified)` are as `fix-check.md` says.

## 7. Status block

`checks.tests` folds the unit tests in, as `status-block.md` says.
