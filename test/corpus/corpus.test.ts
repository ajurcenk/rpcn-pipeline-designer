// Corpus harness (ticket 1.7): lints every test/corpus/*.yaml with each pinned standalone Redpanda Connect
// binary, using the extension's own argv builder (src/core/args.ts) and spawn site
// (src/adapters/redpandaConnect/process.ts), and compares the result with test/corpus/<name>.lint/<ver>.txt.
//
//   npm run test:corpus          compare (default); never writes
//   npm run test:corpus:record   rewrite every record and delete orphaned ones
//
// Binaries come from scripts/spike/fetch-binaries.sh (.cache/redpanda-connect/<ver>/redpanda-connect).
// A missing binary skips that version locally and fails it in CI (`CI` set) and in record mode.
// The harness itself never touches the network.
//
// Record format:
//   # redpanda-connect <ver> (NO_COLOR=1)
//   # argv: redpanda-connect lint --deprecated --skip-env-var-check <CORPUS>/<name>.yaml
//   # exit: <code>
//   <stderr lines, corpus dir replaced by <CORPUS>/, sorted>
// Lint runs files concurrently, so stderr lines are compared as a sorted set.
//
// Diagnostics parity (ticket 2.6, CAP-14): every record's stderr is also fed through the
// extension's own pure pipeline (src/core/lint.ts: parse, keep the target's findings, map to a
// document line, severity) and must give exactly one diagnostic per recorded line, with the same
// line, message and severity. Needs no binary, so it also runs where the binaries are missing.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLintArgs } from '../../src/core/args';
import { documentLine, findingsForTarget, TargetFindings } from '../../src/core/lint';
import { parseVersionOutput } from '../../src/core/version';
import { readVersion, runProcess } from '../../src/adapters/redpandaConnect/process';

/** Pinned versions; must equal VERSIONS in scripts/spike/fetch-binaries.sh (checked below). */
const VERSIONS = ['4.100.0', '4.112.0'] as const;

/** Resource files passed with `--resources`, as marked in test/corpus/SOURCES.md. */
const RESOURCE_DEPS: Readonly<Record<string, readonly string[]>> = {
	'set_grab_cache.yaml': ['resources.yaml'],
};

const LINT_TIMEOUT_MS = 30_000;
const PLACEHOLDER = '<CORPUS>';

const CORPUS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(CORPUS, '..', '..');
const CACHE = path.join(ROOT, '.cache', 'redpanda-connect');
const FETCH_SCRIPT = path.join(ROOT, 'scripts', 'spike', 'fetch-binaries.sh');

const RECORD = process.env.CORPUS_RECORD === '1';
const IN_CI = !!process.env.CI && process.env.CI !== 'false';

const configs = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.yaml')).sort();

const binaryOf = (ver: string) => path.join(CACHE, ver, 'redpanda-connect');
const recordDirOf = (config: string) => path.join(CORPUS, `${path.basename(config, '.yaml')}.lint`);
const recordOf = (config: string, ver: string) => path.join(recordDirOf(config), `${ver}.txt`);
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

