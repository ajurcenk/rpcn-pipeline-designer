# Test report format, `test-report@2`

The test report `<name>.test-report.md` is what rpcn-test writes after it
checks `<name>.yaml` or `<name>.yml` (AD-6). It sits beside the pipeline in the developer's
project, and rpcn-test is its only writer. Its header follows
`handoff-header.md`, with:

```yaml
artifact: test-report
format: test-report@2
```

A breaking change to this format (a section renamed, removed or reordered, a
table column or result value changed) bumps the major to `test-report@3`.
Readers reject a major they do not know, through `rpcn_check.py hash --check`.

**`test-report@1`** is still read (`KNOWN_FORMATS` accepts both), but no
longer written. It is this format without the Dry run section: six sections,
with Unit tests right after Bloblang samples, and a verdict that does not
depend on a dry run. Everything else is the same. A reader that checks the
sections expects six for `@1` and seven for `@2`.

## Header

- `inputs`: every file the checks read, hashed before the checks ran:
  - the pipeline YAML, `<name>.yaml` or `<name>.yml`, always first and as a
    bare file name. `hash --check` reports a test report whose first input is
    anything else (or that has no inputs) as not ready.
  - each resources file passed to lint or the tests: `<name>.resources.yaml`,
    or a resources file shared with other pipelines, recorded relative to
    the report's folder (for example `../resources.yaml`)
  - each `.blobl` file the pipeline loads, such as `<name>.<label>.blobl`
    loaded with `from "./pipes/<name>.<label>.blobl"`, recorded relative to
    the report's folder (`<name>.<label>.blobl`)
  - the design note `<name>.design.md`, when the Design check ran (it wrote
    rows)

  The `.env` or `.env.example` file, the test cases file and the samples file
  are not inputs: rpcn-test writes the last two itself.
- `rpcn_version`: the binary the checks ran on.

When any input changes, `hash --check` reports the report as not ready, so a
report can never vouch for a pipeline it did not test.

## Status

- `draft` while the checks run, or when a check could not run to the end.
- `ready` once every section below is filled in, from one run against the
  inputs as hashed. A `ready` report can still have the verdict `fail`.
- `superseded` is not used by rpcn-test: it rewrites the report on each run.

## Sections

The body has exactly these seven `##` sections, with these headings, in this
order. A section whose check did not run holds `Not run.` and one line saying
why (for example `Not run: no design note.`).

1. **Summary**: the line `**Verdict:** pass` or `**Verdict:** fail`, then one
   line per check with its result. The verdict is `pass` only when Lint has 0
   errors, no Bloblang sample or unit test failed, the Dry run did not fail,
   and Design check has no `mismatch`. A check that did not run does not fail
   the verdict.
2. **Lint**: the `rpcn_check.py lint` result. A line `0 errors.`, or a table
   of its `errors` in the order the script gives them, with columns `file`,
   `line`, `column`, `message` (an empty cell for `null`).
3. **Bloblang samples**: one row per sample run with `rpcn_check.py blobl`:
   `mapping` (the processor label, its config path such as
   `pipeline.processors.0`, or the `.blobl` file; rpcn-test writes the
   `.blobl` file name, because it samples only `.blobl` files, each against
   `<name>.samples.json` in `samples-format.md`), `sample` (the sample's
   name and its input), `expected`, `actual`, `result` (`pass` or `fail`).
   `expected` and `actual` may also be the value `deleted`, for a message
   the mapping deletes. A mapping that didn't run (it does not parse, or
   its samples file stays invalid) is one `fail` row, with empty `sample`
   and `expected` and the error as `actual`. A pipeline that loads no
   `.blobl` file has `Not run: no .blobl file.`
4. **Dry run**: the pipeline's `pipeline.processors` run once with
   `rpcn_check.py run --bounded`, on a fixed set of messages fed through
   stdin in place of its input, with its output going to stdout in place of
   its sink. Its first line is `Result: passed` or `Result: failed`, then:
   - **Skipped** (only when there is something to name): one line
     `Skipped: <what>.` listing what the bounded run replaced and so did not
     run: `input.processors`, `output.processors`, and a `switch`,
     `fallback` or `broker` output (such as
     `Skipped: output.processors, the fallback output.`).
   - **Input messages:** exactly the `--input` file the run used, one
     message per line: a fenced `json` block when every line is JSON,
     else a fenced `text` block with the lines verbatim.
   - **Outputs:** `data.outputs`, one per line in the order printed, in a
     fenced `json` block (or `text`, by the same rule), or `None.` when
     there are none.
   - **Errors** (only when failed): a table with columns `path` (the
     processor's config path, such as `root.pipeline.processors.0`; empty
     when `rpcn_check` gives none), `message` (the error) and `input` (the
     failing message, from `runtime_errors[].input`). A timeout is a row
     with an empty `path` and `input` and the message
     `run timed out after <s>s`, after any rows for errors before it.

   A message fails only when it reaches the output still errored: an
   error that a later `catch` handles (DLQ routing) is not a failure, nor
   is one routed to the failure path when the top-level output is a
   `switch` whose first case's `check` is `errored()` and at least one
   message reaches Outputs: those rows go under **Routed to the failure
   path:**, a table with the Errors columns, after Outputs. The
   section holds `Not run: lint failed.` when lint has errors, and
   `Not run: needs <component>` when a processor or resource calls an
   outside service (such as `http_client`, a `redis` cache or `sql`). A
   failed dry run makes the verdict `fail`; a dry run that did not run does
   not. The Summary line is `Dry run: passed` or
   `Dry run: failed (<n> errors)`, either followed by `, <r> routed` when
   <r> messages were routed, or `Dry run: not run` for any `Not run`.
