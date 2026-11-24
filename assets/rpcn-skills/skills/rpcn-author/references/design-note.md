# Building from a design note

rpcn-design writes `<name>.design.md`. It is the contract the pipeline is
built to (AD-7). Use it only after Step 2's `hash --check` reported
`data.ready: true`. Its format, and the readiness list, are in
`design-format.md` (in this folder).

rpcn-author may change exactly two things in the note: it appends
Deviations rows, and it sets `updated`. Nothing else: not `status`, not
`inputs`, not another section, not an existing row (design-format.md "Who
writes what").

## 1. Check the readiness list

Read the note and check each item of the readiness list in
`design-format.md`. If an item fails (for example Open decisions holds a
`[blocking]` item), the note is not ready:

- don't use it and don't edit it
- build the pipeline from the request alone, as Steps 3 to 6 say
- say in the reply that the note is not ready, and why (the item that failed)
- in headless mode the run is still `complete`, with that line in
  `open_questions`. A note is never a required input, so a missing or
  not-ready note never blocks (AD-8)

## 2. Build from the note

The note decides the design; the request may add to it or override it.

- **Components:** every Components row goes into the pipeline. Its `kind`
  gives the Step 3 category, in the plural (`input` is `inputs`, `processor`
  is `processors`, `rate_limit` is `rate-limits`). Check each one with
  `list` and `fields`, as Steps 3 and 4 say. A component the binary doesn't
  list blocks, as in Step 4. A close match you pick on `fields` exit 1 is a
  departure (section `Components`).
- **Error handling:** build in what it says: the retries, the fallback, the
  DLQ and its destination, the drop. Use the component fields `fields`
  reports for them (such as `retries` or `max_retries`, and a `fallback`
  output whose last entry is the DLQ).
- **Delivery and ordering:** build in the guarantee and the ordering. For
  example, ordering per key or per partition rules out an output
  `max_in_flight` above 1 on that path.
- **Idempotency:** build in what it says, such as the key a sink
  deduplicates on.
- **Inputs, Outputs, Batching:** use the topics, endpoints and batching
  they name. Addresses and secrets are still `${ENV_VAR}`.

## 3. Record each departure

A departure is a place where the pipeline deliberately does something a
section says otherwise, because the request or the binary forces it: the
request overrides a choice (such as no DLQ), or the binary has no component
or field for it. Something the note doesn't mention is not a departure,
and neither is a component added to carry out what a section already asks
(such as a `reject_errored` or `catch` that sends failed messages to the
note's DLQ): record no row for it.

One choice is one departure, so one row, under the section that makes the
choice: dropping the DLQ is one `Error handling` row, even though the DLQ
also appears in Components and Outputs.

For each departure, append one row to the Deviations table, after its last
row (or after the separator row when it has none):

```markdown
| <section> | <what the pipeline does instead> | <why> | <today, YYYY-MM-DD> | no |
```

- `section` is the heading of the section departed from, exactly, such as
  `Error handling`.
- `what` and `why` are one plain sentence each, with no `|` and no line
  break.
- `resolved` is always `no`.

Use the Edit tool: `old_string` is the table's current last line,
`new_string` is that line, a newline, and the new rows. Then set the
header's `updated:` line to today, in one more Edit. Change nothing else:
no other line, no blank line, no trailing text after the table.

The note's `inputs` is `[]` or lists files other than the note, so it still
passes `hash --check` after the edit. With no departure, don't edit the note
at all: it stays byte-identical.

## 4. Reply

Say the pipeline was built from the note. Name each Deviations row you
added (section, what, why), or say there were none. List the note in
`artifacts` only when you edited it.
