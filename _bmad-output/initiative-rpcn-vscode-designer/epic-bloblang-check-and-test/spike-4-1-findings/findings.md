# Spike 4.1 findings — Bloblang execution on the binary

Ticket 4.1 (epic-bloblang-check-and-test). Run 2026-10-12 with `bash scripts/spike/blobl-probe.sh` (Linux amd64, 20 timing runs per row).
Flavors: `standalone-4.100.0`, `standalone-4.112.0` (from `scripts/spike/fetch-binaries.sh`) and `rpk-4.112.0` (the installed `rpk connect`, read-only; its managed binary is the same build as standalone 4.112.0, spike 1.1 Q1).
Routes: **A** `blobl server --no-open -p <port>` + `POST /execute`; **B** `blobl -f <mapping file>`, input on stdin; **C** `run` on a generated one-message config (`<flavor>/C/<scenario>.request` holds the config).
Every child ran with `NO_COLOR=1` and no shell. Quotes come from `captures/standalone-4.112.0/<route>/<scenario>.*` unless another file is named. Items marked *by hand* were checked manually and are not in `captures/`.

**All three flavors behave identically on every scenario and route**: `captures/diff-standalone-4.100.0-vs-standalone-4.112.0.txt` and `captures/diff-standalone-4.112.0-vs-rpk-4.112.0.txt` differ only in `invocation.txt` (what `<BIN>` stands for). Two runs of the script give identical captures apart from `captures/timings.tsv`.

## Answers to the epic's open questions