5. **Unit tests**: the test cases file `<name>_benthos_test.yaml` beside the
   pipeline, run with `rpk connect test` through `rpcn_check.py test
   [--resources <res>] <name>.yaml`: `--resources` with the same resources
   file as lint when there is one, and no other flag, so the developer's own
   `rpk connect test [--resources <res>] <name>.yaml` runs the same cases.
   rpcn-test writes the file when there is none, and runs an existing one as
   it is, but for a fault in the file itself, which it fixes and re-runs
   (Proposed changes). The section is the line
   `` `<name>_benthos_test.yaml`: <p> passed, <f> failed. ``, where `<f>` is
   the number of failing cases and `<p>` the cases in the file less `<f>`
   (never below 0: a file with no cases is `0 passed, 1 failed`), then the
   line `` Run with `rpk connect test [--resources <res>] <name>.yaml`. ``
   naming the command as run. When any case failed, a table follows with
   columns `case` (its name), `line` (its line in the test file; empty for
   `null`) and `message` (the first line of its message). A target that
   failed to start (any failure with no failing case, such as
   `Failed to execute test target` or a test file the binary can't parse)
   is one row with an empty `case` and `line` and the error as `message`,
   and counts every case as failed (at least 1). The section holds
   `Not run: lint failed.` when lint has errors,
   `Not run: intent unclear.` when nothing says what the output should be,
   and `Not run: <message>` when `rpcn_check` could not run the test at all
   (exit 2). The Summary line is `Unit tests: <p> passed, <f> failed`, or
   `Unit tests: not run` for any `Not run`. A failed case or a target that
   failed to start makes the verdict `fail`.
6. **Design check**: the pipeline (and its resources file) against the
   design note's Error handling, Delivery and ordering, and Idempotency
   (AD-7), read from the YAML: it never runs the pipeline, and it runs even
   when lint has errors. It uses the note only when the note is ready:
   `hash --check` reports it ready and it passes the Readiness list in
   `design-format.md`. The note is an input only when the Design check ran
   (it wrote rows), never with a `Not run` line. One row per section, in
   that order: `section`, `finding`, `result`. `result` is one of:
   - `ok`: the pipeline does what the section says
   - `mismatch`: it does not, and no unresolved Deviations row covers it
   - `deviation-recorded`: it does not, and an unresolved Deviations row
     covers it (the row's `what` goes in `finding`)

   A Deviations row covers a departure only when its `section` is the
   section's heading and it says `resolved: no`; a `resolved: yes` row
   covers nothing. A section that asks for nothing the pipeline can be
   checked against (`None.`, or a job of the outside service, such as the
   API deduplicating) is `ok`, and its `finding` says why. When a section
   has several findings, `finding` names them all and the worst result
   wins: `mismatch`, then `deviation-recorded`, then `ok`. The section holds
   `Not run: no design note.` when there is no `<name>.design.md`,
   `Not run: design note not ready (<reason>).` when there is one that is
   not ready (draft, stale, malformed, or a `[blocking]` open decision), and
   `Not run: the pipeline does not parse.` when the YAML does not parse. The
   Summary line is
   `Design check: <o> ok, <d> deviation-recorded, <m> mismatch`, or
   `Design check: not run` for any `Not run`. A `mismatch` makes the verdict
   `fail`; a `deviation-recorded` row does not.
7. **Proposed changes**: rpcn-test never edits the pipeline (AD-6). Each
   failed check (lint, samples, dry run, unit tests, Design check) gets one
   numbered item per cause:
   - a title line saying what changes, naming the check;
   - a cause line, `Cause: <why it failed>`;
   - a fenced `diff` block in unified format against the file to change
     (`--- a/<file>`, `+++ b/<file>`, relative to the report's folder).

   rpcn-test checks each diff on a copy against the check that failed. A
   diff that still fails after two revisions, or that can't be checked, ends
   its title with `(unverified)`. A diff to the pipeline, a resources file or
   a `.blobl` is for rpcn-author to apply. A fix to a file rpcn-test owns
   (`<name>.samples.json`, `<name>_benthos_test.yaml`) is one rpcn-test
   already applied and re-ran: its title ends with `(applied by rpcn-test)`,
   the diff shows what it changed, and the check's section shows the re-run.
   Write `None.` when there are none.

## Readiness list

After `rpcn_check.py hash --check <name>.test-report.md` reports
`ready: true`, every reader checks:

- [ ] The seven sections are present, with the headings above, in order
      (six for `test-report@1`, without Dry run).
- [ ] Summary has a `**Verdict:**` line of `pass` or `fail`.
- [ ] Every section that did not run says `Not run` and why.
- [ ] `inputs` lists every `.blobl` file the pipeline loads.
- [ ] `inputs` lists the design note when Design check ran. (That the
      pipeline file comes first is checked by `hash --check`.)

A reader that needs the pipeline itself to be ready (AD-6: rpcn-scale,
rpcn-deploy) uses it only when the same `hash --check` reports
`pipeline_ready: true`: the report is ready, its `<name>.yaml` (or
`<name>.yml`) input hash matches, and its verdict is `pass` (`data.verdict`). It also checks:

- [ ] Lint ran.

rpcn-author reads a `ready` report with either verdict, to apply its
Proposed changes. If any item a reader needs fails, it treats the report, and
so the pipeline, as not ready.

## Example

The pipeline the example report tested:

<!-- example-file: orders.yaml -->
```yaml
input:
  redpanda:
    seed_brokers: [ "${REDPANDA_BROKERS}" ]
    topics: [ orders ]
    consumer_group: orders-to-http

pipeline:
  processors:
    - mapping: |
        root = this
        root.total_cents = (this.total * 100).round()

output:
  fallback:
    - http_client:
        url: "${ORDERS_API_URL}"
        verb: POST
        max_in_flight: 8
        retries: 3
    - redpanda:
        seed_brokers: [ "${REDPANDA_BROKERS}" ]
        topic: orders.dlq
```

Its design note is the example in `design-format.md`. Its input and output
are replaced by stdin and stdout for the dry run, so it needs no broker or
API. Its one mapping is inline, so it has no samples; `samples-format.md` has a pipeline that loads
a `.blobl` file. A failing row for the first sample of that example, with
`* 10` in place of `* 100` in the mapping, looks like this:

```markdown
| mapping | sample | expected | actual | result |
|---|---|---|---|---|
| `orders.enrich.blobl` | `small order is normal priority` `{"currency":"usd","id":"o1","total":12.5}` | `{"currency":"USD","id":"o1","priority":"normal","total":12.5,"total_cents":1250}` | `{"currency":"USD","id":"o1","priority":"normal","total":12.5,"total_cents":125}` | `fail` |
```

The report:

<!-- The two sha256 values are the real hashes of the example orders.yaml above and of the
     example orders.design.md in design-format.md; the rpcn_check tests check them. -->
<!-- example-file: orders.test-report.md -->
````markdown
---
artifact: test-report
format: test-report@2
pipeline: orders
status: ready
produced_by: rpcn-test@0.1.0
rpcn_version: 4.115.0
inputs:
  - file: orders.yaml
    sha256: 77c752d3d897336753043dd647d081da3caae2669b3c6bc7169fa80b44729e56
  - file: orders.design.md
    sha256: 7be7ffdd17c1b56532c029f0298782c1ff43eb3be2ea32b5d9348d7279a1fa3b
updated: 2026-10-23
---

# orders: test report

## Summary

**Verdict:** pass

- Lint: 0 errors
- Bloblang samples: not run
- Dry run: passed
- Unit tests: 3 passed, 0 failed
- Design check: 2 ok, 1 deviation-recorded, 0 mismatch
- Proposed changes: 1

## Lint

0 errors.

## Bloblang samples

Not run: no .blobl file.

## Dry run

Result: passed

**Input messages:**

```json
{"id":"o1","total":12.5}
{"id":"o2","total":150}
```

**Outputs:**

```json
{"id":"o1","total":12.5,"total_cents":1250}
{"id":"o2","total":150,"total_cents":15000}
```

## Unit tests

`orders_benthos_test.yaml`: 3 passed, 0 failed.
Run with `rpk connect test orders.yaml`.

## Design check

| section | finding | result |
|---|---|---|
| Error handling | Retries 3 times, then `fallback` to `orders.dlq` | ok |
| Delivery and ordering | The HTTP output uses `max_in_flight: 8`, so posts can arrive out of order | deviation-recorded |
| Idempotency | Every message keeps `id`, which the API deduplicates on | ok |

## Proposed changes

1. Key DLQ messages by `customer_id` (Design check: Delivery and ordering).
   Cause: the DLQ output has no `key`, so a replay from `orders.dlq`
   spreads a customer's orders over partitions and loses their order.

```diff
--- a/orders.yaml
+++ b/orders.yaml
@@ -20,3 +20,4 @@
     - redpanda:
         seed_brokers: [ "${REDPANDA_BROKERS}" ]
         topic: orders.dlq
+        key: ${! json("customer_id") }
```
````
