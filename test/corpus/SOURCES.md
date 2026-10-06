# Corpus sources

Every `*.yaml` in this folder is an unmodified copy of a file from the public
[`redpanda-data/connect`](https://github.com/redpanda-data/connect) repository, `config/` directory,
at tag `v4.112.0`, commit `8148f4af833a44e7d208dc1185bafaba6a6256f8`.

**License:** Apache-2.0. The repository's [`licenses/README.md`](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/licenses/README.md)
says Apache-2.0 covers the majority of the repository and the Redpanda Community License (RCL) covers
enterprise features, marked by an RCL header in the Go sources. None of these YAML files carries an
RCL header. Full text: [`licenses/Apache-2.0.txt`](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/licenses/Apache-2.0.txt).
Copyright Redpanda Data, Inc. The private docs cookbooks (`redpanda-data/rp-connect-docs`, no license)
are not used.

The `Blob` column is the git blob SHA-1. `git hash-object <file>` on the local copy reproduces it, which
proves the copy is byte-identical to upstream.

`<name>.lint/<ver>.txt` holds the recorded lint output of `<name>.yaml` for each pinned standalone version.
The corpus harness (`corpus.test.ts`, vitest, plain Node) owns these files. It builds the argv with the
extension's own builder (`buildLintArgs` in `src/core/args.ts`: `lint --deprecated --skip-env-var-check`,
absolute paths) and spawns it through the adapter's spawn site with `NO_COLOR=1`. Format:

```
# redpanda-connect <ver> (NO_COLOR=1)
# argv: redpanda-connect lint --deprecated --skip-env-var-check <CORPUS>/<name>.yaml
# exit: <code>
<stderr lines, corpus dir written as <CORPUS>/, sorted>
```

