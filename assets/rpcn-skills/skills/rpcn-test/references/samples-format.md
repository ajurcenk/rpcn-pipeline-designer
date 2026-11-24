# Bloblang samples format, `samples@1`

The samples file `<name>.samples.json` holds, for each Bloblang file that
`<name>.yaml` (or `<name>.yml`) loads, sample inputs and the output each one
should give. It sits beside the pipeline in the developer's project, and
rpcn-test is its only writer (AD-6). rpcn-author writes the mappings, as
`<name>.<label>.blobl` files beside the pipeline, and never this file.

`rpcn_check.py blobl <mapping> --samples <name>.samples.json` reads it, runs
the mapping's samples and compares each output with the expected one
(`SCHEMA.md`). That check is the parser: a file it rejects (exit 2) does not
follow this format.

A breaking change (a key renamed or removed, a rule made stricter) bumps the
major to `samples@2`. The file is JSON, so it has no hand-off header: its
`format` key carries the version, and readers reject a value they do not know.

## Shape

```json
{
  "format": "samples@1",
  "pipeline": "<name>",
  "mappings": {
    "<name>.<label>.blobl": [
      {"name": "<sample name>", "input": <JSON value>, "output": <JSON value>},
      {"name": "<sample name>", "input": <JSON value>, "deleted": true}
    ]
  }
}
```

| Key | Type | Meaning |
|---|---|---|
| `format` | str | Always `samples@1` |
| `pipeline` | str | The pipeline name, `<name>` in `<name>.yaml` |
| `mappings` | object | One key per `.blobl` file, its bare file name (no folder). Each value is a non-empty array of samples |
| `name` | str | Says what the sample checks, such as `large order is high priority`. Unique within its mapping |
| `input` | any JSON | One message's content, as a JSON value |
| `output` | any JSON | The content the mapping should give for `input`. A raw string output (`root = "ok"`) is the JSON string `"ok"` |
| `deleted` | `true` | The mapping should delete the message (`root = deleted()`). Instead of `output` |

## Rules

- The file is one JSON object with exactly the keys `format`, `pipeline` and
  `mappings`. A sample has `name`, `input`, and exactly one of `output` and
  `deleted`. Any other key, a repeated key, or a missing one is an error, and
  so are `NaN`, `Infinity` and `-Infinity`, which are not JSON.
- A `mappings` key is a bare `.blobl` file name. It names the file beside
  the samples file, and `--samples` matches it to the mapping's file name.
- The binary prints a string root raw, without quotes: `root = "123"` and
  `root = 123` both print `123`, and `format_json()` prints JSON text. So
  an expected string is compared with the output text exactly as printed,
  unparsed: `"123"` passes on `123`, and `"{\"a\":1}"` passes only on that
  exact text. Any other expected value is compared as a JSON value: key
  order and spacing don't count, and `1` equals `1.0`, but `true` never
  equals `1`. An output that is not JSON fails against a non-string
  value.
- An empty output counts as a deleted message, so a mapping that gives an
  empty string needs `deleted: true`.
- **Expected values come from intent, never from running the mapping:** the
  request, the design note, or what the mapping's name and label say it
  should do. A value taken from the mapping's own output would pass by
  construction. When the intent is unclear, write no sample for it and ask
  instead.
- An expected value is never changed to match what the mapping gives. A
  mismatch is a finding for the test report, and the fix is a proposed diff
  to the `.blobl` file. A sample is changed only when the request or a
  ready design note states its value differently, and the test report's
  item then quotes that sentence.
- Samples cover one message's content only: never metadata, a batch of
  several messages, or the inside of a `branch` or `workflow` processor.
- The samples file is not a test report input: changing it does not make
  the report stale. Each `.blobl` file is an input.

## Readiness list

Before a reader trusts the samples for a mapping:

- [ ] `blobl <mapping> --samples <name>.samples.json` does not exit 2: the
      file parses, follows the rules above, and has an entry for the
      mapping.
- [ ] `pipeline` is the name of the pipeline beside it.
- [ ] Every `.blobl` file the pipeline loads has an entry in `mappings`.

## Example

A pipeline `pipes/orders.yaml` loads its mapping with a path from the
project root:

```yaml
pipeline:
  processors:
    - label: enrich
      mapping: 'from "./pipes/orders.enrich.blobl"'
```

The mapping:

<!-- example-file: orders.enrich.blobl -->
```text
root = this
root.total_cents = (this.total * 100).round()
root.currency = this.currency.uppercase()
root.priority = if this.total >= 100 { "high" } else { "normal" }
```

Its samples (the rpcn_check tests run them on every tested binary):

<!-- example-file: orders.samples.json -->
```json
{
  "format": "samples@1",
  "pipeline": "orders",
  "mappings": {
    "orders.enrich.blobl": [
      {
        "name": "small order is normal priority",
        "input": {"id": "o1", "total": 12.5, "currency": "usd"},
        "output": {"id": "o1", "total": 12.5, "currency": "USD", "total_cents": 1250, "priority": "normal"}
      },
      {
        "name": "large order is high priority",
        "input": {"id": "o2", "total": 150, "currency": "eur"},
        "output": {"id": "o2", "total": 150, "currency": "EUR", "total_cents": 15000, "priority": "high"}
      }
    ]
  }
}
```
