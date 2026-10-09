// Corpus harness (ticket 1.7): lints every test/corpus/*.yaml with each pinned standalone Redpanda Connect
// binary, using the extension's own argv builder (src/core/args.ts) and spawn site
// (src/adapters/redpandaConnect/process.ts), and compares the result with test/corpus/<name>.lint/<ver>.txt.
// Since ticket 3.5 it also compares each config's graph model with test/corpus/<name>.graph/<ver>.json.
//
//   npm run test:corpus          compare (default); never writes
//   npm run test:corpus:record   rewrite every lint and graph record and delete orphaned ones
//
// Binaries come from scripts/spike/fetch-binaries.sh (.cache/redpanda-connect/<ver>/redpanda-connect).
// A missing binary skips that version locally and fails it in CI (`CI` set) and in record mode, so
// `test:corpus:record` needs both binaries even for a graph-only change. To re-record only the graphs:
//   npx vitest run --config vitest.config.mts --mode record -t "graph accuracy"  (no orphan clean-up)
// The harness itself never touches the network.
//
// Lint record format:
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
//
// Graph accuracy (ticket 3.5, R12): every config is built into the extension's PipelineModel
// (src/core/graph.ts, with the catalogue of each pinned version's schema recording in
// test/fixtures/schema/, served as in the mocha tests: src/test/helpers/schemas.ts) and compared
// with test/corpus/<name>.graph/<ver>.json: the model as JSON.stringify(model, null, 2) plus a
// newline, keys in the builder's order, so a graph change is a reviewable diff of that file.
// Before the compare (and before writing in record mode) each model must also:
//   - be non-empty when the extension's detection accepts the file, and empty when it rejects it
//     (the three templates record the empty model);
//   - be well formed: unique ids, every parent in the model, every child's range within its
//     parent's, every edge's ends in the model;
//   - round-trip through nodeAt (AD-16): a node's start offset gives the node, its last offset the
//     node or a descendant.
// Both pinned versions currently record identical graphs (their catalogue slots match).
// Needs no binary either. The layout checks cover both record kinds.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLintArgs } from '../../src/core/args';
import { componentCatalogue, type ComponentCatalog } from '../../src/core/catalogue';
import { buildPipelineModel, nodeAt } from '../../src/core/graph';
import { detect } from '../../src/core/detection';
import { parseYaml } from '../../src/core/yamlPath';
import type { PipelineModel } from '../../src/shared/protocol';
import { documentLine, findingsForTarget, TargetFindings } from '../../src/core/lint';
import { PIPELINE_SNIPPETS, PipelineSnippet, renderSnippet } from '../../src/core/snippets';
import { parseVersionOutput } from '../../src/core/version';
import { SCHEMA_FIXTURES } from '../../src/test/helpers/fakeBinary';
import { servedSchema, type PinnedVersion } from '../../src/test/helpers/schemas';
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
const graphDirOf = (config: string) => path.join(CORPUS, `${path.basename(config, '.yaml')}.graph`);
const graphOf = (config: string, ver: string) => path.join(graphDirOf(config), `${ver}.json`);
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

/** Record directory suffixes and the extension of the per-version files in them. */
const RECORD_KINDS: readonly { readonly dirSuffix: string; readonly fileExt: string }[] = [
	{ dirSuffix: '.lint', fileExt: '.txt' },
	{ dirSuffix: '.graph', fileExt: '.json' },
];

