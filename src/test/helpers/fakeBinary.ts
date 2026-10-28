import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Creates a temp dir for fake binaries; remove it with `fs.rmSync(dir, { recursive: true, force: true })`. */
export function makeTempDir(prefix = 'rpcn-fake-bin-'): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Writes an executable POSIX shell script named `name` into `dir` and returns its path. */
export function writeFakeBinary(dir: string, name: string, body: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	fs.chmodSync(file, 0o755);
	return file;
}

/** Exits 3 unless the child got `NO_COLOR=1` (AD-9). */
const NO_COLOR_CHECK = 'if [ "$NO_COLOR" != "1" ]; then echo "NO_COLOR not set" >&2; exit 3; fi';

/** The `--version` output of Redpanda Connect, printing `Version: <printed>`. */
function versionOutput(printed: string): string[] {
	return [`echo "Version: ${printed}"`, 'echo "Date: 2026-10-02T08:48:17Z"'];
}

/** How a fake checks it was run as `--version`: `redpanda-connect --version` or `rpk connect --version`. */
const STANDALONE_VERSION_ARGS = { test: '$1', expected: '--version' } as const;
const RPK_VERSION_ARGS = { test: '$1 $2', expected: 'connect --version' } as const;

interface VersionProbeOptions {
	/** Appends `run` to this file per run. */
	readonly counterFile?: string;
	readonly sleepSeconds?: number;
	/** Exit 3 unless NO_COLOR=1. Default: true. */
	readonly requireNoColor?: boolean;
}

/**
 * The one builder of `--version` fakes: optional counter and sleep, the argv check (exit 2),
 * the NO_COLOR check, then `output`.
 */
function versionProbeScript(
	args: { readonly test: string; readonly expected: string },
	output: readonly string[],
	options: VersionProbeOptions = {},
): string {
	return [
		options.counterFile ? `echo run >> '${options.counterFile}'` : '',
		options.sleepSeconds ? `sleep ${options.sleepSeconds}` : '',
		`if [ "${args.test}" != "${args.expected}" ]; then echo "unexpected args: $*" >&2; exit 2; fi`,
		options.requireNoColor === false ? '' : NO_COLOR_CHECK,
		...output,
	].filter(Boolean).join('\n');
}

/** A fake `redpanda-connect` printing `Version: <printed>`; with `counterFile`, appends a line per run. */
export function versionScript(printed: string, options: { counterFile?: string; sleepSeconds?: number } = {}): string {
	return versionProbeScript(STANDALONE_VERSION_ARGS, versionOutput(printed), options);
}

/** A fake `redpanda-connect` that prints 4.112.0 `--version` output, but only when NO_COLOR=1. */
export const VERSION_4_112_SCRIPT = versionScript('4.112.0');

/** A fake `rpk` whose `rpk connect --version` prints `Version: <printed>`. */
export function rpkScript(printed: string): string {
	return versionProbeScript(RPK_VERSION_ARGS, versionOutput(printed));
}

/** A fake `rpk` without the managed Redpanda Connect plugin (spike, 2026-10-06): exit 0, hint plus help on stdout. */
export const RPK_NO_PLUGIN_SCRIPT = versionProbeScript(RPK_VERSION_ARGS, [
	'echo "cannot get connect version: rpk connect is not installed; run \'rpk connect install\'"',
	'echo ""',
	'echo "Usage:"',
	'echo "  rpk connect [command]"',
], { requireNoColor: false });

/** Repository root (tests run from `out/test/…`). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const SCHEMA_FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures', 'schema');

export interface ConnectScriptOptions {
	/** Printed by `--version`. */
	readonly version: string;
	/** Shell body run for `list --format jsonschema` (stdout is the schema). Default: an empty schema. */
	readonly jsonschema?: string;
	/** Shell body run for `list --format json-full`. Default: `{}`. */
	readonly jsonFull?: string;
	/** Appends `version`, `jsonschema` or `json-full` per run. */
	readonly counterFile?: string;
	/** Sleeps before answering a `list` call. */
	readonly listSleepSeconds?: number;
	/** Shell body run for `lint …` (the target is the last argument, `$last`). Default: exit 0. */
	readonly lint?: string;
	/** Shell body run for `run …` (the target is `$last`). Default: exit 0. */
	readonly run?: string;
	/** Shell body run for `blobl …` (the `--file` mapping is the last argument, `$last`). Default: exit 0 (it parses). */
	readonly blobl?: string;
	/**
	 * Ticket 30: each `lint`, `run` and `blobl` appends `<command> NAME=<value or <unset>> …` for these
	 * variables of its environment to `file`, before its body.
	 */
	readonly envCapture?: { readonly file: string; readonly names: readonly string[] };
}

/** One line of `ConnectScriptOptions.envCapture`'s file, as the fake binary writes it. */
export function envCaptureLine(command: 'lint' | 'run' | 'blobl', values: Readonly<Record<string, string | undefined>>): string {
	return [command, ...Object.entries(values).map(([name, value]) => `${name}=${value ?? '<unset>'}`)].join(' ');
}

