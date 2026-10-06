// Pure parser for `redpanda-connect --version` / `rpk connect --version` output.
// Expected stdout (spike 1.1, Q7):
//   Version: 4.112.0
//   Date: 2026-10-02T08:48:17Z

const VERSION_LINE = /^Version: (\S+)$/;

/** Returns the version token from `--version` stdout, or `undefined` if no `Version:` line is present. */
export function parseVersionOutput(stdout: string): string | undefined {
	for (const line of stdout.split(/\r?\n/)) {
		const match = VERSION_LINE.exec(line);
		if (match) {
			return match[1];
		}
	}
	return undefined;
}
