---
name: rpcn-test
description: 'Checks Redpanda Connect pipelines and the binary they run on. Lints a pipeline YAML, runs its Bloblang mappings against samples, dry-runs it, writes and runs rpk connect tests, checks it against its design note, explains each failure with a proposed fix, and writes a <name>.test-report.md. Also reports the rpk connect (or redpanda-connect) version against the 4.100.0 floor. Use when the user says "lint my pipeline", "check this Redpanda Connect config", "why does my pipeline fail lint", "test my pipeline", "check my Bloblang mapping against its samples", "dry-run my pipeline", "write rpk connect unit tests", "check my pipeline against its design note", "check my Redpanda Connect binary", "which rpk connect version do I have", "is Redpanda Connect installed" or "rpcn-test", or pastes a Redpanda Connect config (YAML with input, pipeline or output) and asks what is wrong with it. Not for writing pipelines or applying a report''s changes (use rpcn-author), designing them (use rpcn-design) or deploying them.'
compatibility: "Requires rpk with Redpanda Connect >= 4.100.0, and uv."
license: Apache-2.0
metadata:
  plugin-version: "0.1.0"
---

# rpcn-test

One `uv run …/rpcn_check.py` command per Bash call: no `cd`, `&&`, `;`,
variables, `cat` or heredocs. Use Read and Write for files. Never edit the
pipeline or a `.blobl`: propose fixes as diffs.

**References:** read all a step needs in one turn (Step 3's check
references together, after lint), each with Read: never `ls` or test for a
reference. Lint failed: skip `dry-run.md`, `unit-tests.md`: `Not run: lint
failed.` No design note: skip `design-check.md`: `Not run: no design note.`

**Headless** if the prompt says unattended, headless or non-interactive,
or a script reports `data.headless: true`: never ask; end with the status
block.

## Step 1: Check the binary

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py binary
```

Unexpanded `${CLAUDE_SKILL_DIR}`: use this folder's absolute path.

Calls print JSON. **Exit 2** in Steps 1–3 (but the note's `hash --check`,
`blobl`, `run`, `test`) means it can't test: write no report, show each
`errors[].message`; for a binary error, the fix in
`references/binary-fixes.md`.

Asked only about the binary: report `binary.path` and `binary.version`
(`…/rpk` runs as `rpk connect`), then Next.

**Pasted config:** `references/pasted-config.md`.

## Step 2: Hash the inputs

`<pipeline>` is `<name>.yaml` (or `.yml`). `<dir>/` is its folder as given
(`pipes/`), or nothing. `<res>` is the resources file named, else
`<dir>/<name>.resources.yaml` (`.resources.yml` for `.yml`) if it exists.
`<blobl>` is each `from "<path>"` file it loads. First check
`<file>` = `<name>.design.md` (line 1). Exit 2, not found: no note. Ready by
`references/design-check.md` (with `references/design-format.md`): `<note>`
is `<dir>/<file>`. Else not ready. Then line 2:

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py hash --check <dir>/<file>
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py hash <dir>/<pipeline> [<res>] [<blobl>]... [<note>]
```

## Step 3: Lint

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py lint <dir>/<pipeline> [--resources <res>] [--env-file <file>]
```

Pass `--env-file` only when the user names one (or `dry-run.md` says).
For each `<blobl>`, follow `references/samples.md` (with
`references/samples-format.md`, `references/blobl-files.md`):

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py blobl <blobl> --samples <dir>/<name>.samples.json [--env-file <file>]
```

Then `references/dry-run.md`:

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py run <dir>/<pipeline> --bounded --input <msgs> [--resources <res>] [--env-file <file>]
```

Then `references/unit-tests.md`:

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py test [--resources <res>] <dir>/<pipeline>
```

Then `references/design-check.md`.

## Step 4: Explain the errors

Lint errors: explain each as `references/lint-errors.md` says. Check
every fix as `references/fix-check.md` says.

## Step 5: Write the report

Write `<dir>/<name>.test-report.md`, check it and reply as
`references/report-writing.md` says (with `references/test-report-format.md`,
`references/handoff-header.md`).

## Next

- Failed checks: apply the changes with rpcn-author, re-run rpcn-test.
- Only rpcn-test's own files, or the binary, fixed: re-run rpcn-test.
- No pipeline yet: use rpcn-author.
- A Design check `mismatch` the design should absorb: update the note
  with rpcn-design, then re-run rpcn-test.

## Status block (headless only)

End with exactly one fenced `json` block, then nothing, written and
filled as `references/status-block.md` says.