/** A fake `redpanda-connect` answering `--version` and `list --format jsonschema|json-full`, only with NO_COLOR=1. */
export function connectScript(options: ConnectScriptOptions): string {
	const count = (what: string) => (options.counterFile ? `echo ${what} >> '${options.counterFile}'` : ':');
	const sleep = options.listSleepSeconds ? `sleep ${options.listSleepSeconds}` : ':';
	const capture = options.envCapture;
	const env = (what: string) => (capture
		? `echo "${[what, ...capture.names.map((n) => `${n}=\${${n}-<unset>}`)].join(' ')}" >> '${capture.file}'`
		: ':');
	return [
		NO_COLOR_CHECK,
		'case "$*" in',
		'"--version")',
		count('version'),
		...versionOutput(options.version),
		';;',
		'"list --format jsonschema")',
		count('jsonschema'),
		sleep,
		options.jsonschema ?? `echo '{"definitions":{},"properties":{}}'`,
		';;',
		'"list --format json-full")',
		count('json-full'),
		sleep,
		options.jsonFull ?? `echo '{}'`,
		';;',
		'"lint "*)',
		count('lint'),
		env('lint'),
		'for last in "$@"; do :; done',
		options.lint ?? 'exit 0',
		';;',
		'"run "*)',
		count('run'),
		env('run'),
		'for last in "$@"; do :; done',
		options.run ?? 'exit 0',
		';;',
		'"blobl "*)',
		count('blobl'),
		env('blobl'),
		'for last in "$@"; do :; done',
		options.blobl ?? 'exit 0',
		';;',
		'*) echo "unexpected args: $*" >&2; exit 2 ;;',
		'esac',
	].join('\n');
}

/**
 * A `run` body (for `connectScript({ run })`) standing in for the AD-21 test run (ticket 4.2): it
 * copies the config (`$last`) to `<capture>/config.yaml` and appends its argv to `<capture>/argv`,
 * then answers from the config's Bloblang as the real run would print: no line for `deleted()`,
 * `{error}` for a mapping containing `FAIL_ME` (`failed assignment (line 1)`, or of line N for
 * `FAIL_ON_<N>`, 4.8), `{error}` about unstructured input for `NOT_STRUCTURED` (4.8), a lint error on
 * stderr and exit 1 for `BROKEN` while the variable `BROKEN` is unset (not in its environment or any
 * `--env-file`, ticket 32), a Bloblang `Config lint error` with config-relative positions and
 * exit 1 for `ERR@` (4.8: the parse error `bloblParseBody` reports), else
 * a content: `{"a":1,"b":3,"c":4}` for a mapping with `root.c = 4` (FIELDS, 4.7), `{"a":1,"k":<@k>}`
 * for one with `root.k = @k` (META_IN, 4.7), else the content of `root.b = this.a + 1` on `{"a":1}`
 * (`mutation` keeps `a`). Its `meta` (4.7) echoes every `meta "<key>" = "<value>"` line of the
 * input's `generate` mapping, then every `meta <key> = "<value>"` line of the code under test, for
 * keys and values of `[A-Za-z0-9_]`. `SLOW_RUN` sleeps 2 s first. Call before hiding PATH entries.
 */
