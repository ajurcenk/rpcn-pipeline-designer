// Corpus harness (ticket 1.7): lints every test/corpus/*.yaml with each pinned standalone Redpanda Connect
// binary, using the extension's own argv builder (src/core/args.ts) and spawn site
// (src/adapters/redpandaConnect/version.ts), and compares the result with test/corpus/<name>.lint/<ver>.txt.
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

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLintArgs } from '../../src/core/args';
import { parseVersionOutput } from '../../src/core/version';
import { readVersion, runProcess } from '../../src/adapters/redpandaConnect/version';

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
