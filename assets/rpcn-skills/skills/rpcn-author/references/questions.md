# Before writing: required fields and questions

Read this before Step 5 writes any file, in every run.

## Required fields

A field the processing needs is required, whether the request says so or
only implies it. "Needs" means a step uses its value: it lowercases,
parses, computes from, routes on or looks it up. "Lowercase each event's
email" makes `email` required.

A message missing a required field must fail processing, or come out with
that field absent, so the request's failure path can take it. It never
passes with a made-up value:

- Call the method on the field itself: `root.email = this.email.lowercase()`
  fails the message when `email` is missing.
- Never turn the missing value into a string, number or default first:
  `this.email.string()` gives the string `"null"` with no error, so
  `this.email.string().lowercase()` passes the message on as `"null"`.
  The same goes for a default such as `.or("")`, or a `catch` that fills
  the field in.
- Use a default only when the request asks for one.
- Send failed messages where the request says (such as a dead-letter
  topic). A message whose error is not handled is still `errored()` in
  the output's processors. When the request names no failure path, that
  is a question (below).
- A payload that may not parse fails, never deletes: start the mapping
  with `root = content().parse_json()` (it fails on non-JSON), then set
  each changed field by assignment, such as
  `root.email = this.email.lowercase()`. A `match` arm testing
  `this.email` that gives `deleted()` silently deletes a non-JSON payload.
- On the failure path, set the error metadata with a `mutation`
  (`meta error = error()`), never a `mapping` with `root = this`: on a
  non-JSON payload that mapping fails and the metadata is lost.

These facts are proved on 4.100.0 and 4.117.0: the `.lowercase()` and
`.string()` behaviour by `RealBinaryCommandsTest.test_run_deleted_root_and_missing_field`,
and `errored()` by `test_run_bounded` and `test_run` (the processor error
handling row), the non-JSON payload by `test_pattern_non_json_deleted_by_match_failed_by_parse_json`
and the failure-path metadata by `test_pattern_dlq_metadata_with_mutation_not_mapping`,
all in `SOURCES.md`.

## One round of questions

After Steps 2 to 4, and before writing any file, gather every question in
one message:

- **Behaviour gaps** the request (and a ready design note) leaves open:
  - whether a field the pipeline reads but does not need is required,
    such as a field it only passes through or copies;
  - where a message that fails processing goes, when the request doesn't
    say.
- **The asks the skill already has:** the pipeline file exists (Step 2);
  a resources file or `.blobl` file it would write exists
  (`pipeline-files.md`); or no listed component clearly fits (Step 4).
  Decide every file name before the round, so each of these is known.

Ask only about choices that change what the pipeline does. Never ask what
the binary (Steps 3 and 4), a ready design note or the request already
answers. With nothing to ask, write without a question.

Asking (interactive):

- Ask in a plain reply, one numbered item per question (gaps and asks
  alike), each followed by `My pick: <the answer you would use>`.
- Then stop: write no file, run no lint, and end the reply with the
  questions.
- When the host offers a question tool (`AskUserQuestion`), ask the round
  with it instead: at most 4 questions per call (more calls in the same
  round if there are more), each with a header of at most 12 characters,
  2 to 4 options with your pick first and labelled `(My pick)`, each
  with a one-line description, single choice. Read each answer, a chosen
  option or free text, as you would a typed reply, under the rules
  below: one left open or answered "go ahead" takes your pick, named as
  an assumption, but an existing file is still never written over, and
  only a name the user gives is used. Don't stop: apply the answers and
  write. Where no question tool is offered (a subagent, `claude -p`), use
  the numbered list and stop, as above.
- One round only. After the answer, write. For a question the user leaves
  open, or answers "go ahead", use your pick and name it in the reply as an
  assumption.
- An existing file is still never written over: use a new name only if
  the user gives one. With an existing pipeline, write nothing at all
  (no resources, `.blobl` or `.env.example` file) until the answer.

## Headless

Never ask. Use each pick, write the files, and put one line per pick in
`open_questions`, the question in brackets, such as `Assumed: a message
without referrer passes (is referrer required?)` or `Assumed: a failed
message is logged and dropped (failure path: where does it go?)`. These
picks never block: the run ends `complete`. These still end `blocked`, as
before, with nothing written:
an existing pipeline (Step 2 stops there), an existing resources or
`.blobl` file, and no listed component that fits (never write one that
doesn't), as `status-block.md` says.