export function mappingTestRunBody(capture: string): string {
	const grep = toolPath('grep');
	const cp = toolPath('cp');
	const sed = toolPath('sed');
	const sleep = toolPath('sleep');
	return [
		`'${cp}' "$last" '${path.join(capture, 'config.yaml')}'`,
		`printf '%s\\n' "$*" >> '${path.join(capture, 'argv')}'`,
		`if '${grep}' -q 'deleted()' "$last"; then exit 0; fi`,
		`if '${grep}' -q 'ERR@' "$last"; then echo 'level=error msg="Config lint error" lint="'"$last"'(16,24) required: expected fake thing, got: x"' >&2; echo 'level=error msg="shutting down due to linter errors"' >&2; exit 1; fi`,
		`n=$('${sed}' -n 's/.*FAIL_ON_\\([0-9][0-9]*\\).*/\\1/p' "$last" | '${sed}' -n 1p)`,
		`if [ -n "$n" ]; then echo '{"error":"failed assignment (line '"$n"'): expected number value, got null from field \`this.nope\`"}'; exit 0; fi`,
		`if '${grep}' -q 'FAIL_ME' "$last"; then echo '{"error":"failed assignment (line 1): fake failure"}'; exit 0; fi`,
		`if '${grep}' -q 'NOT_STRUCTURED' "$last"; then echo '{"error":"failed assignment (line 1): unable to reference message as structured (with '"'"'this'"'"'): parse as json: invalid character '"'"'o'"'"' in literal null (expecting '"'"'u'"'"')"}'; exit 0; fi`,
		// BROKEN is set when it is in the environment (a secret) or in an `--env-file` (ticket 32: the plain setting's).
		'broken=${BROKEN+set}; prev=; for a in "$@"; do if [ "$prev" = --env-file ] && ' + `'${grep}' -q '^BROKEN=' "$a"; then broken=set; fi; prev=$a; done`,
		`if [ -z "$broken" ] && '${grep}' -q 'BROKEN' "$last"; then echo 'level=error msg="Config lint error" lint="(1,1) required environment variables were not set: [BROKEN]"' >&2; exit 1; fi`,
		`if '${grep}' -q 'SLOW_RUN' "$last"; then '${sleep}' 2; fi`,
		// The config's YAML escapes each `"` of a Bloblang literal as `\"`.
		String.raw`meta=$('${grep}' -o 'meta \(\\"\)\{0,1\}[A-Za-z0-9_]*\(\\"\)\{0,1\} = \\"[A-Za-z0-9_]*\\"' "$last"`
			+ String.raw` | '${sed}' -e 's/^meta \(\\"\)\{0,1\}\([A-Za-z0-9_]*\)\(\\"\)\{0,1\} = \\"\([A-Za-z0-9_]*\)\\"$/"\2":"\4"/'`
			+ String.raw` | '${sed}' -e ':a' -e 'N' -e '$!ba' -e 's/\n/,/g')`,
		String.raw`k=$('${grep}' -o 'meta \\"k\\" = \\"[A-Za-z0-9_]*\\"' "$last" | '${sed}' -e 's/.* = \\"\(.*\)\\"$/\1/')`,
		String.raw`if '${grep}' -q 'root.c = 4' "$last"; then content='{\"a\":1,\"b\":3,\"c\":4}';`
			+ String.raw` elif '${grep}' -q 'root.k = @k' "$last"; then content="{\\\"a\\\":1,\\\"k\\\":\\\"$k\\\"}";`
			+ String.raw` elif '${grep}' -q -- '- mutation:' "$last"; then content='{\"a\":1,\"b\":2}'; else content='{\"b\":2}'; fi`,
		`printf '{"content":"%s","meta":{%s}}\\n' "$content" "$meta"`,
	].join('\n');
}

/**
 * A `blobl` body (for `connectScript({ blobl })`) standing in for the AD-21 live parse (ticket
 * 4.5): it appends its argv to `<capture>/blobl-argv`, then answers from the mapping file
 * (`$last`) as `blobl --file` with stdin closed would: `SLOW` sleeps 1 s first; `UNSET` fails as an
 * unset `${UNSET}` does (exit 1); `ERR@<line>:<char>` is a parse error at that mapping-relative
 * position, with a caret excerpt (exit 1); anything else parses (exit 0, no output). Call before
 * hiding PATH entries.
 */
export function bloblParseBody(capture: string): string {
	const grep = toolPath('grep');
	const sed = toolPath('sed');
	const sleep = toolPath('sleep');
	return [
		`printf '%s\\n' "$*" >> '${path.join(capture, 'blobl-argv')}'`,
		`if '${grep}' -q 'SLOW' "$last"; then '${sleep}' 1; fi`,
		`if '${grep}' -q 'UNSET' "$last"; then echo 'failed to replace env vars: required environment variables were not set: [UNSET]' >&2; exit 1; fi`,
		`at=$('${sed}' -n 's/.*ERR@\\([0-9][0-9]*\\):\\([0-9][0-9]*\\).*/\\1 char \\2/p' "$last" | '${sed}' -n 1p)`,
		'if [ -n "$at" ]; then',
		'  echo "failed to parse mapping: line $at: expected fake thing" >&2',
		`  echo '  |' >&2`,
		`  echo '1 | fake excerpt' >&2`,
		`  echo '  |  ^---' >&2`,
		'  exit 1',
		'fi',
		'exit 0',
	].join('\n');
}

/**
 * The absolute path of `tool` on the current `PATH` (bare `tool` when not found). Fakes call
 * tools by absolute path, so they keep working when a test hides PATH directories that hold a
 * real `rpk` or `redpanda-connect` (often `/usr/bin`, where `cat` and `gzip` live too).
 */
export function toolPath(tool: string): string {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		const candidate = dir && path.join(dir, tool);
		if (candidate && fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return tool;
}

/** Shell bodies printing the recorded spike fixtures for `version` (4.100.0 or 4.112.0). Call before hiding PATH entries. */
export function fixtureBodies(version: string): { jsonschema: string; jsonFull: string } {
	return {
		jsonschema: `'${toolPath('cat')}' '${path.join(SCHEMA_FIXTURES, `jsonschema-${version}.json`)}'`,
		jsonFull: `'${toolPath('gzip')}' -dc '${path.join(SCHEMA_FIXTURES, `json-full-${version}.json.gz`)}'`,
	};
}

/** Lines appended to a counter file (empty when it does not exist). */
export function readCounter(file: string): string[] {
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}
