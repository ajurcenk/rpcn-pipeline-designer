# Spike 1.1 findings — Redpanda Connect CLI facts

Ticket 1.1 (epic-foundation). Run 2026-10-05 with `scripts/spike/fetch-binaries.sh && scripts/spike/run-matrix.sh` (Linux amd64).
Flavors: `standalone-4.100.0`, `standalone-4.112.0` (official release archives, sha256-verified) and `rpk-4.112.0` (the installed `rpk connect`, read-only).
Every child ran with `NO_COLOR=1`. Quotes come from `captures/standalone-4.112.0/<scenario>.*` unless another file is named.
4.100.0 output is identical except version strings, `benthos_version=` in logs, and schema/cue sizes and hashes (`captures/diff-standalone-4.100.0-vs-standalone-4.112.0.txt`).
Items marked *by hand* were checked manually and are not in `captures/`.

## Answers to the spec's open questions

- **Standalone `redpanda-connect` vs `rpk connect` parity:** yes for everything the extension uses (Q1).
- **Real lint stderr format and `list --format jsonschema` output:** recorded below (Q2, Q4); two facts differ from what the architecture assumed (lint column, schema docs).

## Q1. Standalone vs `rpk connect` (AD-9)

- `captures/rpk-binary-identity.txt`: the rpk-managed binary has the same sha256 as standalone 4.112.0 (`54414da2…9a10`); `schema_identical=yes`.
- `rpk connect run` execs the binary in place (same PID, process name `.rpk.managed-co`, *by hand*), so SIGINT reaches Redpanda Connect directly; `rpk-4.112.0/run-stop.exit` is 0.
- `captures/diff-standalone-4.112.0-vs-rpk-4.112.0.txt` shows only three differences:
  1. Root `--help` is rpk's own help. `lint --help`, `run --help`, `list --help` are identical.
  2. rpk consumes `--verbose` / `-v` as its global flag, so `lint --verbose` prints no OK/FAILED lines.
  3. rpk consumes a bare `-`: `lint -` exits 0 silently.
- **For the argument builder (ticket 1.5):** never pass `--verbose`, `-v` or `-`; always pass at least one path (`lint` with no paths exits 0 silently in both flavors, `lint-no-paths`).

## Q2. Lint output (AD-12, AD-16)

- Findings go to **stderr** as `<path>(<line>,<col>) <message>`; stdout is empty without `--verbose`; exit 1 on any finding, 0 when clean; **no severity** on a line.
- **The column is always 1**, even for indented fields:
  - `lint-invalid-field`: `invalid_field.yaml(6,1) field nope not recognised`, `invalid_field.yaml(9,1) field codex not recognised`
  - `lint-nested-invalid-field`: `nested_invalid_field.yaml(8,1) field bogus is invalid when the component type is mapping (processor)` (field is at column 15)
  - → AD-16 should map a lint finding to the whole line and ignore the column.
- Lines are 1-based and count comment lines.
- The path is echoed exactly as passed (`lint-absolute-path` prints `<ROOT>/test/corpus/fixtures/invalid_field.yaml(6,1) …`) → pass absolute paths.
- A missing required field is reported on the first line of the component's body, not on its key: `missing_required.yaml(4,1) field mapping is required`.
- File-level errors land on `(1,1)`; for YAML syntax errors the real line is only inside the message:
  - `does_not_exist.yaml(1,1) open does_not_exist.yaml: no such file or directory`
  - `yaml_syntax_error.yaml(1,1) yaml: line 6: did not find expected node content`
- Several files are linted concurrently, so per-file output order varies.
- **Stdin is not supported:** `-(1,1) open -: no such file or directory`, exit 1 (`lint-stdin`). The architecture's deferred "lint via stdin" is not possible today.
- **Lint does not check resource references:** `resources-lint-no-flag` and `resources-lint-with-flag` both exit 0 (the matrix predicted exit 0 only with `-r`). The error appears only at run time (`resources-run-no-flag`, exit 1): `failed to init processor <no label> path root.pipeline.processors.0: cache resource 'spike_cache' was not found`.
- Templates fail `lint` (`field name not recognised`, see `test/corpus/processor_log_and_drop.lint/4.112.0.txt`); `template lint` exits 0 (*by hand*). → AD-18 detection should exclude templates (top-level `name` + `type` + `mapping`).

## Q3. Environment variables

- No flag (`env-no-flag`, exit 1): `env_no_default.yaml(1,1) required environment variables were not set: [SPIKE_GREETING]`.
- `--skip-env-var-check`, `-e spike.env`, and `${VAR:default}` all exit 0 with no output. With `-e` the variable counts as set; that the value is substituted was not verified.
- The env error is reported together with field errors, not instead of them (`env-plus-field-error`, exit 1):
  `env_plus_field_error.yaml(1,1) required environment variables were not set: [SPIKE_GREETING]`
  `env_plus_field_error.yaml(6,1) field nope not recognised`

## Q4. Schema (AD-10, AD-20)

