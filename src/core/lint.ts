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
