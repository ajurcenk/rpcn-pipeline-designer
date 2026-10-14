// The AD-21 test run, pure (tickets 4.2, 4.7, 4.8): the one-message `run` config for a mapping or mutation,
// a content and its metadata, and the reading of what the run printed. The adapter
// (`src/adapters/redpandaConnect/bloblang.ts`) writes the config to a temporary file and runs it.
//
// The config (spike 4.1 Q2): no HTTP server, warn-level logs, a `generate` input that emits the
// content once (`count: 1`, `interval: ""`) with the input metadata set, the code under test with its own kind, then a last
// `mapping` that turns the message into one JSON line, `{content, meta}` or `{error}`, on `stdout`.
// Every string is written as a YAML double-quoted scalar with all but printable ASCII escaped, so
// any text survives the YAML reader. The content and each metadata key and value are also Bloblang
// string literals (Go's `strconv.Unquote` reads JSON escapes) and have their `$` escaped in the YAML, so that the binary's
// `${VAR}` substitution, which runs on the raw config text, never touches it; the code under test
// keeps its `${VAR}`s, which are substituted as in Run.

import type {
	BloblangChanges, BloblangProcessorKind, BloblangResult, InputMeta, JsonValue, KeyChanges, ResultMeta,
} from '../shared/bloblangProtocol';

/** The last step: one JSON line per message, its content and metadata, or the mapping's error. */
export const RESULT_MAPPING = 'root = if errored() { {"error": error()} } else { {"content": content().string(), "meta": @} }';

/** How many stderr lines an `error` result keeps. */
export const MAX_ERROR_LINES = 20;

/**
 * The text of the YAML config that runs `source` (as a `kind` processor) once on `content`, with
 * `meta` set on the message: one `meta "<key>" = "<value>"` line per entry after `root = …` in the
 * `generate` mapping (ticket 4.7), key and value as Bloblang string literals.
 */
export function testConfig(kind: BloblangProcessorKind, source: string, content: string, meta: InputMeta): string {
	const generate = [
		`root = ${bloblangString(content)}`,
		...Object.keys(meta).map((key) => `meta ${bloblangString(key)} = ${bloblangString(meta[key] ?? '')}`),
	].join('\n');
	return [
		'http:',
		'  enabled: false',
		'logger:',
		'  level: warn',
		'input:',
		'  generate:',
		'    count: 1',
		'    interval: ""',
		`    mapping: ${yamlQuoted(generate, true)}`,
		'pipeline:',
		'  processors:',
		`    - ${kind}: ${yamlQuoted(source, false)}`,
		`    - mapping: ${yamlQuoted(RESULT_MAPPING, false)}`,
		'output:',
		'  stdout:',
		'    codec: lines',
		'',
	].join('\n');
}

/**
 * `text` as a Bloblang double-quoted string literal: JSON's escapes, which Go's `strconv.Unquote`
 * reads the same. A lone surrogate (no UTF-8 for it) becomes U+FFFD.
 */
export function bloblangString(text: string): string {
	return JSON.stringify(text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�'));
}

/**
 * `text` as a YAML double-quoted scalar: printable ASCII as is (but `"` and `\`), everything else
 * as `\xXX`, `\uXXXX` or `\UXXXXXXXX`; with `escapeDollar`, `$` too, out of reach of `${VAR}` substitution.
 */
export function yamlQuoted(text: string, escapeDollar: boolean): string {
	let out = '"';
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0xFFFD;
		if (ch === '"' || ch === '\\') {
			out += `\\${ch}`;
		} else if (ch === '$' && escapeDollar) {
			out += '\\x24';
		} else if (code >= 0x20 && code < 0x7F) {
			out += ch;
		} else if (code < 0x100) {
			out += `\\x${hex(code, 2)}`;
		} else if (code >= 0xD800 && code <= 0xDFFF) {
			out += '\\uFFFD';
		} else if (code < 0x10000) {
			out += `\\u${hex(code, 4)}`;
		} else {
			out += `\\U${hex(code, 8)}`;
		}
	}
	return `${out}"`;
}

function hex(code: number, width: number): string {
	return code.toString(16).toUpperCase().padStart(width, '0');
}

/** The input a run was given: the message content and the metadata the `generate` input set. */
export interface RunInput {
	readonly content: string;
	readonly meta: InputMeta;
}

/** A run that stopped on `Config lint error` (exit 1): maybe a Bloblang parse error, which the adapter asks `blobl` about (AD-21). */
export interface RunLintOutcome {
	readonly kind: 'lint';
	/** The first stderr lines, verbatim (the result's message when it is not a parse error). */
	readonly message: string;
}

