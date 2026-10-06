// Pure detection predicate (AD-18): is this YAML text a Redpanda Connect config? Only the
// DetectionRegistry (`src/adapters/vscode/detection.ts`) calls it.
//
// Minimal form (ticket 2.1): the text has one of the top-level keys below in any of its YAML
// documents. A top-level key is a block-mapping key at column 0, plain or quoted, followed by
// `:` and a space, a comment or the end of the line. File patterns and resource-file lists
// are ticket 2.2. The scan is line-based (no YAML parser), so it has known misses and false
// positives. Missed: a flow mapping at the top level (`{input: …}`). False positives: a
// column-0 `input:` line inside a multi-line quoted scalar, or inside a document-level block
// scalar (`--- |`), detects a document that is not a config. A block scalar under a key cannot
// hold a column-0 line, so it is safe.

/** Top-level keys that make a document a Redpanda Connect config (or resource file). */
export const DETECTION_KEYS: readonly string[] = [
	'input',
	'pipeline',
	'output',
	'buffer',
	'cache_resources',
	'rate_limit_resources',
	'processor_resources',
	'input_resources',
	'output_resources',
];

const KEY_SET = new Set(DETECTION_KEYS);

/** `key:`, `"key":` or `'key':` at column 0, then whitespace, a comment or the end of the line. */
const TOP_LEVEL_KEY = /^(?:([A-Za-z_][\w-]*)|"([^"\\]*)"|'([^']*)')[ \t]*:(?:[ \t]|$)/;

/** True when `text` has a top-level Redpanda Connect key (`input`, `pipeline`, `output`, …). */
export function isRedpandaConnectConfig(text: string): boolean {
	for (const line of text.split(/\r?\n/)) {
		const match = TOP_LEVEL_KEY.exec(line);
		if (!match) {
			continue;
		}
		const key = match[1] ?? match[2] ?? match[3];
		if (KEY_SET.has(key)) {
			return true;
		}
	}
	return false;
}
