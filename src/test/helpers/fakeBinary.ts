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

/** A fake `redpanda-connect` that prints 4.112.0 `--version` output, but only when NO_COLOR=1. */
export const VERSION_4_112_SCRIPT = [
	'if [ "$1" != "--version" ]; then echo "unexpected args: $*" >&2; exit 2; fi',
	'if [ "$NO_COLOR" != "1" ]; then echo "NO_COLOR not set" >&2; exit 3; fi',
	'echo "Version: 4.112.0"',
	'echo "Date: 2026-10-02T08:48:17Z"',
].join('\n');

/** A fake `redpanda-connect` printing `Version: <printed>`; with `counterFile`, appends a line per run. */
export function versionScript(printed: string, options: { counterFile?: string; sleepSeconds?: number } = {}): string {
	return [
		options.counterFile ? `echo run >> '${options.counterFile}'` : '',
		options.sleepSeconds ? `sleep ${options.sleepSeconds}` : '',
		'if [ "$1" != "--version" ]; then echo "unexpected args: $*" >&2; exit 2; fi',
		'if [ "$NO_COLOR" != "1" ]; then echo "NO_COLOR not set" >&2; exit 3; fi',
		`echo "Version: ${printed}"`,
		'echo "Date: 2026-10-02T08:48:17Z"',
	].filter(Boolean).join('\n');
}

/** A fake `rpk` whose `rpk connect --version` prints `Version: <printed>`. */
export function rpkScript(printed: string): string {
	return [
		'if [ "$1 $2" != "connect --version" ]; then echo "unexpected args: $*" >&2; exit 2; fi',
		'if [ "$NO_COLOR" != "1" ]; then echo "NO_COLOR not set" >&2; exit 3; fi',
		`echo "Version: ${printed}"`,
		'echo "Date: 2026-10-02T08:48:17Z"',
	].join('\n');
}

/** A fake `rpk` without the managed Redpanda Connect plugin (spike, 2026-10-06): exit 0, hint plus help on stdout. */
export const RPK_NO_PLUGIN_SCRIPT = [
	'if [ "$1 $2" != "connect --version" ]; then echo "unexpected args: $*" >&2; exit 2; fi',
	'echo "cannot get connect version: rpk connect is not installed; run \'rpk connect install\'"',
	'echo ""',
	'echo "Usage:"',
	'echo "  rpk connect [command]"',
].join('\n');

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
		'if [ "$NO_COLOR" != "1" ]; then echo "NO_COLOR not set" >&2; exit 3; fi',
		'case "$*" in',
		'"--version")',
		count('version'),
		`echo "Version: ${options.version}"`,
		'echo "Date: 2026-10-02T08:48:17Z"',
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

/** Shell bodies printing the recorded spike fixtures for `version` (4.100.0 or 4.112.0). */
export function fixtureBodies(version: string): { jsonschema: string; jsonFull: string } {
	return {
		jsonschema: `cat '${path.join(SCHEMA_FIXTURES, `jsonschema-${version}.json`)}'`,
		jsonFull: `gzip -dc '${path.join(SCHEMA_FIXTURES, `json-full-${version}.json.gz`)}'`,
	};
}

/** Lines appended to a counter file (empty when it does not exist). */
export function readCounter(file: string): string[] {
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}