/** Lint and graph record files with no matching config, or for a version that is not pinned. */
function orphanedRecords(corpus: string = CORPUS, configList: readonly string[] = configs): string[] {
	const orphans: string[] = [];
	for (const entry of fs.readdirSync(corpus, { withFileTypes: true })) {
		const kind = RECORD_KINDS.find((k) => entry.name.endsWith(k.dirSuffix));
		if (!entry.isDirectory() || !kind) {
			continue;
		}
		const dir = path.join(corpus, entry.name);
		const config = `${entry.name.slice(0, -kind.dirSuffix.length)}.yaml`;
		if (!configList.includes(config)) {
			orphans.push(dir);
			continue;
		}
		for (const file of fs.readdirSync(dir)) {
			if (!VERSIONS.some((v) => file === `${v}${kind.fileExt}`)) {
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
					return; // reported by 'every config has a lint and a graph record for each pinned version'
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

const catalogues = new Map<string, ComponentCatalog>();

/** The catalogue of `ver`'s pinned schema recording, as the mocha tests serve it (read once). */
function catalogueOf(ver: PinnedVersion): ComponentCatalog {
	let catalogue = catalogues.get(ver);
	if (!catalogue) {
		catalogue = componentCatalogue(servedSchema(ver));
		catalogues.set(ver, catalogue);
	}
	return catalogue;
}

/** The schema recordings `ver` needs (test/fixtures/schema/). */
const schemaFilesOf = (ver: string) => [`jsonschema-${ver}.json`, `json-full-${ver}.json.gz`].map((f) => path.join(SCHEMA_FIXTURES, f));

/** The record format: stable, pretty JSON with a trailing newline. */
const formatGraph = (model: PipelineModel) => JSON.stringify(model, null, 2) + '\n';

/**
 * Nodes whose range does not resolve back to them through nodeAt (AD-16): the start offset must
 * give the node itself, the last offset the node or one of its descendants.
 */
function roundTripProblems(model: PipelineModel): string[] {
	const parentOf = new Map(model.nodes.map((n) => [n.id, n.parent]));
	const isSelfOrDescendant = (id: string | undefined, ancestor: string) => {
		const seen = new Set<string>();
		for (let cur = id; cur !== undefined && !seen.has(cur); cur = parentOf.get(cur)) {
			if (cur === ancestor) {
				return true;
			}
			seen.add(cur);
		}
		return false;
	};
	return model.nodes.flatMap((node) => {
		const [start, end] = node.range;
		const problems: string[] = [];
		const atStart = nodeAt(model, start);
		if (atStart !== node.id) {
			problems.push(`  ${node.id} at offset ${start}: nodeAt gave ${atStart ?? 'undefined'}`);
		}
		if (end > start) {
			const atEnd = nodeAt(model, end - 1);
			if (!isSelfOrDescendant(atEnd, node.id)) {
				problems.push(`  ${node.id} at offset ${end - 1} (its last): nodeAt gave ${atEnd ?? 'undefined'}, not it or a descendant`);
			}
		}
		return problems;
	});
}

/** Structural problems: duplicate ids, dangling parents, a child outside its parent, dangling edges. */
function structureProblems(model: PipelineModel): string[] {
	const problems: string[] = [];
	const byId = new Map<string, PipelineModel['nodes'][number]>();
	for (const node of model.nodes) {
		if (byId.has(node.id)) {
			problems.push(`  ${node.id}: duplicate id`);
		}
		byId.set(node.id, node);
	}
	for (const node of model.nodes) {
		if (node.parent === undefined) {
			continue;
		}
		const parent = byId.get(node.parent);
		if (!parent) {
			problems.push(`  ${node.id}: parent ${node.parent} is not in the model`);
		} else if (node.range[0] < parent.range[0] || node.range[1] > parent.range[1]) {
			problems.push(`  ${node.id}: range [${node.range.join(', ')}] is not within its parent ${parent.id} [${parent.range.join(', ')}]`);
		}
	}
	for (const edge of model.edges) {
		for (const end of [edge.source, edge.target]) {
			if (!byId.has(end)) {
				problems.push(`  edge ${edge.id}: ${end} is not in the model`);
			}
		}
	}
	return problems;
}

describe('graph accuracy (corpus config → extension PipelineModel, R12)', () => {
	for (const ver of VERSIONS) {
		for (const config of configs) {
			it(`${config} @ ${ver}`, () => {
				const text = fs.readFileSync(path.join(CORPUS, config), 'utf8');
				const model = buildPipelineModel(parseYaml(text), text, catalogueOf(ver));
				// A detected config must have a graph; a file detection rejects (a template) has none.
				if (detect(text, false)) {
					expect(model.nodes.length, `${config} with the ${ver} schema: a detected config gives an empty graph`).toBeGreaterThan(0);
				} else {
					expect(model.nodes, `${config} with the ${ver} schema: not a detected config, yet it has a graph`).toEqual([]);
				}
				const structure = structureProblems(model);
				expect(structure, [`${config} with the ${ver} schema: the model is malformed:`, ...structure].join('\n')).toEqual([]);
				const problems = roundTripProblems(model);
				expect(problems, [`${config} with the ${ver} schema: a node's range does not resolve back to it:`, ...problems]
					.join('\n')).toEqual([]);
				const actual = formatGraph(model);
				const recordFile = graphOf(config, ver);
				if (RECORD) {
					fs.mkdirSync(path.dirname(recordFile), { recursive: true });
					fs.writeFileSync(recordFile, actual);
					return;
				}
				if (!fs.existsSync(recordFile)) {
					throw new Error(`${config} has no graph record for ${ver} (${rel(recordFile)}); run \`npm run test:corpus:record\``);
				}
				const recorded = fs.readFileSync(recordFile, 'utf8').replace(/\r\n/g, '\n');
				expect(actual, `${config} with the ${ver} schema: the graph differs from ${rel(recordFile)}; ` +
					'if the change is intended, run `npm run test:corpus:record`').toBe(recorded);
			});
		}
	}

	it('the round-trip check reports a node that does not own its start', () => {
		const model: PipelineModel = {
			nodes: [
				{ id: 'a', role: 'processor', component: 'switch', range: [0, 10], group: true },
				{ id: 'b', role: 'route', range: [0, 8], parent: 'a' },
			],
			edges: [],
		};
		expect(roundTripProblems(model)).toEqual(['  a at offset 0: nodeAt gave b']);
		// The last offset of `a` falls in its sibling `c`, neither `a` nor a descendant.
		const tail: PipelineModel = {
			nodes: [
				{ id: 'a', role: 'processor', component: 'mapping', range: [0, 10] },
				{ id: 'c', role: 'processor', component: 'mapping', range: [9, 12] },
			],
			edges: [],
		};
		expect(roundTripProblems(tail)).toEqual(['  a at offset 9 (its last): nodeAt gave c, not it or a descendant']);
	});

	it('the structure check reports duplicate ids, dangling parents, escaping children and dangling edges', () => {
		const model: PipelineModel = {
			nodes: [
				{ id: 'a', role: 'processor', component: 'switch', range: [0, 10], group: true },
				{ id: 'a', role: 'processor', component: 'mapping', range: [20, 30] },
				{ id: 'b', role: 'route', range: [5, 12], parent: 'a' },
				{ id: 'c', role: 'processor', component: 'mapping', range: [6, 7], parent: 'gone' },
			],
			edges: [{ id: 'a->x', source: 'a', target: 'x' }],
		};
		expect(structureProblems(model)).toEqual([
			'  a: duplicate id',
			'  b: range [5, 12] is not within its parent a [20, 30]',
			'  c: parent gone is not in the model',
			'  edge a->x: x is not in the model',
		]);
	});
});

/**
 * A full config with `snippet` inserted the way VS Code inserts it: every line after the first
 * gets the cursor line's indentation (2 under `input:` / `output:`, 4 on a processor list item).
 */
function embedSnippet(snippet: PipelineSnippet): string {
	const body = renderSnippet(snippet.body);
	const indent = (prefix: string) => body.split('\n').map((l, i) => (i === 0 || l === '' ? l : prefix + l)).join('\n');
	const input = 'input:\n  generate:\n    count: 1\n    interval: ""\n    mapping: root = "x"\n';
	const output = 'output:\n  drop: {}\n';
	switch (snippet.slot) {
		case 'root':
			return [body, ...(snippet.topKeys!.includes('input') ? [] : [input]), ...(snippet.topKeys!.includes('output') ? [] : [output])].join('\n');
		case 'input':
			return `input:\n  ${indent('  ')}\n${output}`;
		case 'output':
			return `${input}output:\n  ${indent('  ')}\n`;
		case 'processor':
			return `${input}pipeline:\n  processors:\n    - ${indent('    ')}\n${output}`;
	}
}

for (const ver of VERSIONS) {
	describe.runIf(hasBinary(ver))(`snippets lint clean with redpanda-connect ${ver} (2.10)`, () => {
		for (const snippet of PIPELINE_SNIPPETS) {
			it(`${snippet.slot}: ${snippet.label}`, async () => {
				const dir = fs.mkdtempSync(path.join(ROOT, '.cache', 'snippet-'));
				try {
					const file = path.join(dir, 'snippet.yaml');
					fs.writeFileSync(file, embedSnippet(snippet));
					const built = buildLintArgs({ invocation: [binaryOf(ver)], targets: [file], resourceFiles: [] });
					if (built.kind !== 'ok') {
						throw new Error(JSON.stringify(built));
					}
					const [command, ...args] = built.argv;
					const outcome = await runProcess([command], args, LINT_TIMEOUT_MS);
					expect(outcome.kind === 'exited' && outcome.exitCode === 0,
						`${snippet.label} with ${ver}:\n${fs.readFileSync(file, 'utf8')}\n${JSON.stringify(outcome)}`).toBe(true);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});
		}
	});
}

describe('corpus layout', () => {
	it('pins the same versions as scripts/spike/fetch-binaries.sh', () => {
		const match = /^VERSIONS=\(([^)]*)\)/m.exec(fs.readFileSync(FETCH_SCRIPT, 'utf8'));
		expect(match?.[1].trim().split(/\s+/), 'VERSIONS in fetch-binaries.sh').toEqual([...VERSIONS]);
	});

	it('every pinned version has its schema recordings (graph accuracy)', () => {
		const missing = VERSIONS.flatMap(schemaFilesOf).filter((f) => !fs.existsSync(f)).map(rel);
		expect(missing, `missing schema recordings: ${missing.join(', ')}`).toEqual([]);
	});

	it('the orphan check finds orphaned lint and graph records', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-orphans-'));
		try {
			for (const f of ['x.graph/4.112.0.json', 'a.graph/9.9.9.json', 'a.graph/4.112.0.txt', 'a.graph/4.100.0.json',
				'a.lint/4.112.0.txt', 'a.lint/4.112.0.json', 'y.lint/4.100.0.txt']) {
				fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
				fs.writeFileSync(path.join(dir, f), '');
			}
			expect(orphanedRecords(dir, ['a.yaml'])).toEqual([
				'a.graph/4.112.0.txt', 'a.graph/9.9.9.json', 'a.lint/4.112.0.json', 'x.graph', 'y.lint',
			].map((f) => path.join(dir, f)));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
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

		it('every config has a lint and a graph record for each pinned version', () => {
			const missing = configs.flatMap((c) => VERSIONS.flatMap((v) => [recordOf(c, v), graphOf(c, v)]))
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
