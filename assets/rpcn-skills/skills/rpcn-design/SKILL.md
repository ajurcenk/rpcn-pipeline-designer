---
name: rpcn-design
description: 'Designs Redpanda Connect pipelines before any YAML is written. From a plain request, writes a <name>.design.md design note (inputs, outputs, components the installed binary reports, error handling, DLQ, retries, ordering, idempotency, batching, open decisions) that rpcn-author builds from and rpcn-test checks against. Use when the user says "design a Redpanda Connect pipeline", "design a pipeline that reads from … and writes to …", "write a design note for my pipeline", "plan my Redpanda Connect pipeline", "how should this data flow handle failures", "where should failed messages go", "update my design note" or "rpcn-design", and when the user wants a pipeline''s components, error handling or DLQ decided before it is built, or an existing note updated. Not for writing the pipeline YAML (use rpcn-author), or linting and testing it (use rpcn-test), or deploying it.'
compatibility: "Requires rpk with Redpanda Connect >= 4.100.0, and uv."
license: Apache-2.0
metadata:
  plugin-version: "0.1.0"
---

# rpcn-design

Writes one file, the design note `<dir>/<name>.design.md`, in `design@1`
(`references/design-format.md`, header as `references/handoff-header.md`
says). Never write pipeline YAML or any other file.

Run one `uv run …/rpcn_check.py` command per Bash call: no `cd`, `&&`, `;`,
variables, `cat` or heredocs. Use Read and Write for files.

**Headless** when the prompt says unattended, headless or
non-interactive, or a script reports `data.headless: true`: never ask,
and end with the status block. Else ask first (Step 5).

## Step 1: Check the binary

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py binary
```

Unexpanded `${CLAUDE_SKILL_DIR}`: use this folder's absolute path, here
and below.

Calls print JSON (`ok`, `binary`, `errors`, `data`). Keep
`binary.version` and `data.plugin_version` for the header. **Exit 2** in
any step (but Step 2's and Step 6's checks) means stop: write nothing, show each
`errors[].message` (headless: `blocked`).

## Step 2: Name the note

`<name>` comes from the file the user names (`<name>.yaml`, `.yml` or
`.design.md`) or path with no extension (`flows/order_relay`), else a
short snake_case name for the flow. `<dir>/` is that path's folder as
given (`flows/`), or nothing (project root).
`<note>` is `<dir>/<name>.design.md`.

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py hash --check <note>
```

- Exit 2 with a not-found error: no note yet, go on.
- Other exit 2: stop as Step 1 says.
- Else a note exists. A request to change it (update, revise, re-run,
  a stated change) follows `references/rerun.md`. Else write nothing:
  headless `blocked`; interactive asks only whether to update `<note>`.

## Step 3: Pick components

First read `references/patterns.md`: each pattern the request calls for
adds parts. For each part of the flow (input, processors, output, the DLQ,
resources):

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py list <category>
```

`<category>` is `inputs`, `processors`, `outputs`, `caches`,
`rate-limits`, … Use only names in `data.components`.

## Step 4: Check the fields

For each component:

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py fields <category> <component>
```

Exit 0: the component is checked; keep the field paths the design names
(such as a retry count). Exit 1: `data.components` holds close matches.
Pick one that fits and check it, else leave it out and write a
`[blocking]` open decision naming it. Never write a component the binary
doesn't list.

## Step 5: Write the note

First read `references/questions.md`; ask as it says. Then write
`<note>` as `references/note-writing.md` says: the header, the title,
then the eleven sections in order. `status: ready` only when Open
decisions holds no `[blocking]` item and every Components row passed
Step 4; else `draft`.

## Step 6: Check the note

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py hash --check <note>
```

A `ready` note must exit 0 with `data.ready: true`. A `draft` note exits
1, and its only error is the `status` line. On any other error, fix the
header (`handoff-header.md`, Syntax) and check again, at most 2 times.
Then read the note against the Readiness list in `design-format.md`, and
fix any item that fails.

Reply with the note's path and status, its components, and each pick.

## Next

- Note ready: build it with rpcn-author ("build the pipeline from
  `<note>`"), then test it with rpcn-test.
- Note draft: answer each `[blocking]` item in an update.
- Note exists: ask to update it.
- Note can't be read: fix it by hand, re-run.
- Binary missing or old: fix it, re-run.

## Status block (headless only)

End with exactly one fenced `json` block, then nothing, written and
filled as `references/status-block.md` says.