Lint checks files concurrently, so stderr lines are compared as a sorted set. Resource files are passed
with `--resources` only where this file marks a dependency: `set_grab_cache.yaml` is linted with
`--resources <CORPUS>/resources.yaml` (the harness's `RESOURCE_DEPS` map).

- `scripts/spike/fetch-binaries.sh` downloads and verifies the binaries into `.cache/redpanda-connect/<ver>/`.
- `npm run test:corpus` compares only. It fails on a differing record (naming file, version and lines), a
  `.yaml` without a record, or a record without its `.yaml` (or for an unpinned version). A missing binary
  skips that version locally and fails it in CI (`CI=true`).
- `npm run test:corpus:record` rewrites every record and deletes orphaned ones; it needs both binaries.

| File | Upstream path (permalink) | Kind | Constructs | Blob | Lint 4.100.0 / 4.112.0 |
|---|---|---|---|---|---|
| `joining_streams.yaml` | [config/examples/joining_streams.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/examples/joining_streams.yaml) | config | input `broker`, `try`, `branch`, `catch`, `cache` resource, `tests` | `6d6010141f91640a523c7f5da27bab6188306089` | exit 0 / 0 |
| `track_benthos_downloads.yaml` | [config/examples/track_benthos_downloads.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/examples/track_benthos_downloads.yaml) | config | `workflow`, `branch` as processor resources, `try`, `resource` processor, `metrics` | `454fdfae1fe5175e3f1ba61b8eaf4471541e5197` | exit 0 / 0 |
| `discord_bot.yaml` | [config/examples/discord_bot.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/examples/discord_bot.yaml) | config | `switch` processor, `try`, `catch`, cache resources | `189da8061c2a472187a6d8d0d019a3a607565726` | exit 0 / 0 |
| `stateful_polling.yaml` | [config/examples/stateful_polling.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/examples/stateful_polling.yaml) | config | output `broker` (`fan_out_sequential`), `catch`, multilevel cache resources | `1f357116ccd94edc4ec946387ae2bf2c0fdd8573` | exit 0 / 0 |
| `cdc_replication.yaml` | [config/examples/cdc_replication.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/examples/cdc_replication.yaml) | config | `switch` output with `cases[].output`, input batching processors | `1efdee4b3e9c92298b639fb4128074d33629295a` | exit 0 / 0 |
| `jira_input.yaml` | [config/examples/jira_input.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/examples/jira_input.yaml) | config | `${VAR:default}` interpolation, cache resource | `4cd1d8519f6f41309e383b47653d4643426473a0` | exit 0 / 0 |
| `resources.yaml` | [config/examples/resources/resources.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/examples/resources/resources.yaml) | resource file | `cache_resources` only (`foocache`) | `f1e8438c75d4fa5d300266d2df06e75a1de4e2d7` | exit 0 / 0 |
| `set_grab_cache.yaml` | [config/examples/resources/set_grab_cache.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/examples/resources/set_grab_cache.yaml) | config | references `foocache` defined only in `resources.yaml`, `tests` | `079eeb3f192084be2186346f3ae726884477f449` | exit 0 / 0 |
| `awk.yaml` | [config/test/awk.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/test/awk.yaml) | config | pipeline-only, `output_resources` | `8aad15c85ab7b3d4a7dbcd7687b1eefdd95746ab` | exit 0 / 0 |
| `json_contains_predicate.yaml` | [config/test/json_contains_predicate.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/test/json_contains_predicate.yaml) | config | `processor_resources` only, `tests` | `dc757c97a2e23b83a1a51b27ec7b09d566fe50cc` | exit 0 / 0 |
| `deduplicate.yaml` | [config/test/deduplicate.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/test/deduplicate.yaml) | config | `dedupe` with cache resource, `tests` | `5cd86f566d40cf6d46a56978d8552d3af0c9afbe` | exit 0 / 0 |
| `eval.yaml` | [config/rag/eval.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/rag/eval.yaml) | config | `workflow`, nested `branch`, `while`, `${VAR}` without default | `b565b9c961ff091997982d6c56897c7e8b50f127` | exit 1 / 1 (`field location is required`) |
| `processor_hydration.yaml` | [config/template_examples/processor_hydration.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/template_examples/processor_hydration.yaml) | template | template whose `tests` expand to `try` / `branch` / cache `resource` | `fc78937eb2b37bad75657e110d365799142c6597` | exit 1 / 1 (not a config) |
| `processor_log_and_drop.yaml` | [config/template_examples/processor_log_and_drop.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/template_examples/processor_log_and_drop.yaml) | template | template expanding to `catch` | `849eaed4791f7a19f7c3c4eb782964c8e7e15718` | exit 1 / 1 (not a config) |
| `input_sqs_example.yaml` | [config/template_examples/input_sqs_example.yaml](https://github.com/redpanda-data/connect/blob/8148f4af833a44e7d208dc1185bafaba6a6256f8/config/template_examples/input_sqs_example.yaml) | template | template expanding to input `broker` | `d86db8bc37a93995b55aafd80050f4a86a6b153d` | exit 1 / 1 (not a config) |

Construct coverage: `switch` (processor: discord_bot; output: cdc_replication), `branch` (joining_streams,
track_benthos_downloads, eval), `workflow` (track_benthos_downloads, eval), `try`/`catch` (joining_streams,
discord_bot, stateful_polling), brokers (input: joining_streams; output: stateful_polling), resources
(cache, processor and output resources in nine files, plus the separate resource file `resources.yaml`).

The three `template` files are Redpanda Connect templates, not configs. `lint` rejects them and
`template lint` accepts them (see the spike 1.1 findings). They stay in the corpus as negative inputs for
file detection.

## Hand-written fixtures

`fixtures/` holds inputs written for the spike 1.1 CLI matrix (invalid field, nested invalid field,
missing required field, YAML syntax error, env var with and without default plus a dotenv file,
deprecated field, resource reference plus its resource file, and a long-running `generate` config for
Run + Stop). They are original to this repository (Apache-2.0) and are not copied from anywhere.
