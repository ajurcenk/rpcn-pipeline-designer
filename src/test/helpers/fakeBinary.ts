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
