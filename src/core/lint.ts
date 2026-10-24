// Pure lint output parsing and dedupe (AD-12). `lint` writes one finding per stderr line,
// `<path>(<line>,<col>) <message>`, and exits 1 when it found any (spike 1.1). The column is 1
// for config findings but real for Bloblang errors (`(3,29)`); a finding covers its whole line
// either way. Lint has no severity: `field X is deprecated` (from `--deprecated`) is a warning,
// everything else an error. A YAML syntax error is reported at `(1,1)` as `yaml: line N: …`, and
// N is often where the enclosing block starts, not the bad line. Red Hat owns syntax errors:
// such a finding (`syntax: true`) is hidden while Red Hat reports any, and otherwise shown on
// line N (user decision 2026-10-07, 2.4 review).

import * as path from 'path';

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
	/** The path exactly as lint printed it (the path it was given). */
	readonly path: string;
	/** 1-based line. */
	readonly line: number;
	readonly message: string;
	readonly severity: LintSeverity;
	/** A YAML syntax error (`yaml: …`), owned by Red Hat when it reports one. */
	readonly syntax: boolean;
}

export interface ParsedLint {
	readonly findings: readonly LintFinding[];
	/** Non-blank stderr lines that are not in the finding form. */
	readonly unparsed: readonly string[];
}

/** `<path>(<line>,<col>) <message>`; the path is matched lazily, so the first `(n,m) ` ends it. */
const FINDING = /^(.+?)\((\d+),(\d+)\) (.*)$/;
const DEPRECATED = /^field \S+ is deprecated$/;
const YAML_SYNTAX = /^yaml: /;
const YAML_SYNTAX_LINE = /^yaml: line (\d+):/;

/** `(<line>,<col>) <message>` after a known path. */
const AFTER_PATH = /^\((\d+),(\d+)\) (.*)$/;

/**
 * Parses lint's stderr. Never throws. Lines starting with one of `knownPaths` followed by `(`
 * are split there, so a path that itself contains `(n,m) ` still parses.
 */
export function parseLintOutput(stderr: string, knownPaths: readonly string[] = []): ParsedLint {
	const findings: LintFinding[] = [];
	const unparsed: string[] = [];
	for (const raw of stderr.split(/\r?\n/)) {
		const text = raw.trimEnd();
		if (!text.trim()) {
			continue;
		}
		const split = splitFinding(text, knownPaths);
		if (!split || split.line < 1) {
			unparsed.push(text);
			continue;
		}
		const { message } = split;
		const syntaxLine = split.line === 1 ? YAML_SYNTAX_LINE.exec(message) : null;
		const line = syntaxLine && Number(syntaxLine[1]) >= 1 ? Number(syntaxLine[1]) : split.line;
		findings.push({
			path: split.path, line, message, severity: DEPRECATED.test(message) ? 'warning' : 'error', syntax: YAML_SYNTAX.test(message),
		});
	}
	return { findings, unparsed };
}

function splitFinding(text: string, knownPaths: readonly string[]): { path: string; line: number; message: string } | undefined {
	for (const known of knownPaths) {
		const after = text.startsWith(`${known}(`) ? AFTER_PATH.exec(text.slice(known.length)) : null;
		if (after) {
			return { path: known, line: Number(after[1]), message: after[3] };
		}
	}
	const match = FINDING.exec(text);
	return match ? { path: match[1], line: Number(match[2]), message: match[4] } : undefined;
}

export interface TargetFindings {
	/** Findings whose path is the target (compared after `path.resolve`). */
	readonly findings: readonly LintFinding[];
	/** Findings for any other path (for example a resource file). */
	readonly otherFiles: readonly LintFinding[];
	readonly unparsed: readonly string[];
}

/** Parses lint's stderr for one linted file and splits off what is not about it. */
export function findingsForTarget(stderr: string, target: string): TargetFindings {
	const parsed = parseLintOutput(stderr, [target]);
	const resolved = path.resolve(target);
	const isTarget = (f: LintFinding) => path.resolve(f.path) === resolved;
	return {
		findings: parsed.findings.filter(isTarget),
		otherFiles: parsed.findings.filter((f) => !isTarget(f)),
		unparsed: parsed.unparsed,
	};
}