/** What `parseRunOutput` reads: a result, or a lint stop for the adapter to classify. */
export type RunOutcome = BloblangResult | RunLintOutcome;

/** The binary's marker of a run stopped by the config linter (spike 4.1 Q1). */
export const CONFIG_LINT_ERROR = 'Config lint error';
/** An `{error}` that names its mapping line: `failed assignment (line N): …`. */
const FAILED_ASSIGNMENT = /^failed assignment \(line (\d+)\)/;
/** An `{error}` about an input the mapping cannot read as structured data (spike 4.1, bad-input). */
export const INVALID_INPUT_MARKER = 'unable to reference message as structured';

/**
 * What a run's exit and output mean (AD-21, tickets 4.2, 4.7, 4.8): exit 0 with a JSON line is
 * `ok` (its content and metadata, and what changed from `input`), `invalidInput` (an `{error}` about
 * an input that is not structured) or `failed` (any other `{error}`, with its `mappingLine` when it
 * starts `failed assignment (line N)`; the file line is the adapter's); exit 0 with no line is
 * `deleted`; exit 1 with `Config lint error` on stderr is `lint` (the adapter decides whether it is
 * a parse error); any other exit (or a signal, `null`) is `error`, with the first stderr lines
 * verbatim.
 */
export function parseRunOutput(exitCode: number | null, stdout: string, stderr: string, input: RunInput): RunOutcome {
	if (exitCode !== 0) {
		const lines = stderr.split(/\r?\n/).filter((l) => l.trim() !== '');
		if (lines.length > 0) {
			const message = lines.slice(0, MAX_ERROR_LINES).join('\n');
			return exitCode === 1 && stderr.includes(CONFIG_LINT_ERROR) ? { kind: 'lint', message } : { kind: 'error', message };
		}
		return { kind: 'error', message: exitCode === null ? 'Redpanda Connect was stopped by a signal.' : `Redpanda Connect exited with code ${exitCode}.` };
	}
	const line = stdout.split(/\r?\n/).find((l) => l.trim() !== '');
	if (line === undefined) {
		return { kind: 'deleted' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { kind: 'error', message: `Unexpected output: ${line}` };
	}
	if (isJsonObject(parsed)) {
		if (typeof parsed.error === 'string') {
			return failureOf(parsed.error);
		}
		if (typeof parsed.content === 'string') {
			// An empty key is not metadata the panel can show or set; it is dropped.
			const meta: ResultMeta = isJsonObject(parsed.meta)
				? Object.fromEntries(Object.entries(parsed.meta).filter(([key]) => key !== ''))
				: {};
			return { kind: 'ok', content: parsed.content, meta, changes: changesOf(input.content, parsed.content, input.meta, meta) };
		}
	}
	return { kind: 'error', message: `Unexpected output: ${line}` };
}

/** An `{error}` line's result: `invalidInput`, or `failed` with the mapping line it names, if any. */
function failureOf(message: string): BloblangResult {
	if (message.includes(INVALID_INPUT_MARKER)) {
		return { kind: 'invalidInput', message };
	}
	const line = Number(FAILED_ASSIGNMENT.exec(message)?.[1] ?? 0);
	return line >= 1 ? { kind: 'failed', message, mappingLine: line } : { kind: 'failed', message };
}

/**
 * What a run changed, top-level keys only: the content's fields when the input and the output both
 * parse as JSON objects (else `null`), and the metadata. `added` and `changed` follow the output's
 * key order, `removed` the input's; a key whose value is deeply equal is unchanged.
 */
export function changesOf(input: string, outputContent: string, inputMeta: Readonly<Record<string, JsonValue>>, outputMeta: ResultMeta): BloblangChanges {
	const before = jsonObjectOf(input);
	const after = jsonObjectOf(outputContent);
	return {
		fields: before && after ? keyChanges(before, after) : null,
		meta: keyChanges(inputMeta, outputMeta),
	};
}

function keyChanges(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): KeyChanges {
	const has = (o: Readonly<Record<string, unknown>>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
	const added: string[] = [];
	const changed: string[] = [];
	for (const key of Object.keys(after)) {
		if (!has(before, key)) {
			added.push(key);
		} else if (!jsonEqual(before[key], after[key])) {
			changed.push(key);
		}
	}
	return { added, changed, removed: Object.keys(before).filter((key) => !has(after, key)) };
}

function isJsonObject(v: unknown): v is Record<string, JsonValue> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonObjectOf(text: string): Record<string, JsonValue> | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Deep equality of two values parsed from JSON (object key order does not matter). */
function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
	}
	if (!isJsonObject(a) || !isJsonObject(b)) {
		return false;
	}
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length
		&& keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
}
