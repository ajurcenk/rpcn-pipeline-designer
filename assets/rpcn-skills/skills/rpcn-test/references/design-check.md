# Design check

Step 2 uses section 1 to decide whether the note counts. Do the rest once
per pipeline, after the unit tests. The Design check reads
the pipeline (and `<res>`) against three sections of its design note:
Error handling, Delivery and ordering, and Idempotency (AD-7). The note's
format is `design-format.md` (in this folder).

The note is read only ("Who writes what" in `design-format.md`): never edit
it, never write or edit a Deviations row, and never suggest that rpcn-test
does. Recording a departure is rpcn-author's job. Never edit the pipeline
either (AD-6), and never run it against an outside service for this check:
it is a reading of the YAML.

## 1. When the note counts

Step 2's `hash --check <dir>/<name>.design.md` decides:

- **Exit 2, file not found:** no note. The section is
  `Not run: no design note.` and the note is not an input.
- **Exit 0, `data.ready: true`:** read the note and check each item of the
  Readiness list in `design-format.md`. All pass: the note is ready, and it
  is the last `hash` input. It is recorded in the report's `inputs` as
  `<name>.design.md` (bare, relative to the report's folder) only when the
  Design check ran (it wrote rows); with any `Not run` line it is not.
- **Anything else** (draft, stale, malformed, or a Readiness item fails,
  such as a `[blocking]` open decision): not ready. The section is
  `Not run: design note not ready (<reason>).`, the note is not an input,
  and a line saying why goes in `open_questions` (headless) or the reply. It
  never makes the run `blocked`.

When the note counts, the check runs even when lint has errors: it reads
the YAML, not the binary. Only when the YAML does not parse at all (a
`yaml: line <n>: …` lint error) is the section
`Not run: the pipeline does not parse.`, and the note is not an input.

## 2. What to look for

Read each section's text, then look for what it asks for in the pipeline
and `<res>`, at any depth (inside `fallback`, `switch`, `broker`, `catch`,
`try`, `branch` and the like):

- **Error handling:** the retries and their count (`retries`,
  `max_retries`, a `retry` output or processor), the routing of a failed
  message (`fallback`, `catch`, a `switch` on `errored()`), the DLQ
  destination it names (the topic, table or path, on the last `fallback`
  entry or the error branch), and any drop (`drop`, `drop_on`, a `catch`
  that deletes the message). A message the section says goes to a DLQ that
  the pipeline drops or logs and drops is a departure.
- **Delivery and ordering:** an ordering requirement (per key, per
  partition) against an output `max_in_flight` above 1, a `broker` or
  parallel output, batching that reorders, or `parallel` and similar
  processors on that path. A drop the Error handling section rules out is
  counted there, not here.
- **Idempotency:** the dedupe key it names (such as `id`) kept on every
  output path: no mapping on any path removes or rewrites it, and a key or
  ID field it says the sink uses (`key`, `id`, a header) is set from it.

Count each departure once, under the section that makes the choice (as
rpcn-author records it): a missing DLQ is an `Error handling` finding only.

A section that asks for nothing the pipeline can be checked against is
`ok`, and its finding says why: `None.`, "no ordering requirement", or a
job of the outside service (such as "the fulfilment API deduplicates on
`id`", where the pipeline only has to keep `id`, so check that).

## 3. One row per section

Write one row per section, in the note's order (Error handling, Delivery
and ordering, Idempotency): `section` (the heading), `finding` (what the
pipeline does, in one or two short sentences, naming the fields, such as
"Retries 3 times, then `fallback` to `orders.dlq`"), `result`.

For each departure, read the note's Deviations table:

- a row with that `section` (exactly the heading) and `resolved: no` that
  describes this departure covers it: `deviation-recorded`, with the row's
  `what`, word for word, in `finding`
- no such row, or only `resolved: yes` rows: `mismatch`

When a section has several findings, `finding` names them all and the
worst result wins: `mismatch`, then `deviation-recorded`, then `ok`.

The Summary line is
`Design check: <o> ok, <d> deviation-recorded, <m> mismatch` (the rows of
each result), or `Design check: not run` for any `Not run`.

A `mismatch` makes the verdict `fail` and `checks.tests` `fail`. A
`deviation-recorded` row affects neither.

## 4. A fix for each mismatch

Each `mismatch` gets one Proposed changes item:

- its title names the check and the section, such as "Send failed orders
  to `orders.dlq` after the retries (Design check: Error handling)"
- one line, with the words `Deviations row`, saying that keeping the
  departure instead means having rpcn-author record a Deviations row for it
  in the note
- one line: if the design should change, update the note with
  rpcn-design, then re-run rpcn-test
- a `diff` block against the pipeline (or `<res>`) that makes it do what
  the section says

Its cause line says what the section asks for and what the pipeline does
instead. Write the whole fixed pipeline (with every lint fix too) to the
temp folder and check it as `fix-check.md` says, in two parts:

1. Lint the copy. A fix to `<res>` writes the fixed `<res>` copy, under
   the same file name, to the same temp folder, and that lint passes
   `--resources` set to that copy.
2. Read the copy against the section as sections 2 and 3 do.

It is verified only when lint passes and the row would now be `ok`;
otherwise `(unverified)` and revisions are as `fix-check.md` says.
