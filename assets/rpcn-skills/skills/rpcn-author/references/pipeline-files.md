# Pipeline files

Every file sits beside the pipeline, in `<dir>/` (AD-6).

## Resources file

When the pipeline uses a resource (a cache, rate limit, or a shared input,
processor or output), define it in `<dir>/<name>.resources.yaml`
(`<name>.resources.yml` for a `.yml` pipeline), not in the pipeline:

```yaml
cache_resources:
  - label: lookup
    redis:
      url: ${REDIS_URL}
```

- Top-level keys: `cache_resources`, `rate_limit_resources`,
  `input_resources`, `processor_resources`, `output_resources`. Each is a
  list of `label` plus one component.
- The pipeline refers to it by label, such as `resource: lookup` in a
  `cache` processor.
- Check the component's fields with `fields caches <component>` (or its own
  category): they come without the `cache_resources[]` wrapper.
- If the resources file already exists, never write over it: ask in the
  one round (`questions.md`), or in headless mode stop with `blocked` as
  for the pipeline.

## Bloblang files

A `mapping` processor whose mapping is more than 3 lines goes in its own
file, `<dir>/<name>.<label>.blobl`, so rpcn-test can check it against
samples. A mapping of 3 lines or less, such as `root = this`, stays inline.

- `<label>` is the processor's `label`, short snake_case (such as `enrich`).
  Give the processor that `label`.
- The file holds only the Bloblang, with no YAML around it.
- The pipeline loads it with `from` and a path from the project root, as
  `blobl-files.md` (in this folder) says, such as
  `mapping: 'from "./pipes/orders.enrich.blobl"'`.
- Keep non-deterministic values out of the `.blobl`: anything from
  `now()`, `timestamp_unix()`, `uuid_v4()` or a random function goes in a
  separate inline `mapping` of 3 lines or less, right after the one that
  loads the file, so rpcn-test can sample the file. That mapping starts
  from an empty root, so keep the message:

  ```yaml
      - label: stamp
        mapping: |
          root = this
          root.received_at = now()
  ```
- Only `mapping` processors: a `mutation`, a `branch` or `workflow`
  processor's inner mappings, and mappings inside an input or output stay
  inline.
- Lint checks the file through the pipeline, so Step 6 needs no extra
  command.
- If the `.blobl` file already exists, never write over it: ask in the
  one round (`questions.md`), or in headless mode stop with `blocked` as
  for the pipeline.
- Never move an existing pipeline's inline mapping into a `.blobl` file,
  unless a test report proposes it.
- rpcn-test writes `<name>.samples.json`; rpcn-author never writes it.

## Env vars and `.env.example`

- Every secret, password, token, address or URL that differs per
  environment is `${NAME}` in the YAML, never an inline value. Use
  `${NAME:default}` only for a non-secret default.
- Names are upper snake case, such as `REDIS_URL`.
- List every name in `<dir>/.env.example`, one `NAME=` line each with no
  value, under a `#` comment saying what it is:

  ```text
  # Redis URL for the lookup cache, such as redis://localhost:6379
  REDIS_URL=
  ```

- One `.env.example` serves every pipeline in the folder. If it exists, read
  it and add only the missing names; never remove or change a line.
- Add every file written, `.blobl` files too, to the status block's
  `artifacts`.