function hasBinary(ver: string): boolean {
	try {
		fs.accessSync(binaryOf(ver), fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Replaces the absolute corpus dir (plus separator) with `<CORPUS>/`. */
function normalize(text: string): string {
	return text.split(CORPUS + path.sep).join(`${PLACEHOLDER}/`);
}

interface LintRecord {
	readonly header: readonly string[];
	readonly lines: readonly string[];
}

function format(record: LintRecord): string {
	return [...record.header, ...record.lines].join('\n') + '\n';
}

function parse(text: string): LintRecord {
	const all = text.split('\n').map((l) => l.replace(/\r$/, ''));
	const header = all.slice(0, 3);
	const lines = all.slice(3).filter((l) => l !== '').sort();
	return { header, lines };
}

async function lint(config: string, ver: string): Promise<LintRecord> {
	const binary = binaryOf(ver);
	const built = buildLintArgs({
		invocation: [binary],
		targets: [path.join(CORPUS, config)],
		resourceFiles: (RESOURCE_DEPS[config] ?? []).map((r) => path.join(CORPUS, r)),
	});
	if (built.kind !== 'ok') {
		throw new Error(`buildLintArgs failed for ${config}: ${JSON.stringify(built)}`);
	}
	const [command, ...args] = built.argv;
	const outcome = await runProcess([command], args, LINT_TIMEOUT_MS);
	if (outcome.kind !== 'exited' || outcome.exitCode === null) {
		throw new Error(`redpanda-connect ${ver}: lint of ${config} did not exit normally: ${JSON.stringify(outcome)}`);
	}
	// Lint exits 0 (clean) or 1 (findings); anything else is a crash and must never become a record.
	if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
		throw new Error(`redpanda-connect ${ver}: lint of ${config} exited ${outcome.exitCode} (expected 0 or 1); ` +
			`stderr:\n${outcome.stderr}`);
	}
	const shownArgv = ['redpanda-connect', ...args].map(normalize).join(' ');
	return {
		header: [`# redpanda-connect ${ver} (NO_COLOR=1)`, `# argv: ${shownArgv}`, `# exit: ${outcome.exitCode}`],
		lines: normalize(outcome.stderr)
			.split('\n')
			.map((l) => l.replace(/\r$/, ''))
			.filter((l) => l !== '')
			.sort(),
	};
}

/** Lines in `a` not matched one-for-one in `b`. */
function minus(a: readonly string[], b: readonly string[]): string[] {
	const rest = [...b];
	return a.filter((line) => {
		const i = rest.indexOf(line);
		if (i < 0) {
			return true;
		}
		rest.splice(i, 1);
		return false;
	});
}

function describeDrift(config: string, ver: string, expected: LintRecord, actual: LintRecord): string | undefined {
	const problems: string[] = [];
	expected.header.forEach((line, i) => {
		if (line !== actual.header[i]) {
			problems.push(`  header: expected "${line}", got "${actual.header[i] ?? ''}"`);
		}
	});
	for (const line of minus(expected.lines, actual.lines)) {
		problems.push(`  - ${line}   (recorded, not produced)`);
	}
	for (const line of minus(actual.lines, expected.lines)) {
		problems.push(`  + ${line}   (produced, not recorded)`);
	}
	if (problems.length === 0) {
		return undefined;
	}
	return [`${config} with redpanda-connect ${ver} differs from ${rel(recordOf(config, ver))}:`, ...problems,
		'If the change is intended, run `npm run test:corpus:record`.'].join('\n');
}

/** Record files with no matching config, or for a version that is not pinned. */
function orphanedRecords(): string[] {
	const orphans: string[] = [];
	for (const entry of fs.readdirSync(CORPUS, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.endsWith('.lint')) {
			continue;
		}
		const dir = path.join(CORPUS, entry.name);
		const config = `${entry.name.slice(0, -'.lint'.length)}.yaml`;
		if (!configs.includes(config)) {
			orphans.push(dir);
			continue;
		}
		for (const file of fs.readdirSync(dir)) {
			if (!VERSIONS.some((v) => file === `${v}.txt`)) {
				orphans.push(path.join(dir, file));
			}
		}
	}
	return orphans.sort();
}

/** `L<line> <severity> <message>` for one diagnostic (1-based line), the unit parity compares. */
const row = (line: number, severity: string, message: string) => `L${line} ${severity} ${message}`;

/**
 * What a record line for `config` must become, read with logic of its own (not the extension's
 * parser), following the rules settled in 2.4: Warning only for `field <name> is deprecated`, and
 * a YAML syntax error reported at (1,1) as `yaml: line N: …` lands on line N. `undefined` when
 * the line is not a finding for `config`.
 */
function expectedRow(recordLine: string, config: string): string | undefined {
	const prefix = `${PLACEHOLDER}/${config}(`;
	if (!recordLine.startsWith(prefix)) {
		return undefined;
	}
	const match = /^(\d+),(\d+)\) (.*)$/.exec(recordLine.slice(prefix.length));
	if (!match) {
		return undefined;
	}
	const message = match[3];
	const syntax = match[1] === '1' ? /^yaml: line ([1-9]\d*):/.exec(message) : null;
	const line = syntax ? Number(syntax[1]) : Number(match[1]);
	return row(line, /^field \S+ is deprecated$/.test(message) ? 'warning' : 'error', message);
}

/**
 * Parity problems between a record's lines and what the extension makes of them; empty when
 * they agree. `parse` is the extension's pipeline (injectable for the checker's self-test).
 */
function parityProblems(
	recordLines: readonly string[],
	target: string,
	lineCount: number,
	parse: (stderr: string, target: string) => TargetFindings = findingsForTarget,
): string[] {
	const stderr = recordLines.map((l) => l.split(`${PLACEHOLDER}/`).join(CORPUS + path.sep)).join('\n');
	const result = parse(stderr, target);
	const problems: string[] = [];
	const expected: string[] = [];
	const config = path.relative(CORPUS, target);
	for (const line of recordLines) {
		const r = expectedRow(line, config);
		if (r) {
			expected.push(r);
		} else {
			problems.push(`  ? ${line}   (record line is not a finding for ${config})`);
		}
	}
	const actual = result.findings.map((f) => row(documentLine(f.line, lineCount) + 1, f.severity, f.message));
	for (const r of minus(expected, actual)) {
		problems.push(`  - ${r}   (recorded, no matching diagnostic)`);
	}
	for (const r of minus(actual, expected)) {
		problems.push(`  + ${r}   (diagnostic, not recorded)`);
	}
	for (const l of result.unparsed) {
		problems.push(`  ! ${l}   (unparsed)`);
	}
	for (const f of result.otherFiles) {
		problems.push(`  ! ${f.path}(${f.line}) ${f.message}   (set aside as another file's)`);
	}
	return problems;
}

/** Lines in a config as VS Code counts them (a trailing newline starts one more, empty, line). */
const lineCountOf = (config: string) => fs.readFileSync(path.join(CORPUS, config), 'utf8').split(/\r\n|\r|\n/).length;

describe('diagnostics parity (recorded lint output → extension diagnostics)', () => {
	for (const ver of VERSIONS) {
		for (const config of configs) {
			it(`${config} @ ${ver}`, () => {
				const recordFile = recordOf(config, ver);
				if (!fs.existsSync(recordFile)) {
					return; // reported by 'every config has a record for each pinned version'
				}
				const record = parse(fs.readFileSync(recordFile, 'utf8'));
				const problems = parityProblems(record.lines, path.join(CORPUS, config), lineCountOf(config));
				expect(problems, [`${config} with redpanda-connect ${ver}: the extension's diagnostics differ from ` +
					`${rel(recordFile)}:`, ...problems].join('\n')).toEqual([]);
			});
		}
	}

	it('the checker reports dropped, mis-lined, re-worded and out-of-file findings', () => {
		const target = path.join(CORPUS, 'x.yaml');
		const lines = [`${PLACEHOLDER}/x.yaml(3,1) field a not recognised`, `${PLACEHOLDER}/x.yaml(5,1) field b is deprecated`];
		expect(parityProblems(lines, target, 10)).toEqual([]);
		const tweak = (change: (r: TargetFindings) => TargetFindings) => (stderr: string, t: string) => change(findingsForTarget(stderr, t));
		const dropped = parityProblems(lines, target, 10, tweak((r) => ({ ...r, findings: r.findings.slice(1) })));
		expect(dropped).toEqual(['  - L3 error field a not recognised   (recorded, no matching diagnostic)']);
		const misLined = parityProblems(lines, target, 10, tweak((r) => ({ ...r, findings: r.findings.map((f) => ({ ...f, line: f.line + 1 })) })));
		expect(misLined).toEqual([
			'  - L3 error field a not recognised   (recorded, no matching diagnostic)',
			'  - L5 warning field b is deprecated   (recorded, no matching diagnostic)',
			'  + L4 error field a not recognised   (diagnostic, not recorded)',
			'  + L6 warning field b is deprecated   (diagnostic, not recorded)',
		]);
		const reworded = parityProblems(lines, target, 10, tweak((r) => ({ ...r, findings: [{ ...r.findings[0], message: 'x' }, r.findings[1]] })));
		expect(reworded).toEqual([
			'  - L3 error field a not recognised   (recorded, no matching diagnostic)',
			'  + L3 error x   (diagnostic, not recorded)',
		]);
		const severity = parityProblems(lines, target, 10, tweak((r) => ({ ...r, findings: r.findings.map((f) => ({ ...f, severity: 'error' as const })) })));
		expect(severity).toContain('  + L5 error field b is deprecated   (diagnostic, not recorded)');
		expect(parityProblems(lines, target, 4)).toContain('  - L5 warning field b is deprecated   (recorded, no matching diagnostic)');
		const aside = parityProblems([`${PLACEHOLDER}/other.yaml(1,1) field a not recognised`, 'panic: x'], target, 10);
		expect(aside.filter((p) => p.startsWith('  !')).length).toBe(2);
		// A filter that wrongly keeps another file's finding is caught on the expected side.
		const keepAll = (stderr: string, t: string) => {
			const r = findingsForTarget(stderr, t);
			return { ...r, findings: [...r.findings, ...r.otherFiles], otherFiles: [] };
		};
		expect(parityProblems([`${PLACEHOLDER}/other.yaml(2,1) field a not recognised`], target, 10, keepAll)).toEqual([
			`  ? ${PLACEHOLDER}/other.yaml(2,1) field a not recognised   (record line is not a finding for x.yaml)`,
			'  + L2 error field a not recognised   (diagnostic, not recorded)',
		]);
		// Settled 2.4 rules: syntax errors move to line N; only `field <name> is deprecated` warns;
		// a `(n,m) ` inside the message does not split it.
		expect(parityProblems([`${PLACEHOLDER}/x.yaml(1,1) yaml: line 7: did not find expected key`,
			`${PLACEHOLDER}/x.yaml(2,1) component foo is deprecated`, `${PLACEHOLDER}/x.yaml(3,1) bad (4,2) thing`], target, 10)).toEqual([]);
	});
});

describe('corpus layout', () => {
	it('pins the same versions as scripts/spike/fetch-binaries.sh', () => {
		const match = /^VERSIONS=\(([^)]*)\)/m.exec(fs.readFileSync(FETCH_SCRIPT, 'utf8'));
		expect(match?.[1].trim().split(/\s+/), 'VERSIONS in fetch-binaries.sh').toEqual([...VERSIONS]);
	});

	it('resource dependencies exist', () => {
		for (const [config, deps] of Object.entries(RESOURCE_DEPS)) {
			for (const file of [config, ...deps]) {
				expect(configs, `RESOURCE_DEPS names ${file}, which is not in test/corpus`).toContain(file);
			}
		}
	});

	if (RECORD) {
		it('removes orphaned records', () => {
			for (const orphan of orphanedRecords()) {
				fs.rmSync(orphan, { recursive: true, force: true });
				console.log(`removed orphaned record ${rel(orphan)}`);
			}
		});
	} else {
		it('every record has its config and a pinned version', () => {
			const orphans = orphanedRecords().map(rel);
			expect(orphans, `orphaned records (no matching .yaml or unpinned version): ${orphans.join(', ')}; ` +
				'delete them or run `npm run test:corpus:record`').toEqual([]);
		});

		it('every config has a record for each pinned version', () => {
			const missing = configs.flatMap((c) => VERSIONS.map((v) => recordOf(c, v)))
				.filter((r) => !fs.existsSync(r)).map(rel);
			expect(missing, `missing records: ${missing.join(', ')}; run \`npm run test:corpus:record\``).toEqual([]);
		});
	}
});

