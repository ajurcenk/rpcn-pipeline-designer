// The AD-21 test run, pure (ticket 4.2): the one-message `run` config for a mapping or mutation and
// a content, and the reading of what the run printed. The adapter
// (`src/adapters/redpandaConnect/bloblang.ts`) writes the config to a temporary file and runs it.
//
// The config (spike 4.1 Q2): no HTTP server, warn-level logs, a `generate` input that emits the
// content once (`count: 1`, `interval: ""`), the code under test with its own kind, then a last
// `mapping` that turns the message into one JSON line, `{content, meta}` or `{error}`, on `stdout`.
// Every string is written as a YAML double-quoted scalar with all but printable ASCII escaped, so
// any text survives the YAML reader. The content is also a Bloblang string literal (Go's
// `strconv.Unquote` reads JSON escapes) and has its `$` escaped in the YAML, so that the binary's
// `${VAR}` substitution, which runs on the raw config text, never touches it; the code under test
// keeps its `${VAR}`s, which are substituted as in Run.

import type { BloblangProcessorKind, BloblangResult } from '../shared/bloblangProtocol';

/** The last step: one JSON line per message, its content and metadata, or the mapping's error. */
export const RESULT_MAPPING = 'root = if errored() { {"error": error()} } else { {"content": content().string(), "meta": @} }';

/** How many stderr lines an `error` result keeps. */
export const MAX_ERROR_LINES = 20;

/** The text of the YAML config that runs `source` (as a `kind` processor) once on `content`. */
export function testConfig(kind: BloblangProcessorKind, source: string, content: string): string {
	return [
		'http:',
		'  enabled: false',
		'logger:',
		'  level: warn',
		'input:',
		'  generate:',
		'    count: 1',
		'    interval: ""',
		`    mapping: ${yamlQuoted(`root = ${bloblangString(content)}`, true)}`,
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

/**
 * What a run's exit and output mean (AD-21): exit 0 with a JSON line is `ok` (its content) or
 * `failed` (the mapping's error); exit 0 with no line is `deleted`; any other exit (or a signal,
 * `null`) is `error`, with the first stderr lines verbatim.
 */
export function parseRunOutput(exitCode: number | null, stdout: string, stderr: string): BloblangResult {
	if (exitCode !== 0) {
		const lines = stderr.split(/\r?\n/).filter((l) => l.trim() !== '');
		if (lines.length > 0) {
			return { kind: 'error', message: lines.slice(0, MAX_ERROR_LINES).join('\n') };
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
	if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
		const record = parsed as Record<string, unknown>;
		if (typeof record.error === 'string') {
			return { kind: 'failed', message: record.error };
		}
		if (typeof record.content === 'string') {
			return { kind: 'ok', content: record.content };
		}
	}
	return { kind: 'error', message: `Unexpected output: ${line}` };
}