- Top-level keys: `definitions`, `properties`. **No `$schema` keyword.**
- Custom keys `is_advanced`, `is_deprecated`, `is_optional`, `is_secret` on every node.
- `definitions` holds 9 categories: buffer, cache, input, metrics, output, processor, rate_limit, scanner, tracer. Components sit at `definitions.<cat>.allOf[0].anyOf[i].properties.<name>`; `allOf[1]` holds shared fields (`label`, `processors`).
- 118 `$ref`s, all `#/definitions/<cat>` — e.g. output `switch` `cases.items.properties.output` = `{"$ref":"#/definitions/output"}`, processor `branch` `processors.items` = `{"$ref":"#/definitions/processor"}`. → The AD-20 ComponentCatalog can be built by walking `$ref`s.
- **No `description`, `examples` or `default` keywords.** (The 9 `description` paths are fields named `description`, e.g. `cohere_chat.tools[].description`.) → AD-10's "fold examples into markdownDescription" has nothing to fold. `list --format cue` carries field docs as `//` comments (`schema-cue.stdout`: `bytes=955179`, `comment_lines=7332`, e.g. `// Configures the service-wide HTTP server.`; 4.100.0: 897,161 bytes, 6,995 comment lines), and `list --format jsonschema bloblang-functions` has docs for most functions (`bloblang-functions.stdout`: `entries=41`, `with_description=39`, `with_examples=39`). **Ticket 1.6 must pick another doc source or drop that part of AD-10.**
- Deterministic output: 795,174 bytes (4.100.0) and 808,268 bytes (4.112.0); exit 0, empty stderr. Fixtures: `test/fixtures/schema/jsonschema-<ver>.json`.
- `captures/schema-diff-4.100.0-vs-4.112.0.txt`: identical component counts (input 81, output 86, processor 96, cache 17, scanner 12, metrics 8, tracer 5, buffer 4, rate_limit 2); identical top-level properties; 77 deprecated field paths in each; 4.112.0 adds 106 field paths and removes none (e.g. `input.aws_kinesis.enhanced_fan_out.*`) → every 4.100.0 field path exists in 4.112.0. Only property-name paths were compared, not types, enums, `required` or per-field `is_deprecated`.

## Q5. Deprecated (AD-17)

- Without the flag: exit 0, no output.
- `deprecated-flag` (exit 1): `deprecated.yaml(5,1) field codec is deprecated` — same wording in both versions.
- → Classify a line as a warning when it matches `^field \S+ is deprecated$`. `--deprecated` makes the exit code 1, so the exit code cannot separate deprecations from errors.

## Q6. Run and Stop (AD-13)

- `run-stop` exits 0; `.timing`: `signal=SIGINT after=2s exited_within_10s=yes` (about 5 ms *by hand*, both flavors).
- stdout carries only the payload (`tick`); logs are logfmt on stderr and include `level=info msg="Received SIGINT, the service is closing"`. The capture is sorted for reproducibility; that this is the last line was seen *by hand*. Startup line order varies.
- No default `shutdown_timeout` in the schema, and a hanging shutdown was not tested → Stop should still escalate to SIGKILL after a grace period.
- Run refuses a config with lint errors unless `--chilled` (`run-lint-error`, exit 1): `level=error msg="Config lint error" … lint="invalid_field.yaml(6,1) field nope not recognised"` and `shutting down due to linter errors, to prevent shutdown run Redpanda Connect with --chilled`.
- Every run binds `0.0.0.0:4195`. A second concurrent run logs `HTTP Server error: listen tcp 0.0.0.0:4195: bind: address already in use` and keeps running (*by hand*) → consider `-s http.enabled=false` for per-file runs.
- The license log line depends on the host's `/etc/redpanda/redpanda.license` (redacted in captures).

## Q7. Version (AD-9)

- `version.stdout`: `Version: 4.112.0` / `Date: 2026-10-02T08:48:17Z`, exit 0; 4.100.0 prints `Version: 4.100.0` / `Date: 2026-07-09T16:56:36Z`. rpk output is identical.
- → Parse with `^Version: (\S+)$`.

## NO_COLOR (AD-9)

- ANSI codes appear only on a TTY (`\x1b[33m` per line, *by hand* with a Python pty); `NO_COLOR=1` removes them there too; piped output is never coloured.

## Corpus (`test/corpus/`)

- 15 unmodified files from `redpanda-data/connect` `config/` at v4.112.0 (`8148f4af833a44e7d208dc1185bafaba6a6256f8`), Apache-2.0; provenance in `test/corpus/SOURCES.md`.
- 12 are configs or resource files; 3 are templates that `lint` rejects (kept as negative cases).
- Covers switch (processor and output), branch, workflow, try/catch, input and output brokers, cache/processor/output resources, and a separate resource file.
- Recorded lint bodies are identical between 4.100.0 and 4.112.0. Upstream `rag/eval.yaml` fails on both with `eval.yaml(108,1) field location is required` — a real-world error case.
- Hand-written error-path inputs in `test/corpus/fixtures/`.

## Follow-ups for later tickets and the architecture

| Finding | Affects |
|---|---|
| Lint column is always 1 → map findings to whole lines | AD-16, E2 lint parser |
| Schema has no docs/examples/defaults → choose `cue` or another doc source, or drop that transform step | AD-10, ticket 1.6 |
| Lint ignores resource references (run-time only) | AD-12 diagnostics parity expectations, E2 |
| Templates fail `lint` → exclude from detection | AD-18 |
| Never pass `--verbose`, `-v`, `-`; always pass a path | ticket 1.5 |
| No stdin lint | architecture Deferred (stdin item can be closed) |
| Stop: SIGINT exits 0; still escalate to SIGKILL | AD-13, E2 Run |
| Port 4195 collision between runs → `-s http.enabled=false` | AD-13, E2 Run |
| Repo has no LICENSE file yet (needed for Apache-2.0 redistribution) | ticket 1.2 |
