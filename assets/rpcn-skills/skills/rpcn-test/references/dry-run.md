# Dry run

Do this once per pipeline, after lint and the Bloblang samples. The dry run
runs the pipeline on a few messages: `run --bounded` replaces its input with
stdin and its output with stdout, inside `rpcn_check.py`, so no broker, API
or sink is touched and the pipeline file is never edited (AD-4, AD-6). It
catches what lint and samples can't, such as a mapping that meets a field
of the wrong type.

**What it covers:** only `pipeline.processors`. The bounded run replaces the
whole input and output, so `input.processors`, `output.processors`, and the
routing of a `switch`, `fallback` or `broker` output do not run. When the
pipeline has any of these, the section's `Skipped:` line names them.

**The temp folder** is `<system temp dir>/rpcn-test-${CLAUDE_SESSION_ID}/`
(if the variable is not expanded, end the folder name in 8 random letters).
`<system temp dir>` is `/tmp` (on Windows, `%TEMP%`): never run a command
to learn it or the session ID. Never write a dry-run file beside the
pipeline.

## 1. When it does not run

The Dry run section is one line, the Summary line is `Dry run: not run`,
and the verdict and `checks.tests` are unaffected, when:

- **Lint has errors:** `Not run: lint failed.`
- **It needs an outside service:** a processor or resource in the pipeline
  or `<res>` calls one, even with stdin and stdout in place:
  `Not run: needs <component>`, with the first such component's name as
  written (such as `http` or `cache (redis)`). Look at any depth (inside
  `branch`, `switch`, `workflow`, `try`, `catch` and the like). It counts
  only when it calls an outside service:
  - processors: `http`, `http_client`, any `sql_*`, `redis*`, `mongodb`,
    `couchbase`, `cassandra`, `elasticsearch*`, `opensearch`, `aws_*`,
    `gcp_*`, `azure_*`, `nats*`, `redpanda` or any Kafka-protocol
    component, `schema_registry_*`, `openai_*`, `ollama_*` and other AI or
    cloud processors, `command`, `subprocess`, `wasm`
  - a `cache` or `rate_limit` processor whose resource is not local (a
    `memory`, `lru`, `ttlru` or `local` resource is local and does not
    count)
  - a `resource` processor whose processor resource calls an outside
    service by these rules (a local processor resource does not count)
  - any `input_resources` or `output_resources` entry on the network
    (anything but `stdin`, `stdout`, `file`, `generate` and the like), and
    any `cache_resources` or `rate_limit_resources` entry that is not local

## 2. Write the input messages from intent

Write 2 to 4 messages with Write, one message per line, to `<msgs>`:
`<name>.dry-run.jsonl` in the temp folder. This file is temporary.

- **The messages come from intent:** the user's request, the Inputs
  section of a ready `<dir>/<name>.design.md`, and the `input` of each
  sample in `<dir>/<name>.samples.json`. Never get them by running the
  pipeline or any part of it.
- Cover a typical message and each kind of message the intent says can
  arrive (a field that is sometimes a string, a missing field, a large
  value). Don't invent malformed messages the intent does not mention.
- Read the pipeline only to learn which fields the processors read, so
  every message is one the pipeline can be given.
- Write JSON messages compact. A pipeline whose input is not JSON (CSV or
  plain lines) gets lines as its input would deliver them; the section
  then shows them verbatim in a `text` block.

## 3. Run it

Run the Step 3 `run` command with `--input <msgs>`, the same `--resources`
as lint, and `--env-file` when lint had one.

- **Exit 0:** `Result: passed`. Errors a `catch` handled are not failures,
  and `rpcn_check` does not report them.
- **Exit 1 with `data.runtime_errors`:** `Result: failed`, one Errors row
  per entry: `path` (empty when null), `message` and `input`, which is the
  failing message as it reached the output. If `data.exit` is also
  non-zero, add a row with an empty `path` and `input` for each `errors[]`
  entry that is not one of the runtime errors.
- **Routed by design:** only when the top-level `output` is a `switch`
  whose first case's `check` is `errored()`, and `data.outputs` holds at
  least one message, the real run sends those runtime errors to that
  case's failure path (SOURCES: `switch` on `errored()`). They are not
  failures: list them under **Routed to the failure path:**, a table like
  Errors, with no Errors rows for them. Every other `errors[]` row still
  fails; with none, `Result: passed`. Any other output, or no message in
  `data.outputs`, fails as above. Judge it from the pipeline YAML alone:
  it needs no design note and no other reference.
- **Exit 1, `errors[0].message` contains `required environment variables
  were not set: [A B …]`:** the run needs values for the variables the
  pipeline interpolates. Write `<name>.dry-run.env` in the temp folder: the
  lines of the user's `--env-file` if there is one, then `<VAR>=dry-run`
  for each listed variable not in it. Run once more with `--env-file` set
  to that file. This is the only `--env-file` the user doesn't name.
- **Any other exit 1:** `Result: failed`, one Errors row per `errors[]`
  entry, with an empty `path` and `input` and the message.
- **Exit 2, `errors[0].message` is `run timed out after <s>s`:** the
  pipeline didn't finish. `Result: failed`, one row per
  `data.runtime_errors` entry found before it, then one row with an empty
  `path` and `input` and that message, and the outputs printed before it.
  This is a check failure, not a blocked run.
- **Any other exit 2:** `Not run: <errors[0].message>`, the same message in
  `open_questions`, and the verdict is unaffected.

## 4. Fill the section

As `test-report-format.md` says: `Result: passed` or `Result: failed`, the
`Skipped:` line when the pipeline has input or output processors or a
`switch`, `fallback` or `broker` output, **Input messages:** with `<msgs>`
exactly as written, **Outputs:** with `data.outputs` (or `None.`), and
**Errors** only when failed. Copy paths, messages and inputs verbatim from
`rpcn_check`. The Summary line is `Dry run: passed`, or
`Dry run: failed (<n> errors)` with the number of Errors rows, either one
followed by `, <r> routed` when messages were routed. A failed
dry run makes the verdict `fail`.

## 5. Propose the fix

For each processor with an Errors row, add one Proposed changes item as
`fix-check.md` says: a title naming the error, its `path` and the failing
message, the cause, then a `diff`
against the file that holds that processor: the pipeline, or its `.blobl`
when the mapping is loaded with `from`. The fix makes the processor handle
that message the way the intent says (for example `this.total.number()` for
a total that can arrive as a string). Never fix it by changing the input
messages.

Check it, writing the fixed file under the same name into the temp folder:

- **A fixed pipeline:** run the `run` command on that copy with the same
  flags and the same `--input <msgs>`. It passes with exit 0.
- **A fixed `.blobl`:** when `<dir>/<name>.samples.json` has samples for
  it, run the Step 3 `blobl` command on the copy with those `--samples`, as
  `samples.md` section 4 does. When it has none, or the mapping is not the
  first processor (so the pipeline's input is not its input), it can't be
  checked.

A timeout or a failure that is not a processor error also gets an item,
checked the same way. Revisions, `(unverified)` and an unclear cause are as
`fix-check.md` says.

## 6. Status block

`checks.tests` folds the dry run in, as `status-block.md` says.
