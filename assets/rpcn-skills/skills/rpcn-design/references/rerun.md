# Re-running over an existing note

Read this from Step 2 when `<note>` exists and the request asks to change
it: "update", "revise", "re-run the design", or a stated change such as
"the API now takes 8 posts at a time". A plain "design X" over an existing
note is no re-run: Step 2 stops instead (headless `blocked`; interactive
asks whether to update `<note>`, by its path, and writes nothing). That
question is not one of `questions.md`'s two rounds. The user's yes to it
is a request to change the note: a re-run, with the original request as
the change.

A re-run needs Step 2's `hash --check` to exit 0 or 1. An exit 2 other
than not-found means the header is bad: stop as Step 1 says, write nothing
(headless: `blocked`, `reason` the first error). Never fix the header by
rewriting the note.

`design-format.md` ("Who writes what"): rpcn-design may rewrite the note,
but it never deletes a Deviations row. A row the rewrite absorbs is marked
`resolved: yes`.

## The starting point

Read `<note>` with Read. It is the request's starting point: every section
keeps what it says unless the request changes it, and where they differ the
request wins. An answer the note already gives (the failure target, the
delivery guarantee, ordering, the idempotency key) counts as given by the
request, so `questions.md` asks only what the change leaves open. Its rules
for headless and interactive runs apply to the rewrite as to a new note.

## Steps 3 to 6

- **Steps 3 and 4:** run `list` and `fields` for every component the
  rewritten Components table names, kept rows included. A row that no
  longer passes is handled as Step 4 says.
- **Step 5:** write the whole note in one Write call, as `note-writing.md`
  says, except the header and Deviations below. An open decision the
  request answers leaves Open decisions; one it leaves open stays.
- **Step 6:** check with `hash --check` as for a new note.

## Header

- `status`: by the Ready rule, as for a new note.
- `produced_by` and `rpcn_version`: from Step 1.
- `updated`: today.
- `inputs`: as `handoff-header.md` says. Keep each file the note lists,
  with its hash taken again ("Writing the hashes"), and add a file the
  request names that the design is now made from. `inputs: []` stays `[]`
  for a plain request.
- `artifact`, `format` and `pipeline`: unchanged.

## Deviations

Copy every row of the old table in its original order, each cell as it
was. Only `resolved` may change, and only from `no` to `yes`:

- **`yes`** when the rewritten section the row names (`section`) now says
  what the row's `what` says the pipeline does. For example, a row
  `Delivery and ordering | The HTTP output uses max_in_flight: 8, so posts
  can arrive out of order | ...` is absorbed when the request says order
  no longer matters and posts may go 8 at a time, and Delivery and
  ordering now says so.
- **Unchanged** otherwise: a row whose section the request doesn't touch,
  or whose `what` the rewrite still departs from, stays `no`. A row
  already `yes` stays `yes`.

Never delete, reorder or reword a row, and never add one (rpcn-author adds
rows). With no rows, keep the header row and separator only.

## The reply

Besides what Step 6 asks for, name each row marked `resolved: yes` in this
run, and each row kept open (`no`), by its `section` and `what`. Headless:
the status block's `artifacts` lists the note.
