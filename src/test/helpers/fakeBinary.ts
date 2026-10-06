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
}

/** A fake `redpanda-connect` answering `--version` and `list --format jsonschema|json-full`, only with NO_COLOR=1. */
export function connectScript(options: ConnectScriptOptions): string {
	const count = (what: string) => (options.counterFile ? `echo ${what} >> '${options.counterFile}'` : ':');
	const sleep = options.listSleepSeconds ? `sleep ${options.listSleepSeconds}` : ':';
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
		'*) echo "unexpected args: $*" >&2; exit 2 ;;',
		'esac',
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