/** The 0-based document line for a 1-based finding line, clamped to the document. */
export function documentLine(line: number, lineCount: number): number {
	return Math.min(Math.max(line - 1, 0), Math.max(lineCount - 1, 0));
}

/**
 * Drops findings on lines Red Hat already flags (1-based line numbers) and, when Red Hat reports
 * a syntax error anywhere in the file, every syntax finding; keeps order.
 */
export function suppressFlaggedLines(
	findings: readonly LintFinding[],
	flaggedLines: ReadonlySet<number>,
	redHatHasSyntaxError = false,
): LintFinding[] {
	return findings.filter((f) => !flaggedLines.has(f.line) && !(f.syntax && redHatHasSyntaxError));
}

/** A finding held between saves, with its line's text length when lint's result was applied (ticket 10). */
export interface HeldFinding {
	readonly finding: LintFinding;
	/** The length of its line's text (without the line break), to tell an insertion at the line's end. */
	readonly length: number;
}

/** One change of an edit as 0-based line/character positions, in the coordinates of the text before the event. */
export interface LineChange {
	readonly start: { readonly line: number; readonly character: number };
	readonly end: { readonly line: number; readonly character: number };
	readonly text: string;
}

/**
 * Holds a lint result against the text it was taken on: each finding's line is clamped to the
 * document (where it is shown) and carries that line's text length.
 */
export function holdFindings(findings: readonly LintFinding[], lineCount: number, lineLength: (line0: number) => number): HeldFinding[] {
	return findings.map((f) => {
		const line0 = documentLine(f.line, lineCount);
		return { finding: line0 + 1 === f.line ? f : { ...f, line: line0 + 1 }, length: lineLength(line0) };
	});
}

const LEADING_BREAK = /^\r?\n/;

/** Whether a change ending at column 0 of a line leaves that line's text whole (whole lines removed or inserted above it). */
function leavesLineAfterEnd(c: LineChange): boolean {
	return c.text.endsWith('\n') || (c.text === '' && c.start.character === 0);
}

/** Whether `c` changes the text of 0-based `line` (of `length` characters). */
function touches(line: number, length: number, c: LineChange): boolean {
	const empty = c.start.line === c.end.line && c.start.character === c.end.character;
	if ((empty && c.text === '') || c.end.line < line || c.start.line > line) {
		return false;
	}
	if (c.end.line === line && c.end.character === 0 && leavesLineAfterEnd(c)) {
		return false; // whole lines inserted or removed above it
	}
	// New lines started at its end.
	return !(c.start.line === line && c.start.character >= length && LEADING_BREAK.test(c.text));
}

/** Whether `c` lies above 0-based `line` (which it does not touch), so the line moves by its growth in lines. */
function above(line: number, c: LineChange): boolean {
	return c.end.line < line || (c.end.line === line && c.end.character === 0 && leavesLineAfterEnd(c));
}

const breaks = (text: string) => text.split('\n').length - 1;

/**
 * The held findings after an edit's `changes` (all in pre-change coordinates, so their order does
 * not matter): a finding whose line a change touches is dropped, the others move by the lines the
 * changes above them added or removed. Findings stay whole-line: they never move inside a line.
 */
export function shiftFindings(held: readonly HeldFinding[], changes: readonly LineChange[]): HeldFinding[] {
	return held.flatMap((h) => {
		const line = h.finding.line - 1;
		if (changes.some((c) => touches(line, h.length, c))) {
			return [];
		}
		const delta = changes.filter((c) => above(line, c)).reduce((n, c) => n + breaks(c.text) - (c.end.line - c.start.line), 0);
		return [delta === 0 ? h : { finding: { ...h.finding, line: h.finding.line + delta }, length: h.length }];
	});
}
