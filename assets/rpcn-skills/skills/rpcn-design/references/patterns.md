# Patterns

Read this file before picking components (SKILL.md Steps 3 and 4), and use
it again when writing Error handling, Delivery and ordering, Idempotency and
Batching (`note-writing.md`). Name each pattern the request calls for, and
only those. A section no pattern applies to holds what the request says
about it, else `None.`

Each entry gives:

- **When:** what in the request calls for it.
- **Note:** what its section says.
- **Components:** the rows it adds to Components. Pick and check each one
  with `list` and `fields` (Steps 3 and 4), as for any row.
- **Basis:** the behaviour fact it rests on. "SOURCES: …" is a
  `SOURCES.md` row proved by a test on 4.100.0 and the newest pin; "fields:
  …" is what the binary reports at run time.

Name a field (such as `max_retries`, `batching.count`, `max_in_flight`)
only when Step 4's `fields` output for that component lists it; otherwise
state the value as intent ("retried 3 times", "in batches of 100").
Describe each failure path as intent: where the message goes. State no
behaviour beyond an entry's Basis (such as how a sink's own retry field
adds up with `retry`). Building the chain is rpcn-author's job.

## 1. DLQ for failed writes

- **When:** the sink can fail to take a message (always, unless the
  request says failures are dropped or only logged: then no `fallback` at
  all, not even to a `drop`, as `note-writing.md` says). Use the destination
  the request names (a DLQ, a dead-letter topic, a file). The default DLQ
  is a topic on the input's system when it has topics (`<input
  topic>.dlq`), else a file `<name>.dlq.jsonl`. When nothing settles the
  failure target (`questions.md`), in either mode, write `[blocking]
  Where do failed messages go? (Suggested: <the default DLQ>.)` in Open
  decisions (interactive, with no suggestion), add no `fallback` or DLQ
  row, and the note is `draft`. Two cases keep the default DLQ instead,
  written as `[non-blocking] Where do failed messages go? Picked: <the
  DLQ> — the request named none.`, with the note ready: a request that
  asks for a DLQ but names none ("failed messages go to a dead-letter
  topic"), and an interactive pick the user accepted.
- **Note (Error handling):** the DLQ destination by name, and that a
  message the sink fails to take goes there. Say nothing about what the
  DLQ copy carries (no `fallback_error`, no metadata) unless the request
  asks to keep the error or the reason. Only then, say the DLQ copy
  carries it as `fallback_error` metadata. With a `retry` around the sink
  (pattern 3), the kept error is the `retry`'s own error, not the sink's.
- **Components:** `output | fallback | Try <sink>, then the DLQ`, then a
  row for the sink and one for the DLQ output.
- **Basis:** SOURCES: `fallback` output. When an earlier output fails, the
  message goes to the next one, with `fallback_error` set to the failure's
  error. After a `retry`, `fallback_error` is set to the `retry`'s error.

## 2. DLQ for processing errors

- **When:** the request says messages that fail processing (a mapping, a
  parse, an enrichment) go to a DLQ or somewhere other than the sink. Not
  otherwise.
- **Note (Error handling):** that a message a processor fails on goes to
  the DLQ, with its error, and every other message goes on to the sink.
- **Components:** `output | switch | Send messages that failed processing
  to the DLQ, the rest to <sink>`, plus the DLQ output's row. When pattern 1
  also applies, the switch's other case is the `fallback` chain.
- **Basis:** SOURCES: `switch` on `errored()`. A case whose `check` is
  `errored()` takes a message a processor failed on, and `error()` still
  holds its error.

## 3. Retries

- **When:** the request asks for failed writes to be retried (with a count
  or without: then pick 3 and write the pick as a `[non-blocking]` open
  decision). Not otherwise: then say only that none were asked for, never
  that a write is not retried (a sink's own retry field keeps its default).
- **Note (Error handling):** how many times the sink is retried before the
  message goes on to the DLQ (pattern 1). Name `max_retries: <N>` when
  `fields outputs retry` lists it; otherwise write "retried <N> times".
- **Components:** `output | retry | Retry <sink> up to <N> times`, wrapping
  the sink, inside the `fallback` when pattern 1 applies.
- **Basis:** SOURCES: `retry` then `fallback`. A `retry` output tries its
  output again up to `max_retries` times (1 + `max_retries` attempts), then
  fails, so a surrounding `fallback` takes the message.

## 4. Batching

- **When:** the request asks for batches: a batch size, "in groups of",
  "flush every N messages", or only a period ("flush every 60 s").
- **Note (Batching):** the batch size on the output that batches. When
  `fields` lists `batching.count` for that output, write it as
  `batching.count: <N>`; otherwise write "in batches of <N>" as intent. A
  period, with a size ("or every 60 s") or alone ("flush every 60 s"), is
  written as the request's intent, naming no field for it. When the
  request wants each batch written as one payload (one file or one object
  per batch) and `fields` lists `batching.processors` for that output, say
  an `archive` processor (when `list processors` lists it) with `format:
  lines` (one message per line) or `format: json_array` joins the batch
  into one payload, and give it a Components row. Name no other batch
  processor or `archive` format.
- **Components:** no new row for the batching itself: the batching
  output's role says "in batches of <N>", the same way the Note does.
  `processor | archive | Join each batch into one payload` only when the
  Note names it.
- **Basis:** SOURCES: `batching.count`. A `broker` output's
  `batching.count` delivers messages in groups of that size, and an
  `archive` processor (`format: lines` or `json_array`) in its
  `batching.processors` joins each group into one payload. That another output has the same `batching` block is read
  from its `fields` at run time.

## 5. Idempotency

- **When:** the request says messages may repeat and asks for repeats to
  be dropped, by a key.
- **Note (Idempotency):** the key (such as `event_id`), that the first
  message with a key goes on and a later one with the same key is dropped,
  and the cache that holds the keys seen. For a `memory` cache, say how
  long it keeps a key: the request's window, else a `[non-blocking]` pick
  of the `default_ttl` default that `fields caches memory` reports. Say,
  as intent, that a message missing the key goes to the failure target.
  Add no component for it: pattern 2 applies only by its own When.
- **Note (Delivery and ordering):** a message every output fails after
  `dedupe` recorded its key is dropped as a repeat when it is replayed.
- **Components:** `processor | dedupe | Drop repeats of <key>`, and
  `cache | memory | Keys dedupe has seen, kept <window>`. When the
  request names another cache (such as `redis`) and `list caches` lists
  it, use it instead, and write the request's wish (any window too) as
  intent only, with no claim about how that cache behaves.
- **Basis:** SOURCES: `dedupe`. A `dedupe` processor with a `memory` cache
  drops a message whose key it has already seen. Only `memory` is proved.
  The window's basis is fields: `default_ttl`, the default and description
  `fields caches memory` reports.
  SOURCES: `dedupe` before a failed write: a replayed nacked message is
  dropped as a repeat.

When the request says the sink already handles repeats (such as an API that
deduplicates on `id`), say that, and add no `dedupe`.

## 6. Ordering

- **When:** the request asks for order to hold (per key, per customer, per
  partition, overall).
- **Note (Delivery and ordering):** the order that must hold, as the
  request's intent, in its words ("each customer's orders reach the API in
  the order they were produced"). Then, when `fields` lists `max_in_flight`
  for the output on that path, recommend `max_in_flight: 1`, giving the
  description Step 4 printed for that field as the reason. Say no more
  about order than that description: don't claim the field guarantees it. When `fields`
  lists no `max_in_flight`, write the order as intent only.
- **Components:** no new row. The output's role may say "one at a time".
- **Basis:** fields: `max_in_flight`. The recommendation's basis is the
  description Step 4 printed for that field on that output.

---

Patterns 1 to 5 are adapted, in our own words, from patterns 6, 2, 4, 5
and 9 (in that order) of `redpanda-data/skills`
`skills/connect/references/patterns.md`, at commit `a4562333`, Apache-2.0
(`SOURCES.md`).
