// The corpus harness's own copy of the AD-21 one-message pipeline (ticket 4.12, the spike's route C),
// written from AD-21's text and not from `src/core/bloblangRun.ts` (`testConfig`), so a record made
// with it checks the extension's config builder instead of repeating it. Also the harness's own
// `blobl -f` parse (route B, stdin closed) and its reading of what `blobl` printed.
//
// The config: no HTTP server, warn-level logs, a `generate` input that emits the content once with
// the sample's metadata set, the code under test as the only user processor with its own kind
// (`mapping` or `mutation`), then a `mapping` that writes one JSON line, `{content, meta}` or
// `{error}`, to `stdout`. Every string is a JSON string, which YAML reads as a double-quoted
// scalar. The content and the metadata are Bloblang string literals too (JSON strings again), with
// `$` written `\u0024` (a JSON escape) so the binary's `${VAR}` substitution, which runs on the raw text, never
// touches them; the code under test keeps its `$`s, as in the extension.

import * as fs from 'fs';
import * as path from 'path';
import { runProcess } from '../../src/adapters/redpandaConnect/process';

export const REFERENCE_TIMEOUT_MS = 30_000;

/** The last step, from AD-21: one JSON line per message, its content and metadata, or the error. */
const RESULT_STEP = 'root = if errored() { {"error": error()} } else { {"content": content().string(), "meta": @} }';

/** `text` as a JSON string whose `$`s are written `\u0024` (YAML and Bloblang both read it back as `$`). */
const quoted = (text: string, hideDollar: boolean) => {
	const json = JSON.stringify(text);
	return hideDollar ? json.split('$').join('\\u0024') : json;
};

/** The reference config text that runs `source` as a `kind` processor once on `content` with `meta`. */
export function referenceConfig(kind: 'mapping' | 'mutation', source: string, content: string, meta: Readonly<Record<string, string>>): string {
	const generate = [`root = ${JSON.stringify(content)}`, ...Object.entries(meta).map(([k, v]) => `meta ${JSON.stringify(k)} = ${JSON.stringify(v)}`)].join('\n');
	return [
		'http:',
		'  enabled: false',
		'logger:',
		'  level: warn',
		'input:',
		'  generate:',
		'    count: 1',
		'    interval: ""',
		`    mapping: ${quoted(generate, true)}`,
		'pipeline:',
		'  processors:',
		`    - ${kind}: ${quoted(source, false)}`,
		`    - mapping: ${quoted(RESULT_STEP, false)}`,
		'output:',
		'  stdout:',
		'    codec: lines',
		'',
	].join('\n');
}

/** What a reference child printed: the exit code and the raw output. */
export interface ReferenceOutput {
	readonly exit: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

async function spawn(binary: string, args: readonly string[], dir: string): Promise<ReferenceOutput> {
	const outcome = await runProcess([binary], args, REFERENCE_TIMEOUT_MS, { cwd: dir });
	if (outcome.kind !== 'exited') {
		throw new Error(`${path.basename(binary)} ${args.join(' ')} did not exit normally: ${JSON.stringify(outcome)}`);
	}
	return { exit: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr };
}

/** Runs the reference pipeline with `binary` (`run <config>`), the config written in `dir`. */
export async function referenceRun(
	binary: string, dir: string, kind: 'mapping' | 'mutation', source: string, content: string, meta: Readonly<Record<string, string>>,
): Promise<ReferenceOutput> {
	const file = path.join(dir, 'reference.yaml');
	fs.writeFileSync(file, referenceConfig(kind, source, content, meta));
	try {
		return await spawn(binary, ['run', file], dir);
	} finally {
		fs.rmSync(file, { force: true });
	}
}

/** Parses `source` with `binary`'s `blobl -f <file>` (stdin closed: nothing is mapped), the file written in `dir`. */
export async function referenceParse(binary: string, dir: string, source: string): Promise<ReferenceOutput> {
	const file = path.join(dir, 'reference.blobl');
	fs.writeFileSync(file, source);
	try {
		return await spawn(binary, ['blobl', '-f', file], dir);
	} finally {
		fs.rmSync(file, { force: true });
	}
}

/**
 * A `blobl` parse error as the harness reads it, from `blobl`'s documented output (spike 4.1 Q1):
 * the first non-empty stderr line is `failed to parse mapping: line L char C:` and the message (the
 * space after the colon is optional); the message continues on the following lines up to the caret
 * excerpt (lines like `  |`, `3 | root.c = 3`); an empty message reads `Bloblang parse error.`.
 */
export interface BloblParseError {
	readonly line: number;
	readonly char: number;
	/** The message, without the prefix, continuation lines included. */
	readonly message: string;
}

/** The parse error in `blobl`'s stderr, if its first non-empty line starts one. */
export function bloblParseError(stderr: string): BloblParseError | undefined {
	const lines = stderr.split('\n').map((l) => l.replace(/\r$/, ''));
	const start = lines.findIndex((l) => l.trim() !== '');
	const head = start < 0 ? null : /^failed to parse mapping: line ([0-9]+) char ([0-9]+):(.*)$/.exec(lines[start].trim());
	if (!head) {
		return undefined;
	}
	const message = [head[3].replace(/^ /, '')];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*[0-9]*\s*\|/.test(line)) {
			break;
		}
		message.push(line);
	}
	return { line: Number(head[1]), char: Number(head[2]), message: message.join('\n').trim() || 'Bloblang parse error.' };
}

/**
 * The lint findings of a run stopped by the linter, as the harness reads `run`'s logfmt stderr:
 * from each `msg="Config lint error"` line, its `lint="…"` value unescaped, without the config
 * position it starts with (`<path>(L,C) ` or `(L,C) `). No timestamp and no path is kept.
 */
export function lintFindings(stderr: string): string[] {
	const findings: string[] = [];
	for (const line of stderr.split('\n')) {
		if (!line.includes('msg="Config lint error"')) {
			continue;
		}
		const value = /\blint="((?:[^"\\]|\\.)*)"/.exec(line);
		if (!value) {
			continue;
		}
		const text = value[1].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
		for (const finding of text.split('\n').filter((f) => f.trim() !== '')) {
			findings.push(finding.replace(/^.*?\([0-9]+,[0-9]+\) /, ''));
		}
	}
	return findings;
}

/** A syntax-broken variant of `source`: ` +` on a new last line (every corpus mapping parses). */
export function brokenVariant(source: string): string {
	return `${source.endsWith('\n') ? source : `${source}\n`} +`;
}