for (const ver of VERSIONS) {
	const present = hasBinary(ver);
	const binaryHint = `${rel(binaryOf(ver))} is missing; run scripts/spike/fetch-binaries.sh`;

	if (!present && !IN_CI && !RECORD) {
		console.warn(`[corpus] skipping redpanda-connect ${ver}: ${binaryHint}`);
		describe.skip(`redpanda-connect ${ver} (skipped: ${binaryHint})`, () => {
			it('lint corpus', () => {});
		});
		continue;
	}

	describe(`redpanda-connect ${ver}`, () => {
		if (!present) {
			it('binary is installed', () => {
				throw new Error(binaryHint);
			});
			return;
		}

		// The record directory names a version; make sure the binary in it really is that version.
		beforeAll(async () => {
			const probe = await readVersion([binaryOf(ver)]);
			const reported = probe.kind === 'exited' ? parseVersionOutput(probe.stdout) : undefined;
			if (reported !== ver) {
				throw new Error(`${rel(binaryOf(ver))} reports version ${reported ?? `<unknown: ${JSON.stringify(probe)}>`}, ` +
					`expected ${ver}; re-run scripts/spike/fetch-binaries.sh`);
			}
		});

		for (const config of configs) {
			it(config, async () => {
				const actual = await lint(config, ver);
				const recordFile = recordOf(config, ver);
				if (RECORD) {
					fs.mkdirSync(path.dirname(recordFile), { recursive: true });
					fs.writeFileSync(recordFile, format(actual));
					return;
				}
				if (!fs.existsSync(recordFile)) {
					throw new Error(`${config} has no record for redpanda-connect ${ver} (${rel(recordFile)}); ` +
						'run `npm run test:corpus:record`');
				}
				const drift = describeDrift(config, ver, parse(fs.readFileSync(recordFile, 'utf8')), actual);
				if (drift) {
					throw new Error(drift);
				}
			});
		}
	});
}
