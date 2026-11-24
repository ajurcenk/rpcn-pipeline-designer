# Hand-off header and readiness rules

Skills hand work to each other only through files in the developer's
project, beside `<name>.yaml` or `<name>.yml` (AD-6). Every Markdown hand-off file, such as
`<name>.design.md` or `<name>.test-report.md`, starts with the header below.
Each artifact's own format doc (`design-format.md`, `test-report-format.md`)
adds its sections and its readiness list.

## One writer per file

Exactly one skill writes each hand-off file (the table in AD-6). A skill
never edits another skill's file. The one exception: rpcn-author may add
Deviations rows to the design note and update its `updated` field
(`design-format.md`). Skills that find a problem in the pipeline (Test, Tune,
Deploy) put a proposed diff in their own report, and rpcn-author applies it.

## Header fields

| Key | Value |
|---|---|
| `artifact` | `design`, `test-report`, `capacity`, `deploy`, `tune-report` or `migration-report` |
| `format` | `<artifact>@<major>`, for example `test-report@2` |
| `pipeline` | The pipeline name: `<name>` in `<name>.yaml` (or `<name>.yml`) |
| `status` | `draft`, `ready` or `superseded` |
| `produced_by` | `rpcn-<job>@<plugin version>`, for example `rpcn-test@0.1.0` |
| `rpcn_version` | The Redpanda Connect version the writer ran, without `v` |
| `inputs` | The files this one was made from, each with its sha256 |
| `updated` | ISO date of the last write, `YYYY-MM-DD` |

All eight keys are required.

## Syntax

The header is YAML frontmatter, but only a strict subset of YAML, so that
`rpcn_check.py` can read it without a YAML library. Write it exactly this way:

- Line 1 is `---`. The header ends at the next line that is `---`.
- One `key: value` per line for `artifact`, `format`, `pipeline`, `status`,
  `produced_by`, `rpcn_version` and `updated`. The key starts the line, and
  one space follows the colon. A value may be wrapped in matching `'` or `"`
  quotes, which are removed. No comments, no multi-line values, no other keys.
- `inputs:` on its own line, followed by one block item per input, each
  exactly two lines:

  ```yaml
  inputs:
    - file: orders.yaml
      sha256: 77c752d3d897336753043dd647d081da3caae2669b3c6bc7169fa80b44729e56
  ```

  That is two spaces, `- file: <path>`, then four spaces, `sha256: <hash>`.
  The hash is 64 lowercase hex characters.
- With no inputs, write `inputs: []`.
- `file` paths are relative to the folder that holds the hand-off file, never
  absolute. Since hand-offs sit beside the pipeline, the pipeline is always
  just its file name. Other inputs, such as a resources file shared by
  several pipelines, may be relative paths like `../resources.yaml`.
- Blank lines inside the header are allowed. Keys may come in any order, and
  each appears once.

`rpcn_check.py hash --check` rejects any other shape and names the line.

## Status lifecycle

```
draft  -->  ready  -->  superseded
```

- **`draft`**: being written, or incomplete. Readers do not use it.
- **`ready`**: complete, and it passes the format's own Ready rule. Readers
  may use it, once the readiness rules below hold.
- **`superseded`**: no longer describes the pipeline (for example the writer
  is replacing it, or the pipeline it was about is gone). Readers do not use
  it.

Only the file's writer changes `status`. A file whose inputs have changed
since it was written is stale even while it still says `ready`; the hash
check catches that, so writers do not need to go back and mark it.

## Readiness rules

A reader uses a hand-off file only when all of these hold:

1. `status` is `ready`.
2. `format` names this artifact with a major the reader knows.
3. Every `inputs` hash matches the current file.
4. For a test report only, the first input is the pipeline file,
   `<name>.yaml` or `<name>.yml`. Other artifacts skip this rule.
5. The readiness list in that artifact's format doc passes.

Rules 1 to 3, and rule 4 for a test report, are checked by the script, never by hand or in prose:

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py hash --check orders.test-report.md
```

If `${CLAUDE_SKILL_DIR}` is not expanded, the path is relative to the skill
folder: the script is `scripts/rpcn_check.py` in the skill folder, which is
`../scripts/rpcn_check.py` relative to this `references/` file.

It exits 0 with `data.ready: true` only when rules 1 to 3 hold, plus rule 4
for a test report. Exit 1 means not
ready: `data.inputs` gives each input's `state` (`match`, `changed` or
`missing`) and `errors` says why. Exit 2 means the file is missing or its
header does not follow the syntax above; the error gives the line. Treat
exit 1 and exit 2 alike: the input is not ready.

Rule 5 is a judgement the reading skill makes, using the list in the format
doc. If any rule fails, the reader treats the input as not ready (AD-6, and
AD-8 `blocked` when the input is required).

The pipeline YAML has no header. It counts as ready only when
`hash --check <name>.test-report.md` reports `pipeline_ready: true`: the
report is ready, its `<name>.yaml` (or `<name>.yml`) input hash matches, and its
`**Verdict:**` line is `pass` (`data.verdict`). A report with the verdict
`fail` is still `ready`, so rpcn-author can read its proposed changes, but
the pipeline is not ready.

## Writing the hashes

Hash the inputs with the script, from the folder that holds the hand-off
file, so the paths it prints are the paths to record:

```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/rpcn_check.py hash orders.yaml orders.design.md
```

It prints `data.hashes`, one `{"file", "sha256"}` per file in the order
given, and exits 2 naming any file that does not exist. Copy each pair into
`inputs`. Every file the work read counts as an input, including any
resources file passed to lint with `--resources`, so a change to a shared
resources file makes the hand-off stale too. Hash the inputs as they were when the work was done (for a test
report, before the checks run), and never hash the hand-off file itself.
The hash is over the file's exact bytes, so any edit, even whitespace, makes
the hand-off stale.

## Format versions

Each format doc states its `format` line, for example `test-report@2`. A
breaking change to a format bumps the major (`test-report@3`), and readers
reject a major they do not know. `rpcn_check.py` holds the majors it knows in
`KNOWN_FORMATS`; a new format adds its entry there with its format doc. A
reader may keep accepting an older major after a bump (`test-report@1` is
still read), and its format doc says how that major differs.

## Example

A complete header, from `test-report-format.md`:

```yaml
---
artifact: test-report
format: test-report@2
pipeline: orders
status: ready
produced_by: rpcn-test@0.1.0
rpcn_version: 4.115.0
inputs:
  - file: orders.yaml
    sha256: 77c752d3d897336753043dd647d081da3caae2669b3c6bc7169fa80b44729e56
  - file: orders.design.md
    sha256: 7be7ffdd17c1b56532c029f0298782c1ff43eb3be2ea32b5d9348d7279a1fa3b
updated: 2026-10-23
---
```
