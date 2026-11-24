# Bloblang files and `from` paths

A pipeline `<name>.yaml` (or `<name>.yml`) may keep a mapping in its own
file, `<name>.<label>.blobl`, beside it (AD-6). rpcn-author writes these
files; rpcn-test hashes them as test report inputs and checks them against
`<name>.samples.json` (`samples-format.md`).

## The path rule

The binary opens a `from "<path>"` file relative to its **working
directory**, not to the pipeline's folder (proved on every tested binary by
`test_from_resolves_against_the_working_directory` in the rpcn_check tests;
`SOURCES.md`). Every skill runs from the project root, so:

- A pipeline loads its `.blobl` with a path from the project root, starting
  `./`.
- The same path, without `./`, is the file's path for `rpcn_check.py`
  commands (`hash`, `blobl`) run from the project root.
- A pipeline in the project root loads `./<name>.<label>.blobl`.

Deploying elsewhere has to keep the working directory at the project root,
or rewrite the path.

## Example

`pipes/orders.yaml` loads `pipes/orders.enrich.blobl`:

```yaml
pipeline:
  processors:
    - label: enrich
      mapping: 'from "./pipes/orders.enrich.blobl"'
```

Linted or run from the project root (`lint pipes/orders.yaml`), the path
resolves. Run from inside `pipes/`, the binary looks for
`pipes/pipes/orders.enrich.blobl` and lint fails with `failed to read
import`. The file's path for `rpcn_check.py` is `pipes/orders.enrich.blobl`.
