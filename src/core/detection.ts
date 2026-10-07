// Pure detection predicate (AD-18): is this YAML text a Redpanda Connect config? Only the
// DetectionRegistry (`src/adapters/vscode/detection.ts`) calls it.
//
// A YAML document is a config when it has one of the top-level keys below and is not a
// template (top-level `name`, `type` and `mapping`); documents are split on column-0 `---` /
// `...` markers. A top-level key is a block-mapping key at column 0, plain or quoted, followed
// by `:` and a space, a comment or the end of the line. A `redpandaConnect.filePatterns` match
// overrides the text (`detect`); the matching itself is the registry's. Resource files are
// never collected for `--resources` (AD-9). The scan is line-based (no YAML parser), so it has
// known misses and false positives. Missed: a flow mapping at the top level (`{input: …}`).
// False positives: a column-0 `input:` line inside a multi-line quoted scalar, or inside a
// document-level block scalar (`--- |`), detects a document that is not a config. A block
// scalar under a key cannot hold a column-0 line, so it is safe.

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

/** Top-level keys that, all present in one YAML document, make it a template (not a config). */
export const TEMPLATE_KEYS: readonly string[] = ['name', 'type', 'mapping'];

/** A column-0 document marker (`---` or `...`), alone or followed by whitespace. */
const DOCUMENT_MARKER = /^(?:---|\.\.\.)(?:[ \t]|$)/;

/** The top-level keys of each YAML document in `text`, in order. */
export function topLevelKeysByDocument(text: string): Set<string>[] {
	const documents: Set<string>[] = [new Set()];
	for (const line of text.split(/\r?\n/)) {
		if (DOCUMENT_MARKER.test(line)) {
			documents.push(new Set());
			continue;
		}
		const match = TOP_LEVEL_KEY.exec(line);
		if (match) {
			documents[documents.length - 1].add(match[1] ?? match[2] ?? match[3]);
		}
	}
	return documents.filter((keys) => keys.size > 0);
}

function isTemplate(keys: Set<string>): boolean {
	return TEMPLATE_KEYS.every((key) => keys.has(key));
}

/**
 * True when some YAML document in `text` has a top-level Redpanda Connect key (`input`,
 * `pipeline`, `output`, …) and that same document is not a template (top-level `name`, `type`
 * and `mapping`).
 */
export function isRedpandaConnectConfig(text: string): boolean {
	return topLevelKeysByDocument(text).some(
		(keys) => !isTemplate(keys) && [...keys].some((key) => KEY_SET.has(key)),
	);
}

/**
 * The full detection rule (AD-18): a file matched by `redpandaConnect.filePatterns` is always
 * detected, templates included; otherwise the text decides (`isRedpandaConnectConfig`).
 */
export function detect(text: string, matchedByPattern: boolean): boolean {
	return matchedByPattern || isRedpandaConnectConfig(text);
}