- **Metadata in and out of a test (spec Open Questions):** only route C carries metadata. Route A ignores the request's `metadata` and returns no output metadata; route B has no way to pass or return metadata. → Test runs (CAP-16, entry 4.7) use route C, which supports metadata in and out.
- **Does `blobl server` exist and behave the same on v4.100.0?** Yes. `server-help` exits 0 on all three flavors, and every route A capture is byte-identical between 4.100.0 and 4.112.0. `rpk connect blobl server` passes `-p` through (`rpk-4.112.0/A/server.check`: `port_passed_through=yes`).
- **Latency:** each process launch costs about 0.2 s standalone and 0.42 s through `rpk` (rpk's own start-up adds about 220 ms). A warm `POST /execute` takes about 2 ms. A, B and C cost the same per launch. Table below.
- **Recommendation (AD-21, adopted 2026-10-12):** live parse uses **route B** with stdin closed; test runs use **route C**; both are one-shot children with no long-lived server.
- **What "matches the binary" means (decided by the user on 2026-10-12: compare against route C):** route C deliberately differs from `blobl` (route B) for multi-line input (one message vs one per line), `deleted()` (no output line vs an empty line) and bad-input (`failed assignment (line 1)` vs no line). Epic Done-when 2 and the spec's second-release success signal say the panel matches "the binary's `blobl` result"; with AD-21 they must instead compare the panel against route C (the panel's own route) on recorded results. The spec and the epic are not edited here.

## Measured table

Timings from `captures/timings.tsv` in ms, as the range of each scenario's p50 / p95 over the 10 scenarios (20 runs each). "Cold" = spawn until the result (for A: spawn, wait until `/execute` answers, run the scenario). "Warm" = one more request to a running server (A only; B and C have no warm path).

| Route | Flavor | Scenarios supported | Cold p50 | Cold p95 | Warm p50 | Warm p95 |
|---|---|---|---|---|---|---|
| A | standalone-4.100.0 | ok, map-error, parse-error, bad-input, raw-input, multi-line; **not** meta-in, meta-out, deleted | 171–195 | 180–221 | 1.7–2.0 | 1.8–2.8 |
| A | standalone-4.112.0 | same as above | 196–199 | 202–226 | 1.6–1.9 | 1.8–2.1 |
| A | rpk-4.112.0 | same as above | 430–435 | 437–482 | 1.6–1.8 | 1.7–2.0 |
| B | standalone-4.100.0 | ok, map-error, parse-error, bad-input, raw-input; **not** meta-in, meta-out, deleted, multi-line | 191–196 | 196–212 | n/a | n/a |
| B | standalone-4.112.0 | same as above | 195–197 | 198–220 | n/a | n/a |
| B | rpk-4.112.0 | same as above | 413–423 | 420–463 | n/a | n/a |
| C | standalone-4.100.0 | **all**: ok, meta-in, meta-out, deleted, map-error, bad-input, raw-input, multi-line; parse-error with config-relative positions | 192–197 | 199–213 | n/a | n/a |
| C | standalone-4.112.0 | same as above | 197–203 | 202–228 | n/a | n/a |
| C | rpk-4.112.0 | same as above | 416–422 | 422–473 | n/a | n/a |

## Per-scenario results

Same on every flavor. Capture path: `captures/<flavor>/<route>/<scenario>.{request,stdout,stderr,exit}` (route A has no `.stderr`, and its `.exit` holds the HTTP status). One-line view of all of them: `captures/summary.tsv`.

| Scenario | A (`blobl server`) | B (`blobl -f`) | C (`run`) |
|---|---|---|---|
| ok | `result` `{"a": 2, "b": "set"}` (pretty-printed) | stdout `{"a":2,"b":"set"}`, exit 0 | `{"content":"{\"a\":2,\"b\":\"set\"}","meta":{}}` |
| meta-in | **ignored**: `"k": null` although the request sends `metadata: {key: k1}` | **ignored / not expressible**: `{"k":null}` | **works**: `{"content":"{\"k\":\"k1\"}","meta":{"key":"k1"}}` |
| meta-out | **not returned**: `result` `{"a": 1}`, no metadata field | **not returned**: `{"a":1}` | **returned**: `"meta":{"out":"x"}` |
| deleted | **no signal**: `result` `""`, the same as `empty-string` (`root = ""`) | **no signal**: stdout is one empty line, the same as `empty-string` | **signalled by absence**: exit 0, empty stdout and stderr; `empty-string` gives `{"content":"","meta":{}}` |
| map-error | `mapping_error`: `failed assignment (line 2): expected number value, got null from field \`this.nope\`` | stderr `failed to execute map: failed assignment (line 2): …`, **exit 0** | `{"error":"failed assignment (line 2): …"}` on stdout, plus a `level=error` log line naming `path=root.pipeline.processors.0`; exit 0 |
| parse-error | `parse_error`: `failed to parse mapping: line 3 char 8: required: expected comma or closing bracket` + caret excerpt; **mapping-relative** | the same text and caret on stderr, **exit 1**; **mapping-relative** | exit 1, `Config lint error … parse-error.yaml(16,24) required: expected comma or closing bracket, got: = 3`; **config-relative**, no caret |
| bad-input | `mapping_error`: `unable to reference message as structured (with 'this'): parse as json: invalid character 'o' …` | stderr `failed to execute map: unable to reference …`, exit 0 | `{"error":"failed assignment (line 1): unable to reference …"}`, exit 0 |
| raw-input | works: `result` `HELLO RAW` | works: `HELLO RAW` | works: `"content":"HELLO RAW"` |
| multi-line | **one message**: the whole input is parsed as JSON | **one message per line**: 4 errors (`unexpected EOF`, `invalid character ':' …`), exit 0 | **one message**: `"content":"{\"a\":1,\"b\":2}"` |
| server-missing | `blobl server --help` exits 0 on all flavors (`<flavor>/server-help.*`) → route A available everywhere | — | — |
| empty-string (extra) | `result` `""` | one empty line | `{"content":"","meta":{}}` |
| parse-only (B, stdin closed) | — | `ok.parse-only`, `map-error.parse-only`: exit 0, no output; `parse-error.parse-only`: exit 1 with the full parse error. No message is mapped. | — |

## Q1. Parse errors and positions (CAP-15, entries 4.2 and 4.5)

- A and B give the same text: `failed to parse mapping: line L char C: <message>` followed by a caret excerpt:
  ```
  failed to parse mapping: line 3 char 8: required: expected comma or closing bracket
    |
  3 | root.c = 3
    |        ^---
  ```
  `line` and `char` are 1-based and relative to the mapping text (the caret is under the `=`, column 8 of `root.c = 3`).
- B with stdin closed parses without mapping a message (`B/*.parse-only.*`): exit 1 means a parse error and exit 0 means the mapping parses. Mapping errors on `{}` never show, so a parse check doesn't need an input.
- Route C (and so `lint`) reports Bloblang parse errors with **config** positions and a different message (`… got: = 3`, no caret). The line is the YAML line, but the column is not the mapping column plus the indent: `(16,24)` for an error at mapping char 8 under an 8-space indent. *By hand*, a one-line mapping `root.b = this.foo.bar(` gave `(12,17)` (the line after the mapping), and the same 3-line mapping as a double-quoted scalar gave `(10,24)`. → Never derive mapping positions from `run`/`lint` output. Note for entry 4.5: unlike field lints (spike 1.1 Q2, column always 1), lint's Bloblang findings carry a column, but it is unreliable.
- Exit 1 is not always a parse error (*by hand*, 4.112.0): with an unset `${SPIKE_X}` in the mapping, `blobl -f` exits 1 with `failed to replace env vars: required environment variables were not set: [SPIKE_X]`, and `run` exits 1 with `Config lint error … lint="(1,1) required environment variables were not set: [SPIKE_X]"`. With `SPIKE_X=hi` in a dotenv file, `blobl -e <file>` and `run --env-file <file>` both exit 0 and give `{"a":"hi"}`. → Classify by message: only `failed to parse mapping: line L char C` is a parse error; an env-var failure is its own error, shown verbatim. Both routes take the AD-9 env file setting.
- Mapping errors name a mapping-relative line in A and C (`failed assignment (line 2)`) and in B's stderr. `bad-input` has the line in C (`failed assignment (line 1)`) but not in A or B.

## Q2. Test runs (CAP-16, entry 4.7)

- Only C does what the panel needs: metadata in (`C/meta-in`), metadata out (`C/meta-out`), a deleted message you can tell apart (`C/deleted` has no output line; `C/empty-string` does), raw input (`C/raw-input`), and multi-line input as one message (`C/multi-line`).
- The config used (`C/<scenario>.request`): `http.enabled: false` (no 4195 bind, spike 1.1 Q6), `logger.level: warn`, `generate` with `count: 1` and `interval: ""` whose mapping is `root = <content as a string literal>` plus `meta <k> = <v>`, then the mapping under test, then `root = if errored() { {"error": error()} } else { {"content": content().string(), "meta": @} }`, and `stdout` with `codec: lines`. The run ends on its own: exit 0 after one message.
- The generated processor must keep the original processor's kind (*by hand*, 4.112.0): with input `{"x":1}`, `root.y = 2` gives `{"y":2}` as a `mapping` and `{"x":1,"y":2}` as a `mutation`. The probe only wrapped code as `mapping`.
- On a parse error the run exits 1 with `Config lint error` and config-relative positions (Q1). The panel should show B's error instead (AD-21).
- Mapping errors also produce a `level=error` stderr log line; stdout carries the `{error}` object, so the panel can ignore stderr unless the exit code is non-zero.
- Risk for entry 4.7: the probe encoded the content with `JSON.stringify` as a Bloblang string literal, which worked for its ASCII inputs. Unicode, control characters and non-UTF-8 bytes were not tested; entry 4.7 should test them or pass the content through a temporary file (`file` input, `to_the_end` scanner).

## Q3. `blobl server` (route A)

- It is available on all three flavors and identical between them. It logs `Serving at: http://localhost:<port>` and a warning to **stderr** (`A/server.stderr`): `<TS> WARNING: This server is intended for local debugging and experimentation purposes, bloblang has the ability to expose environment variables and file contents, do not expose this server to the internet`. SIGINT stops it with exit 0 (`A/server.exit`).
- It ignores `metadata`, returns no output metadata, and returns `result: ""` for both `deleted()` and `root = ""` (the gaps in the research reference also hold on 4.100.0).
- A warm call is about 100× faster than a launch, but it needs a long-lived child, a free port, a readiness wait (a launch takes ~0.2 s, or ~0.43 s through rpk), an HTTP client in the host, restarts after a crash or a binary change, and it leaves an EXPERIMENTAL endpoint on localhost that can read env vars and files for anyone who can reach the port. A one-shot launch is fast enough for a debounced parse (Q4), so the gain doesn't justify that.

## Q4. Latency budget

- Epic Done-when 1 asks for a parse error within about a second. Route B through rpk (worst flavor) has a p95 of 0.42–0.46 s, so a ~300 ms debounce plus one launch stays under a second. Standalone takes about half that.
- A test run is one launch: about 0.2 s standalone and 0.42 s through rpk. A test run that hits a parse error costs a second launch (B) unless the live parse result for the same text is already cached.

## What each route needs from the AD-9 spawn site

`src/adapters/redpandaConnect/process.ts` has two runners, `runProcess` (buffered, timeout) and `runStreaming` (long-lived); both spawn with `stdio: ['ignore', 'pipe', 'pipe']`, `shell: false`, and an env that carries `NO_COLOR=1`.

| Route | Needs |
|---|---|
| A | A long-lived child (`runStreaming` fits) per binary; a free port chosen by the host; a readiness probe; an HTTP client (`fetch`) in the adapter; restarts after a crash or a binary change; a stop on deactivate. stdin can stay `'ignore'`. |
| B (parse) | Nothing new: `runProcess` as it is, with stdin `'ignore'` (closed stdin = parse only) and a temporary mapping file passed with `-f`. Feeding a sample through B would need a stdin option (or `-i <file>`), but the AD doesn't use B for samples. |
| C (test run) | Nothing new: `runProcess` with a timeout and a temporary config file passed to `run`; stdin stays `'ignore'`. No port (`http.enabled: false`). |

Neither proposed route needs a change to the spawn site's stdio or a long-lived Bloblang child.

## Recommendation

| Use | Route | Entries |
|---|---|---|
| Live parse while typing (CAP-15) | **B**, `blobl -f <temp file>`, stdin closed, `-e <env file>`; `failed to parse mapping: line L char C: …` = parse error, any other failure shown verbatim | 4.2 (tracer bullet's parse), 4.5 (diagnostics) |
| Test run (CAP-16) | **C**, `run --env-file <env file> <temp config>` built as in Q2, keeping `mapping` or `mutation`; no output = deleted; a Bloblang parse error in `Config lint error` → show B's parse error, other lint messages verbatim | 4.2 (tracer bullet's run), 4.7 (content, metadata, deleted) |
| Process lifetime | one-shot children only; no `blobl server` | all |
| Positions | B's mapping-relative `line`/`char` and `failed assignment (line N)`, translated by the core position map | 4.3, 4.5, 4.7 |

AD-21 is recorded in the architecture spine. **Approved by the user on 2026-10-12; AD-21 is `[ADOPTED]`.**

## Follow-ups

| Finding | Affects |
|---|---|
| `lint`/`run` Bloblang findings have unreliable columns and lines (config-relative) | AD-12 amendment and lint/Bloblang dedupe, entry 4.5 |
| Content encoding in the generated config is untested beyond ASCII | entry 4.7 |
| `deleted()` is only detectable on route C (absence of output) | entry 4.7, the panel's "deleted" state |
| B's map errors exit 0, parse errors exit 1 | entry 4.5 parser |
| rpk adds ~220 ms per launch | debounce tuning, entry 4.5 |
| Exit 1 is not always a parse error: unset `${VAR}` gives `failed to replace env vars: …` (`blobl`) / `Config lint error … required environment variables were not set` (`run`); classify by message, pass `redpandaConnect.envFile` (`-e` / `--env-file`) to both (*by hand*) | AD-21, entries 4.2, 4.5, 4.7 |
| The test run's processor keeps the original kind: `mutation` keeps input fields (*by hand*) | AD-21, entry 4.7 |
| Done-when 2 and the second-release success signal compare against "the binary's `blobl` result", but the panel's route C differs from `blobl` on multi-line, `deleted()` and bad-input → compare against route C on recorded results (user decision with AD-21) | epic Done-when 2, spec success signal, entries 4.7, 4.12 |
