# Lint errors: cause and fix

How to explain each error that `rpcn_check.py lint` reports. The script runs
`lint --deprecated --skip-env-var-check`, so deprecated components are errors
and unset `${VAR}`s are not. Each error has `file`, `line`, `column` and
`message`. `file` names the file the position is in: the pipeline, or a
resources file passed with `--resources`. All three are `null` for a line the
script could not tie to a file.

For each of `errors`, in order, give its file, line, column, cause and fix as
a unified diff; never add or drop one.

Match the message to a pattern below. `<x>` stands for the name in the
message. Read the lines around the position before proposing a fix: the fix is
a diff against the file as it is now.

## Message patterns

| Message pattern | Cause | Fix |
|---|---|---|
| `field <x> not recognised` | `<x>` is not a field of the component it sits under: a typo, a field nested one level too deep or too shallow, or a field of a different component | Fix the spelling or move it to the level where it belongs. If the component has no such field, delete the line |
| `field <x> is required` | The component needs `<x>` and it has no default | Add `<x>` with a value. Put secrets and hosts in `${ENV_VAR}`, never inline |
| `unable to infer <kind> type, multiple candidates '<a>' and '<b>'` | One `input`, `output` or processor item holds two component keys, so lint can't tell which one it is | Keep one key per item. Several outputs go under `broker: { outputs: [...] }` (or `fallback`, `switch`); several processors become separate list items |
| `component <x> is deprecated` | `<x>` is superseded | Replace it with the successor its documentation names. Field names and shapes can differ between the two, so check each field against the successor (for example a list where the old one had an object) and re-lint |
| `yaml: line <n>: <reason>` (for example `did not find expected key`, `found character that cannot start any token`, `did not find expected ',' or ']'`) | The file is not valid YAML: bad indentation, a tab, an unclosed quote or bracket. Nothing else is checked until it parses | Fix the syntax. The position is often `1,1` and `line <n>` is where the parser gave up, so look at the lines before it too. Indent with spaces only |
| Bloblang parse errors: `required: expected query, but reached end of input`, `expected query, but reached end of input`, `required: expected method or field path, but reached end of input`, and other `expected …` messages on a `mapping` or Bloblang field | The mapping does not parse: an empty right-hand side, a trailing operator or `.`, an unclosed bracket or quote. The column marks where the parser stopped | Complete the expression, for example `this.` becomes `this`. Write mappings that contain quotes as a `\|` block |
| `required environment variables were not set: [<x>]` | `${<x>}` is unset. `rpcn_check` passes `--skip-env-var-check`, so this should not appear | Set `<x>` in the env file the user named, or give a default, `${<x>:value}` |
| Any other message, often with no file or position | The binary printed something the script could not tie to a line | Show it as given. Propose a fix only when the cause is clear from the message |

An unset `${VAR}` is not checked by lint, even in a numeric field: the
pipeline lints clean and the problem shows up only at run time.

## What lint catches

- unknown fields, missing required fields and wrong value types
- YAML syntax
- Bloblang syntax in mappings and Bloblang fields
- deprecated components and fields

## What lint does not catch

- connections: wrong broker addresses, credentials, TLS or Schema Registry auth
- Enterprise licence requirements, which show up at run time
- Bloblang that parses but does the wrong thing: Bloblang samples and unit tests
  find that
- delivery, retries, ordering and idempotency against the design: the Design
  check finds that
