# Design note format, `design@1`

The design note `<name>.design.md` is the contract between rpcn-design and
rpcn-author (AD-7). It sits beside `<name>.yaml` in the developer's project.
Its header follows `handoff-header.md`, with:

```yaml
artifact: design
format: design@1
```

A breaking change to this format (a section renamed, removed or reordered, a
Deviations column changed) bumps the major to `design@2`. Readers reject a
major they do not know, through `rpcn_check.py hash --check`.

## Who writes what

| Who | May change |
|---|---|
| rpcn-design | Everything, except that it never deletes a Deviations row |
| rpcn-author | Adds Deviations rows and updates `updated`. Nothing else: not the other sections, not `status`, not `inputs` |
| Everyone else | Nothing. Test, Scale and other readers only read the note |

When rpcn-design rewrites the note, it keeps every Deviations row. A row the
rewrite absorbs (the design now says what the pipeline does) is marked
`resolved: yes`, never removed.

## Header

- `inputs`: the design note has no upstream hand-off files. Write `inputs: []`,
  unless Design worked from a file in the project (for example a requirements
  file), in which case list it with its hash.
- `rpcn_version`: the binary that `rpcn_check.py fields` ran against.

Adding a Deviations row changes the note's bytes, so every hand-off that
lists the note in its `inputs` (for example `<name>.test-report.md`) becomes
stale. That is intended: the test check must see the new row.

## Sections

The body has exactly these eleven `##` sections, with these headings, in this
order. A section with nothing to say holds `None.` rather than being left out.

1. **Purpose**: what the pipeline is for, in two or three sentences.
2. **Inputs**: each source: system, topic or endpoint, message shape, expected
   rate.
3. **Outputs**: each sink: system, topic or endpoint, message shape.
4. **Components**: a table of every component the pipeline uses, with
   columns `kind`, `component`, `role`. `kind` is the `rpcn_check.py fields`
   kind (`input`, `output`, `processor`, `cache`, `rate_limit`, `buffer`,
   `metrics`, `tracer`). Every row is checked with `rpcn_check.py fields`
   before the note is `ready`.
5. **Error handling**: what happens to a message that fails: DLQ, retries,
   fallback, drop. Name the DLQ destination.
6. **Delivery and ordering**: delivery guarantee (at-least-once, at-most-once)
   and what ordering must hold (per key, per partition, none).
7. **Idempotency**: how a redelivered message is made harmless, or why it
   does not need to be.
8. **Batching**: batch size, period and where batching happens, or `None.`
9. **Throughput expectations**: expected and peak rates, message size,
   latency target. rpcn-scale reads this section when present.
10. **Open decisions**: one bullet per open question, starting with
    `[blocking]` or `[non-blocking]`. `[blocking]` means Author cannot write
    the pipeline until it is answered.
11. **Deviations**: the table below.

### Deviations table

| Column | Meaning |
|---|---|
| `section` | The design section the pipeline departs from, by its heading (for example `Error handling`) |
| `what` | What the pipeline does instead |
| `why` | The reason |
| `date` | ISO date the row was added |
| `resolved` | `no` when added; `yes` once Design absorbs it into the design |

Rows are append-only. With no rows, the section holds the header row and
separator only, so Author can append to it.

rpcn-test checks the pipeline against Error handling, Delivery and ordering,
and Idempotency. It reports a departure as `deviation-recorded` when a row
with that `section` and `resolved: no` covers it, and as `mismatch`
otherwise (AD-7).

## Ready rule

rpcn-design sets `status: ready` when Open decisions holds no `[blocking]`
item and every Components row passed `rpcn_check.py fields`. Until then the
note stays `draft`.

## Readiness list

After `rpcn_check.py hash --check <name>.design.md` reports `ready: true`, the
reader checks:

- [ ] The eleven sections are present, with the headings above, in order.
- [ ] Open decisions holds no `[blocking]` item.
- [ ] Components is a table with `kind`, `component`, `role`, and lists every
      component named in Inputs, Outputs and Error handling.
- [ ] Error handling names a destination or action for failed messages.
- [ ] Deviations is a table with the five columns, in order.

If any item fails, the reader treats the note as not ready (AD-6).

## Example

<!-- test-report-format.md records this example's sha256; change both together
     (the rpcn_check tests check them). -->
<!-- example-file: orders.design.md -->
````markdown
---
artifact: design
format: design@1
pipeline: orders
status: ready
produced_by: rpcn-design@0.1.0
rpcn_version: 4.115.0
inputs: []
updated: 2026-10-23
---

# orders: design

## Purpose

Read new orders from Redpanda, add the total in cents, and post each order to
the fulfilment API.

## Inputs

- Redpanda topic `orders`, JSON objects with `id`, `customer_id` and `total`
  (a decimal amount). About 50 messages per second.

## Outputs

- HTTP `POST` to `${ORDERS_API_URL}`, one JSON order per request, with
  `total_cents` added.

## Components

| kind | component | role |
|---|---|---|
| input | redpanda | Consume `orders` in consumer group `orders-to-http` |
| processor | mapping | Add `total_cents` |
| output | fallback | Try the API, then the DLQ |
| output | http_client | Post to the fulfilment API |
| output | redpanda | DLQ topic `orders.dlq` |

## Error handling

The HTTP call retries 3 times. A message that still fails goes to the
Redpanda topic `orders.dlq` with its original payload.

## Delivery and ordering

At-least-once. Orders for the same `customer_id` reach the API in the order
they were produced.

## Idempotency

The fulfilment API deduplicates on `id`, so a redelivered order is harmless.

## Batching

None.

## Throughput expectations

50 messages per second, peaks of 200. Messages under 2 KB. Each order
reaches the API within 5 seconds.

## Open decisions

- [non-blocking] Should the DLQ keep the HTTP error message as metadata?

## Deviations

| section | what | why | date | resolved |
|---|---|---|---|---|
| Delivery and ordering | The HTTP output uses `max_in_flight: 8`, so posts can arrive out of order | The API needs parallel requests to keep up at peak | 2026-10-23 | no |
````
