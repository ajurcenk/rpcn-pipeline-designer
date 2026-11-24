# Writing the design note

The note is the contract rpcn-author builds to and rpcn-test checks
against (AD-7). Its format is `design-format.md` (in this folder): exactly
eleven `##` sections, with those headings, in that order. Write it in one
Write call, from the request and the Step 3 and 4 results only. State no
component, field or behaviour that the request, `list` or `fields` did not
give you. A behaviour may also come from a `patterns.md` entry's Basis (its
`SOURCES.md` row).

## Header and title

```markdown
---
artifact: design
format: design@1
pipeline: <name>
status: <ready|draft>
produced_by: rpcn-design@<data.plugin_version from Step 1>
rpcn_version: <binary.version from Step 1>
inputs: []
updated: <today, YYYY-MM-DD>
---

# <name>: design
```

`inputs` stays `[]` for a plain request. When the request names a file in
the project that the design is made from (a requirements file, a sample
message), hash it from the note's folder and copy each pair into `inputs`,
as `handoff-header.md` says ("Writing the hashes"):

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py hash <file>
```

## Sections

1. **Purpose:** what the pipeline is for, in two or three sentences.
2. **Inputs:** each source: system, topic or endpoint, message shape,
   expected rate. Addresses and secrets are named as `${ENV_VAR}`, never
   given a value.
3. **Outputs:** each sink: system, topic or endpoint, message shape. The
   DLQ is an output too.
4. **Components:** a table with columns `kind`, `component`, `role`, one
   row per component, each one Step 4 checked. `kind` is the singular of
   the Step 3 category (`input`, `output`, `processor`, `cache`,
   `rate_limit`, `buffer`, `metrics`, `tracer`). Every component that
   Inputs, Outputs or Error handling names has a row. A role is one short
   phrase, with no `|`.
5. **Error handling:** as below, with `patterns.md` patterns 1 to 3.
6. **Delivery and ordering:** what the request says about the delivery
   guarantee and ordering, with `patterns.md` pattern 6, else `None.`
7. **Idempotency:** what the request says about duplicates and dedupe
   keys, with `patterns.md` pattern 5, else `None.`
8. **Batching:** what the request says about batching, with `patterns.md`
   pattern 4, else `None.` A period with no size is written as intent,
   naming no field.
9. **Throughput expectations:** the rates, message sizes and latency the
   request gives, else `None.`
10. **Open decisions:** one bullet per gap, as below, else `None.`
11. **Deviations:** the header row and separator only, so rpcn-author can
    append to it:

    ```markdown
    | section | what | why | date | resolved |
    |---|---|---|---|---|
    ```

    A re-run instead copies the existing note's rows, as `rerun.md` says.

## Patterns

`patterns.md` (in this folder), read before Step 3, gives each pattern's
Components rows, picked and checked in Steps 3 and 4. For each pattern the
request calls for, and only those, write what its entry's **Note** says in
its section and add its **Components** rows. A pattern the request doesn't
call for stays out: no `retry` without a retry asked for, no `switch`
without processing failures to route, no `dedupe` without repeats to drop,
no batching without a batch size.

## Error handling

Say, in plain sentences, what happens to a message that fails:

- **The DLQ destination**, by name: the system and the topic, table or
  path, such as "the Redpanda topic `orders.dlq`". Use the one the
  request names. When nothing settles the failure target
  (`questions.md`; interactive asks it first), it is `[blocking]` in
  both modes, as `patterns.md` pattern 1 says: no DLQ or `fallback` is
  added, the section says the failure target is open, and the note is
  `draft`. A DLQ asked for without a name, or an interactive pick the
  user accepted, keeps the default DLQ instead, written as a
  `[non-blocking]` open decision, and the note stays ready.
- **The retries:** only when the request asks for them, as `patterns.md`
  pattern 3 says.
- **Where each kind of failure goes,** as intent, in the request's
  words: such as "orders that fail processing or can't be delivered go
  to `orders.dlq`". Failed writes are pattern 1 and processing failures
  pattern 2; name a component only when Components lists it.
- **A drop:** only when the request asks for one. Then the DLQ is
  `None.` for that path, and the section says the message is dropped.

When the request says failures go nowhere (log and drop), write that, and
no DLQ: pattern 1 doesn't apply, so add no `fallback` (not even one to a
`drop` or a `log`). The drop is intent in Error handling; a component for
it is added only when Step 4's `fields` shows one that drops on a failed
write.

## Open decisions

Headless never asks; interactive asks first (`questions.md`). For every
choice still open that changes the design, pick the answer and write it in:

- `[non-blocking] <the question>? Picked: <the pick>.` Use a pick in its
  section as if the request had said it. Headless: each pick also goes in
  the status block's `open_questions` as `Assumed: <pick> (<question>)`.
- `[blocking] <the question>.` only for:
  - a part of the flow that no listed component fits (Step 4);
  - a failure target or delivery guarantee nothing settles, in either
    mode (`questions.md`, "A choice left open"). Then no DLQ or
    `fallback` is added for it.

  The note is then `draft`.

A detail the request leaves out that changes nothing in the pipeline (a
rate, a message size) is not an open decision: leave it out of its
section, or write `None.`

## Before Step 6

Check the note against `design-format.md`'s Readiness list, then run the
`hash --check`.
