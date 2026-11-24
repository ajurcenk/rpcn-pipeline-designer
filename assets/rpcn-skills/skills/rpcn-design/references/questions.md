# Before writing: what only the user can decide

Read this before Step 5 writes the note, in every run. An existing note
that the request doesn't ask to change stops at Step 2: headless with no
question; interactive with one question, whether to update `<note>` (by
its path), and nothing written. With a question tool (see Rounds), ask
it as one question with two options, update it or leave it: "leave it"
ends the run with nothing written, and "update it" goes straight on to
the re-run. That question is not one of the two rounds below. A yes to
it is a request to change the note: a re-run (`rerun.md`) with the
original request as the change, which asks only what the change leaves
open.

## The four asks

Four choices change the pipeline and have no safe default. Ask each one
the request doesn't already answer, with the pick you would use:

1. **The failure target:** where a message goes that the sink fails to
   take (and one that fails processing, when the request processes).
   Pick: the `patterns.md` pattern 1 default (`<input topic>.dlq` on the
   input's system, else a file `<name>.dlq.jsonl`).
2. **The delivery guarantee:** at-least-once (failures retried or kept) or
   at-most-once (failures dropped, so no DLQ). Pick: at-least-once.
3. **Ordering:** must order hold, per key (which one) or overall? Pick: no
   ordering.
4. **The idempotency key:** can messages repeat, and if so which field
   identifies one? Pick: no dedupe.

The request answers an ask when it says what it needs: a named DLQ, topic,
table or file answers the failure target, and so does a DLQ asked for
without a name ("a dead-letter topic": its name is the pattern 1 default,
a `[non-blocking]` pick); a DLQ or retries also answer the
delivery guarantee (at-least-once); "drop" or "log and drop" answers both
(at-most-once, no DLQ). A request that says a choice isn't decided yet
("we haven't decided where failed messages go") has left it open: don't
ask it (see "A choice left open"). The same inferences hold for an answer
given in a round (a named DLQ answers delivery; "at-most-once" answers
the failure target): only an ask nothing settles is left open.

Ask nothing else. Every other choice (a retry count, a cache, a batch
size, a file name) gets its default from `patterns.md` or
`note-writing.md`. Never ask what the binary (Steps 3 and 4) or the
request already answers. A part of the flow that no listed component fits
is not a question: it is a `[blocking]` item (Step 4). With nothing to
ask, write without a question.

## Rounds (interactive)

At most two short rounds, after Steps 1 to 4 and before Step 5 writes:

- **Round 1** holds every open ask in one plain reply, one numbered item
  per ask, named by its label (failure target, delivery, ordering,
  duplicates), each followed by `My pick: <the answer you would use>`:

  ```
  1. Failure target: where should a message go when the API fails to take it? My pick: the Redpanda topic `parcels.dlq`.
  2. Delivery: at-least-once (failures retried or kept) or at-most-once (failures dropped)? My pick: at-least-once.
  3. Ordering: must order hold, per parcel or overall? My pick: no ordering.
  4. Duplicates: can events repeat, and if so which field identifies one? My pick: no dedupe.
  ```

  Then stop: write no file, and end the reply with the questions. No
  status block.

  When the host offers a question tool (`AskUserQuestion`), ask round 1
  with it instead, in one call: one question per open ask, its header the
  label (`Failure`, `Delivery`, `Ordering`, `Duplicates`), 2 to 4 options
  with your pick first and labelled `(My pick)`, each with a one-line
  description, single choice. Read each answer, a chosen option or free
  text (an "Other" choice), as you would a typed reply: "After the
  answers" and "A choice left open" apply as written, so a "go ahead" is
  a pick and "not decided" or a skipped ask is left open. Don't stop:
  apply the answers, ask round 2 the same way only if an answer raised a
  new question, then write. Where no question tool is offered (a
  subagent, `claude -p`), use the numbered list and stop, as above.
- **Round 2** only for a new question an answer raised (such as a DLQ on
  a system the request hasn't described), in the same form. Never repeat
  a round 1 question. After round 2, write.

An answer that adds a part (a DLQ output, a `dedupe` and its cache, a
`max_in_flight`) is picked and checked with `list` and `fields` (Steps 3
and 4) before Step 5 writes.

## After the answers (interactive)

- **An answer** settles its choice: write it in its section as if the
  request had said it. It is not an open decision.
- **"Go ahead"**, or a pick the user accepts: write the pick in its
  section, and in Open decisions as `[non-blocking] <the question>?
  Picked: <the pick>.`, the pick in this file's words (`Picked: no
  dedupe.`). The failure target's line is exactly `[non-blocking] Where
  do failed messages go? Picked: <the DLQ> — the request named none.`
  (`patterns.md` pattern 1). The note stays ready. A request that already says to go ahead with your
  picks is that answer for every open ask: ask nothing, and write.

## A choice left open

In both modes. Interactive: the user skips an ask, says it isn't
decided, or the request says so. Headless: nothing in the request settles
the ask (by the inferences in "The four asks"):

- **The failure target or the delivery guarantee** changes components (a
  DLQ output, a `fallback`). Write it as `[blocking] <the question>.` in
  Open decisions, and the note is `draft`. Interactive, name no
  destination; headless, the question may suggest the pattern 1 default
  (`[blocking] Where do failed messages go? (Suggested: <the DLQ>.)`).
  Add no component for it: no DLQ output and no `fallback` row for an
  open failure target. Its section says the choice is open (see Open
  decisions).
- **Ordering or the idempotency key** changes one setting or one
  processor, so the pick is safe to build on: write it as `[non-blocking]
  <the question>? Picked: <the pick>.` in this file's words (`Picked: no
  dedupe.`), use the pick in its section, and the note stays ready.

## Headless

Never ask: the rounds and "After the answers" don't apply. Settle each of
the four asks from the request alone, by the inferences in "The four
asks", then apply "A choice left open" to each one nothing settles: an
open failure target or delivery guarantee is `[blocking]` and the note is
`draft`; ordering or the idempotency key gets its pick as
`[non-blocking]`. Every other choice gets its default. Write the note,
and end with the status block (a `draft` note still ends `complete`).
