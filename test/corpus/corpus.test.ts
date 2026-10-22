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
//
// Bloblang positions and ids (ticket 4.3): every corpus `mapping` / `mutation` processor's (and,
// since ticket 22, `generate` input mapping's, whose node is the input's) position map round-trips (each decoded character maps to an offset holding it, or the start of
// its escape or fold) and, given the PipelineModel of each version's catalogue, it has an id, its
// node's (through nodeAt). Needs no binary and no records.
//
// Bloblang parity (ticket 4.12, R11, AD-21): every corpus `mapping` / `mutation` processor (as
// `bloblangProcessors` finds them, `generate` input mappings left out by `processorsOnly`) has samples in test/corpus/<name>.samples.json (AD-22's format,
// linked by label, else by path; a sample carries the metadata its mapping reads). Record mode runs,
// per pinned version, the harness's own copy of the AD-21 one-message pipeline
// (test/corpus/bloblangReference.ts, not the extension's `testConfig`) on every sample, and
// `blobl -f` (stdin closed) on every processor's source and on its broken variant (the source with
// ` +` on a new last line), and writes test/corpus/<name>.bloblang/<ver>.json:
//   { "binary": "redpanda-connect <ver>",
//     "runs":   [{ "path", "sample", "exit", "stdout", "lint"? }],   lint only with `Config lint error`
//     "parses": [{ "path", "variant": "original" | "broken", "exit", "stderr" }] }
// in processor order, then sample order; the temporary directory is written `<TMP>`. `lint` is the
// lint findings' messages (`lintFindings`: no timestamp, no config path or position). Besides the
// corpus, the harness fixture test/corpus/fixtures/bloblang_env.yaml (a mapping that reads an unset
// `${…}`) is checked the same way, so a lint stop and a non-parse `blobl` failure meet real binaries. Compare mode
// runs the extension's own run and parse code (src/adapters/redpandaConnect/bloblangRunner.ts,
// no `vscode`) with the live binary and checks it against the record: an output line is `ok` with
// the same content and metadata, no line with exit 0 is `deleted`, an `{error}` is `failed` or
// `invalidInput` with the same message (and the mapping and file line of `failed assignment (line N)`);
// for the parses, exit 0 gives no diagnostic, a `failed to parse mapping: line L char C: <message>`
// one diagnostic with that message and the file position of L and C through the processor's position
// map. A reference run that exited non-zero must give `blobl`'s parse error (a `Config lint error`
// that `blobl` reports as one) or the recorded lint findings (read from its message the same way); a `blobl` failure that is not a parse
// error must give `blobl`'s message. Both fail on any difference: per version, a real record altered
// in memory (content, deleted, error text, parse message, parse char) is reported by the same
// comparison (WRONG_RECORD). Processors directly in `try`, `catch` and `for_each` count (4.12's
// fix to `bloblangProcessors`). The run is never compared with `blobl`. Without a binary the version is skipped as for lint (failed in CI and record
// mode); the samples, the records' coverage (an output, a `deleted()`, a mapping error, a parse error
// in every broken variant) and the layout are checked without one.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLintArgs } from '../../src/core/args';
import { componentCatalogue, type ComponentCatalog } from '../../src/core/catalogue';
import { buildPipelineModel, nodeAt } from '../../src/core/graph';
import { bloblangProcessors, processorsOnly } from '../../src/core/bloblangProcessors';
import { detect } from '../../src/core/detection';
import { parseYaml } from '../../src/core/yamlPath';
import type { PipelineModel } from '../../src/shared/protocol';
import { documentLine, findingsForTarget, TargetFindings } from '../../src/core/lint';
import { PIPELINE_SNIPPETS, PipelineSnippet, renderSnippet } from '../../src/core/snippets';
import { parseVersionOutput } from '../../src/core/version';
import { SCHEMA_FIXTURES } from '../../src/test/helpers/fakeBinary';
import { servedSchema, type PinnedVersion } from '../../src/test/helpers/schemas';
import { positionProblems } from '../../src/test/helpers/bloblangPositions';
import { readVersion, runProcess } from '../../src/adapters/redpandaConnect/process';
import {
	parseMapping as extensionParse, runMappingTest as extensionRun, type BloblangCommand,
} from '../../src/adapters/redpandaConnect/bloblangRunner';
import type { BloblParseOutcome } from '../../src/core/bloblangParse';
import type { BloblangPositions } from '../../src/core/bloblangPositions';
import { parseSamplesFile, samplesFileName, samplesFor, type SamplesFile } from '../../src/core/samples';
import type { BloblangResult } from '../../src/shared/bloblangProtocol';
import { isDeepStrictEqual } from 'util';
import { bloblParseError, brokenVariant, lintFindings, referenceParse, referenceRun, type ReferenceOutput } from './bloblangReference';

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
/** A config's Bloblang record directory; `config` is relative to the corpus (`eval.yaml`, `fixtures/bloblang_env.yaml`). */
const bloblangDirOf = (config: string) => path.join(CORPUS, config.replace(/\.yaml$/, '.bloblang'));
const bloblangRecordOf = (config: string, ver: string) => path.join(bloblangDirOf(config), `${ver}.json`);
const samplesOf = (config: string) => path.join(CORPUS, samplesFileName(config));
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

/** Configs with at least one `mapping` / `mutation` processor (4.3, 4.12): the parity configs. */
const withBloblang = configs.filter((c) => processorsOnly(bloblangProcessors(parseYaml(fs.readFileSync(path.join(CORPUS, c), 'utf8')))).length > 0);
/** Configs with any Bloblang the finder returns, `generate` input mappings included (ticket 22): the round-trip configs. */
const withAnyBloblang = configs.filter((c) => bloblangProcessors(parseYaml(fs.readFileSync(path.join(CORPUS, c), 'utf8'))).length > 0);

/** The env var the harness fixture's mapping reads; never set, so `run` stops on lint and `blobl` fails. */
const UNSET_ENV_VAR = 'RPCN_CORPUS_UNSET_4_12';
delete process.env[UNSET_ENV_VAR];
/** Harness fixtures checked for Bloblang parity beside the corpus (4.12): an unset `${…}` in a mapping. */
const BLOBLANG_FIXTURES = ['fixtures/bloblang_env.yaml'];
/** Every config the Bloblang parity checks: the corpus's, then the fixtures. */
const PARITY_CONFIGS = [...withBloblang, ...BLOBLANG_FIXTURES];

/**
 * Record directory suffixes and the extension of the per-version files in them; `bloblang` records
 * exist only for a config with Bloblang processors.
 */
const RECORD_KINDS: readonly { readonly dirSuffix: string; readonly fileExt: string; readonly bloblang?: true }[] = [
	{ dirSuffix: '.lint', fileExt: '.txt' },
	{ dirSuffix: '.graph', fileExt: '.json' },
	{ dirSuffix: '.bloblang', fileExt: '.json', bloblang: true },
];

/**
 * Lint, graph and Bloblang record files with no matching config (for Bloblang records: no config
 * with Bloblang processors), or for a version that is not pinned.
 */
function orphanedRecords(corpus: string = CORPUS, configList: readonly string[] = configs, bloblangList: readonly string[] = withBloblang): string[] {
	const orphans: string[] = [];
	for (const entry of fs.readdirSync(corpus, { withFileTypes: true })) {
		const kind = RECORD_KINDS.find((k) => entry.name.endsWith(k.dirSuffix));
		if (!entry.isDirectory() || !kind) {
			continue;
		}
		const dir = path.join(corpus, entry.name);
		const config = `${entry.name.slice(0, -kind.dirSuffix.length)}.yaml`;
		if (!(kind.bloblang ? bloblangList : configList).includes(config)) {
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

describe('Bloblang positions and ids (corpus config → mapping / mutation processors, 4.3; generate mappings, 22)', () => {
	it('the corpus has mapping and mutation processors, and generate mappings, to check', () => {
		expect(withBloblang.length).toBeGreaterThan(0);
		expect(withAnyBloblang.some((c) => bloblangProcessors(parseYaml(fs.readFileSync(path.join(CORPUS, c), 'utf8')))
			.some((p) => p.kind === 'generate'))).toBe(true);
	});

	for (const config of withAnyBloblang) {
		it(`${config}: every mapping / mutation / generate mapping round-trips, and its id is its graph node's`, () => {
			const text = fs.readFileSync(path.join(CORPUS, config), 'utf8');
			const parsed = parseYaml(text);
			const found = bloblangProcessors(parsed);
			const problems = found.flatMap((p) => positionProblems(text, p));
			expect(problems, [`${config}: a Bloblang position does not map back to its character:`, ...problems].join('\n')).toEqual([]);
			for (const ver of VERSIONS) {
				const model = buildPipelineModel(parsed, text, catalogueOf(ver));
				const withIds = bloblangProcessors(parsed, model).filter((f) => !f.path.startsWith('documents['));
				expect(withIds.map((p) => p.path), `${config} @ ${ver}: the processors differ with a model`).toEqual(
					found.filter((f) => !f.path.startsWith('documents[')).map((p) => p.path));
				for (const p of withIds) {
					expect(p.id, `${config} @ ${ver}: ${p.path} has no graph node id`).toBeDefined();
					const node = model.nodes.find((n) => n.id === p.id);
					expect(node?.component, `${config} @ ${ver}: ${p.path} has id ${p.id}, which is not a ${p.kind} node of the graph`).toBe(p.kind);
					expect(nodeAt(model, p.keyRange[0]), `${config} @ ${ver}: ${p.path}'s key is in another graph node than ${p.id}`).toBe(p.id);
				}
			}
		});
	}
});

// ---- Bloblang parity (4.12) ----

/** A recorded reference run: the raw exit and stdout, plus the lint findings when stderr says `Config lint error`. */
interface RunEntry {
	readonly path: string;
	readonly sample: string;
	readonly exit: number | null;
	readonly stdout: string;
	/** `lintFindings` of stderr: the findings' messages only (no timestamp, path or position). */
	readonly lint?: readonly string[];
}

/** A recorded `blobl -f` parse (stdin closed): the raw exit and stderr. */
interface ParseEntry {
	readonly path: string;
	readonly variant: 'original' | 'broken';
	readonly exit: number | null;
	readonly stderr: string;
}

interface BloblangRecord {
	readonly binary: string;
	readonly runs: readonly RunEntry[];
	readonly parses: readonly ParseEntry[];
}

const TMP_PLACEHOLDER = '<TMP>';
const VARIANTS = ['original', 'broken'] as const;

/** `processor`'s source for a parse variant. */
const variantSource = (source: string, variant: ParseEntry['variant']) => (variant === 'original' ? source : brokenVariant(source));

const formatBloblangRecord = (record: BloblangRecord) => JSON.stringify(record, null, 2) + '\n';

/** A config's samples file, read with the extension's AD-22 reader (`undefined`: none). */
function readSamples(config: string): SamplesFile | undefined {
	const file = samplesOf(config);
	if (!fs.existsSync(file)) {
		return undefined;
	}
	const parsed = parseSamplesFile(fs.readFileSync(file, 'utf8'));
	if (!parsed.ok) {
		throw new Error(`${rel(file)} can't be read: ${parsed.reason}`);
	}
	return parsed.file;
}

/** A config's Bloblang processors (first document only, as the panel opens them) with their samples. */
function bloblangCases(config: string) {
	const text = fs.readFileSync(path.join(CORPUS, config), 'utf8');
	const samples = readSamples(config);
	const processors = processorsOnly(bloblangProcessors(parseYaml(text))).filter((p) => !p.path.startsWith('documents['));
	return {
		text,
		processors: processors.map((p) => ({
			processor: p,
			samples: samplesFor(samples, { ...(p.label !== undefined ? { label: p.label } : {}), path: p.path }).samples,
		})),
	};
}

/** The 1-based file line and char (UTF-16, as VS Code counts) of `offset` in `text`, read here. */
function fileAt(text: string, offset: number): { line: number; char: number } {
	const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
	const breaks = before.match(/\r\n|\r|\n/g) ?? [];
	const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
	return { line: breaks.length + 1, char: before.length - (lastBreak + 1) + 1 };
}

/** The file position of the mapping's `line` and `char` through `positions` (4.3's map). */
const fileOf = (text: string, positions: BloblangPositions) => (line: number, char: number) => fileAt(text, positions.offsetAt(line, char));

const show = (v: unknown) => JSON.stringify(v);

/** A child's stderr message, read here: its non-empty lines, joined. */
const stderrMessage = (stderr: string) => stderr.split('\n').map((l) => l.replace(/\r$/, ''))
	.filter((l) => l.trim() !== '').join('\n');

/**
 * What differs between a recorded reference run and the extension's result for the same sample;
 * empty when they agree. `fileLineOf` gives the file line of a mapping line.
 */
function runProblems(entry: RunEntry, actual: BloblangResult, fileLineOf: (mappingLine: number) => number, parse: ParseEntry | undefined): string[] {
	const at = `  ${entry.path} / ${entry.sample}:`;
	if (entry.exit !== 0) {
		// The run stopped: on a `Config lint error` that `blobl` reports as a parse error (the
		// processor's original parse), the extension shows that parse error; on any other lint stop,
		// an error whose message has the recorded lint findings (read the same way); a stop with no
		// lint findings has no message to check.
		const parsed = entry.lint !== undefined && parse?.exit !== 0 ? bloblParseError(parse?.stderr ?? '') : undefined;
		if (parsed) {
			return actual.kind === 'parseError' && actual.message === parsed.message
				&& actual.mappingLine === parsed.line && actual.mappingChar === parsed.char ? []
				: [`${at} the reference stopped on blobl's parse error ${show(parsed)}, the extension gave ${show(actual)}`];
		}
		if (entry.lint === undefined || entry.lint.length === 0) {
			return [`${at} the reference exited ${entry.exit} with no recorded lint finding, the extension gave ${show(actual)}`];
		}
		return actual.kind === 'error' && isDeepStrictEqual(lintFindings(actual.message), entry.lint) ? []
			: [`${at} the reference stopped on lint ${show(entry.lint)}, the extension gave ${show(actual)}`];
	}
	const lines = entry.stdout.split('\n').filter((l) => l.trim() !== '');
	if (lines.length === 0) {
		return actual.kind === 'deleted' ? [] : [`${at} the reference printed no line (deleted), the extension gave ${show(actual)}`];
	}
	if (lines.length > 1) {
		return [`${at} the reference printed ${lines.length} lines, not one`];
	}
	let line: unknown;
	try {
		line = JSON.parse(lines[0]);
	} catch {
		return [`${at} the reference's line is not JSON: ${lines[0]}`];
	}
	const record = (typeof line === 'object' && line !== null ? line : {}) as Record<string, unknown>;
	if (typeof record.error === 'string') {
		if (actual.kind !== 'failed' && actual.kind !== 'invalidInput') {
			return [`${at} the reference failed with ${show(record.error)}, the extension gave ${show(actual)}`];
		}
		const problems = actual.message === record.error ? [] : [`${at} error ${show(actual.message)}, recorded ${show(record.error)}`];
		const named = /^failed assignment \(line ([0-9]+)\)/.exec(record.error);
		if (named && actual.kind === 'failed') {
			const mappingLine = Number(named[1]);
			if (actual.mappingLine !== mappingLine || actual.fileLine !== fileLineOf(mappingLine)) {
				problems.push(`${at} the error names mapping line ${mappingLine} (file line ${fileLineOf(mappingLine)}), ` +
					`the extension gave mapping line ${actual.mappingLine} (file line ${actual.fileLine})`);
			}
		}
		return problems;
	}
	if (typeof record.content === 'string') {
		if (actual.kind !== 'ok') {
			return [`${at} the reference gave ${lines[0]}, the extension gave ${show(actual)}`];
		}
		const problems: string[] = [];
		if (actual.content !== record.content) {
			problems.push(`${at} content ${show(actual.content)}, recorded ${show(record.content)}`);
		}
		if (!isDeepStrictEqual(actual.meta, record.meta ?? {})) {
			problems.push(`${at} meta ${show(actual.meta)}, recorded ${show(record.meta)}`);
		}
		return problems;
	}
	return [`${at} the reference's line is neither {content, meta} nor {error}: ${lines[0]}`];
}

/**
 * One diagnostic as the parity compares it: the message, its 1-based file position, and the
 * mapping position it came from (a broken variant's ` +` lies past the processor's text, where the
 * map clamps every position to the mapping's end).
 */
interface ParseDiagnostic {
	readonly message: string;
	readonly line: number;
	readonly char: number;
	readonly mappingLine: number;
	readonly mappingChar: number;
}

/**
 * What differs between a recorded `blobl` parse and the extension's for the same source; empty when
 * they agree. `fileOfPosition` maps a mapping line and char to the file (the processor's map).
 */
function parseProblems(entry: ParseEntry, actual: BloblParseOutcome, fileOfPosition: (line: number, char: number) => { line: number; char: number }): string[] {
	const at = `  ${entry.path} (${entry.variant}):`;
	if (entry.exit === 0) {
		return actual.kind === 'ok' ? [] : [`${at} blobl exited 0, the extension gave ${show(actual)}`];
	}
	const recorded = bloblParseError(entry.stderr);
	if (!recorded) {
		// Not a parse error: the extension shows blobl's message (no diagnostic position).
		const message = stderrMessage(entry.stderr);
		return actual.kind === 'other' && actual.message === message ? []
			: [`${at} blobl failed with ${show(message)} (not a parse error), the extension gave ${show(actual)}`];
	}
	const expected: ParseDiagnostic | undefined = recorded && {
		message: recorded.message, ...fileOfPosition(recorded.line, recorded.char), mappingLine: recorded.line, mappingChar: recorded.char,
	};
	const got: ParseDiagnostic | undefined = actual.kind === 'parseError'
		? { message: actual.message, ...fileOfPosition(actual.line, actual.char), mappingLine: actual.line, mappingChar: actual.char }
		: undefined;
	return isDeepStrictEqual(expected, got) ? [] : [`${at} diagnostic ${show(got ?? null)}, recorded ${show(expected ?? null)}`];
}

/** Everything the extension's run and parse disagree with in `record`; empty when they agree. */
async function bloblangParityProblems(config: string, record: BloblangRecord, setup: BloblangCommand, dir: string): Promise<string[]> {
	const { text, processors } = bloblangCases(config);
	const problems: string[] = [];
	const expectedRuns = processors.flatMap(({ processor, samples }) => samples.map((s) => `${processor.path} / ${s.name}`));
	const expectedParses = processors.flatMap(({ processor }) => VARIANTS.map((v) => `${processor.path} (${v})`));
	const recordedRuns = record.runs.map((r) => `${r.path} / ${r.sample}`);
	const recordedParses = record.parses.map((r) => `${r.path} (${r.variant})`);
	if (!isDeepStrictEqual(recordedRuns, expectedRuns) || !isDeepStrictEqual(recordedParses, expectedParses)) {
		return [`  the record's entries ${show([...recordedRuns, ...recordedParses])} are not the corpus's ` +
			`${show([...expectedRuns, ...expectedParses])}`];
	}
	for (const { processor, samples } of processors) {
		const toFile = fileOf(text, processor.positions);
		for (const sample of samples) {
			const entry = record.runs.find((r) => r.path === processor.path && r.sample === sample.name)!;
			const actual = await extensionRun(setup, processor.kind, processor.source, sample.content, sample.meta, dir, {
				cwd: dir,
				locate: toFile,
			});
			const parse = record.parses.find((r) => r.path === processor.path && r.variant === 'original');
			problems.push(...runProblems(entry, actual, (line) => toFile(line, 1).line, parse));
		}
		for (const variant of VARIANTS) {
			const entry = record.parses.find((r) => r.path === processor.path && r.variant === variant)!;
			const actual = await extensionParse(setup, variantSource(processor.source, variant), dir, { cwd: dir });
			problems.push(...parseProblems(entry, actual, toFile));
		}
	}
	return problems;
}

/** `output` with the temporary directory written `<TMP>`. */
const hideTmp = (output: string, dir: string) => output.split(dir).join(TMP_PLACEHOLDER);

/** The record `binary` gives for `config`: the reference pipeline on every sample, `blobl -f` on every variant. */
async function recordBloblang(config: string, ver: string, dir: string): Promise<BloblangRecord> {
	const binary = binaryOf(ver);
	const { processors } = bloblangCases(config);
	const runs: RunEntry[] = [];
	const parses: ParseEntry[] = [];
	for (const { processor, samples } of processors) {
		for (const sample of samples) {
			const out: ReferenceOutput = await referenceRun(binary, dir, processor.kind, processor.source, sample.content, sample.meta);
			runs.push({
				path: processor.path,
				sample: sample.name,
				exit: out.exit,
				stdout: hideTmp(out.stdout, dir),
				...(out.stderr.includes('Config lint error') ? { lint: lintFindings(hideTmp(out.stderr, dir)) } : {}),
			});
		}
		for (const variant of VARIANTS) {
			const out = await referenceParse(binary, dir, variantSource(processor.source, variant));
			parses.push({ path: processor.path, variant, exit: out.exit, stderr: hideTmp(out.stderr, dir) });
		}
	}
	return { binary: `redpanda-connect ${ver}`, runs, parses };
}

/** What a recorded run is, read here: `ok`, `deleted`, `error` (an `{error}` line) or `stopped`. */
function runKindOf(entry: RunEntry): 'ok' | 'deleted' | 'error' | 'stopped' {
	if (entry.exit !== 0) {
		return 'stopped';
	}
	const line = entry.stdout.split('\n').find((l) => l.trim() !== '');
	if (line === undefined) {
		return 'deleted';
	}
	return typeof (JSON.parse(line) as Record<string, unknown>).error === 'string' ? 'error' : 'ok';
}

/** A record with one value altered, and the id of the entry it altered (`path / sample` or `path (variant)`). */
interface Altered {
	readonly record: BloblangRecord;
	readonly entry: string;
}

/** `record` with the first run entry that `pick` accepts replaced by what `change` makes of it. */
function alterRun(record: BloblangRecord, pick: (entry: RunEntry) => boolean, change: (entry: RunEntry) => RunEntry): Altered | undefined {
	const i = record.runs.findIndex(pick);
	return i < 0 ? undefined : {
		record: { ...record, runs: record.runs.map((r, j) => (j === i ? change(r) : r)) },
		entry: `${record.runs[i].path} / ${record.runs[i].sample}`,
	};
}

/** `record` with the first broken variant's parse error changed by `change` (its stderr's first line). */
function alterParse(record: BloblangRecord, change: (firstLine: string) => string): Altered | undefined {
	const i = record.parses.findIndex((p) => p.variant === 'broken' && bloblParseError(p.stderr) !== undefined);
	if (i < 0) {
		return undefined;
	}
	const entry = record.parses[i];
	const [first, ...rest] = entry.stderr.split('\n');
	const stderr = [change(first), ...rest].join('\n');
	return stderr === entry.stderr ? undefined : {
		record: { ...record, parses: record.parses.map((p, j) => (j === i ? { ...p, stderr } : p)) },
		entry: `${entry.path} (${entry.variant})`,
	};
}

/** The recorded run line's JSON object. */
const runLine = (entry: RunEntry) => JSON.parse(entry.stdout.split('\n').find((l) => l.trim() !== '')!) as Record<string, unknown>;

/** One value per kind (content, deleted, error text, parse message, parse char), as the strictness test alters them. */
const ALTERATIONS: readonly { readonly name: string; readonly alter: (record: BloblangRecord) => Altered | undefined }[] = [
	{
		name: 'content',
		alter: (record) => alterRun(record, (r) => runKindOf(r) === 'ok', (r) => {
			const line = runLine(r);
			return { ...r, stdout: `${JSON.stringify({ ...line, content: `${String(line.content)} altered` })}\n` };
		}),
	},
	{
		name: 'deleted()',
		alter: (record) => alterRun(record, (r) => runKindOf(r) === 'deleted', (r) => ({ ...r, stdout: '{"content":"{}","meta":{}}\n' })),
	},
	{
		name: 'error text',
		alter: (record) => alterRun(record, (r) => runKindOf(r) === 'error', (r) => {
			const line = runLine(r);
			return { ...r, stdout: `${JSON.stringify({ ...line, error: `${String(line.error)} altered` })}\n` };
		}),
	},
	{ name: 'parse message', alter: (record) => alterParse(record, (first) => `${first} altered`) },
	{ name: 'parse char', alter: (record) => alterParse(record, (first) => first.replace(/ char ([0-9]+):/, (_, c: string) => ` char ${Number(c) + 1}:`)) },
];

describe('Bloblang parity (4.12): samples, records and the checker', () => {
	for (const ver of VERSIONS) {
		it(`the records cover an output, a deleted(), a mapping error and a parse error in every broken variant @ ${ver}`, () => {
			const records = withBloblang.map((c) => bloblangRecordOf(c, ver)).filter((f) => fs.existsSync(f))
				.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as BloblangRecord);
			const fixtures = BLOBLANG_FIXTURES.map((c) => bloblangRecordOf(c, ver)).filter((f) => fs.existsSync(f))
				.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as BloblangRecord);
			if (records.length === 0) {
				return; // reported by 'every config has a lint and a graph record (and a Bloblang one …)'
			}
			const kinds = new Set(records.flatMap((r) => r.runs.map(runKindOf)));
			for (const kind of ['ok', 'deleted', 'error'] as const) {
				expect(kinds.has(kind), `no recorded run @ ${ver} is ${kind}`).toBe(true);
			}
			// The fixture's lint stop, and its blobl failures that are not parse errors.
			if (fixtures.length > 0) {
				expect(fixtures.flatMap((r) => r.runs).some((r) => runKindOf(r) === 'stopped' && (r.lint?.length ?? 0) > 0),
					`the fixture's record @ ${ver} has no lint stop`).toBe(true);
				expect(fixtures.flatMap((r) => r.parses).some((p) => p.exit !== 0 && !bloblParseError(p.stderr)),
					`the fixture's record @ ${ver} has no blobl failure that is not a parse error`).toBe(true);
			}
			const unbroken = records.flatMap((r) => r.parses).filter((p) => p.variant === 'broken' && !bloblParseError(p.stderr));
			expect(unbroken.map((p) => p.path), `broken variants @ ${ver} that blobl does not report as a parse error`).toEqual([]);
		});
	}

	it('the run and parse checks, case by case (STOP_MESSAGE included)', () => {
		const ok: RunEntry = { path: 'p', sample: 's', exit: 0, stdout: '{"content":"{\\"a\\":1}","meta":{"k":"v"}}\n' };
		const okResult: BloblangResult = {
			kind: 'ok', content: '{"a":1}', meta: { k: 'v' },
			changes: { fields: null, meta: { added: [], changed: [], removed: [] } },
		};
		const line = (n: number) => n + 10;
		expect(runProblems(ok, okResult, line, undefined)).toEqual([]);
		expect(runProblems({ ...ok, stdout: '{"content":"{\\"a\\":2}","meta":{"k":"v"}}\n' }, okResult, line, undefined)).toEqual([
			'  p / s: content "{\\"a\\":1}", recorded "{\\"a\\":2}"',
		]);
		expect(runProblems({ ...ok, stdout: '{"content":"{\\"a\\":1}","meta":{}}\n' }, okResult, line, undefined)).toEqual([
			'  p / s: meta {"k":"v"}, recorded {}',
		]);
		expect(runProblems({ ...ok, stdout: '' }, okResult, line, undefined)).toHaveLength(1);
		expect(runProblems({ ...ok, stdout: '' }, { kind: 'deleted' }, line, undefined)).toEqual([]);
		const failed: RunEntry = { ...ok, stdout: '{"error":"failed assignment (line 2): boom"}\n' };
		const failedResult: BloblangResult = { kind: 'failed', message: 'failed assignment (line 2): boom', mappingLine: 2, fileLine: 12 };
		expect(runProblems(failed, failedResult, line, undefined)).toEqual([]);
		expect(runProblems({ ...failed, stdout: '{"error":"failed assignment (line 3): boom"}\n' }, failedResult, line, undefined)).toHaveLength(2);
		expect(runProblems(failed, { kind: 'deleted' }, line, undefined)).toHaveLength(1);
		expect(runProblems({ ...ok, exit: 1 }, okResult, line, undefined)).toHaveLength(1);
		// A stop: on blobl's parse error, its message and position; on another lint stop, its findings.
		const lintLine = (file: string, time: string) =>
			`time="${time}" level=error msg="Config lint error" @service=redpanda-connect lint="${file}(12,8) something \\"quoted\\""\n` +
			`time="${time}" level=error msg="shutting down due to linter errors" @service=redpanda-connect`;
		const stop: RunEntry = { ...ok, exit: 1, stdout: '', lint: ['something "quoted"'] };
		expect(lintFindings(lintLine('/tmp/x/reference.yaml', '2026-01-01T00:00:00Z'))).toEqual(['something "quoted"']);
		const originalParse: ParseEntry = { path: 'p', variant: 'original', exit: 1, stderr: 'failed to parse mapping: line 2 char 3: bad\n' };
		const stopResult: BloblangResult = {
			kind: 'parseError', message: 'bad', excerpt: '', mappingLine: 2, mappingChar: 3, fileLine: 12, fileChar: 7,
		};
		expect(runProblems(stop, stopResult, line, originalParse)).toEqual([]);
		expect(runProblems(stop, { ...stopResult, message: 'other' }, line, originalParse)).toHaveLength(1);
		expect(runProblems(stop, { ...stopResult, mappingChar: 4 }, line, originalParse)).toHaveLength(1);
		expect(runProblems(stop, { kind: 'error', message: 'Config lint error' }, line, originalParse)).toHaveLength(1);
		// The extension's own temp path and time differ from the reference's: only the findings count.
		const lintMessage = lintLine('/storage/bloblang-test-1.yaml', '2026-02-02T00:00:00Z');
		const noParse = { ...originalParse, exit: 0, stderr: '' };
		expect(runProblems(stop, { kind: 'error', message: lintMessage }, line, noParse)).toEqual([]);
		expect(runProblems(stop, { kind: 'error', message: lintMessage.replace('something', 'other') }, line, noParse)).toHaveLength(1);
		expect(runProblems(stop, { kind: 'error', message: 'Config lint error' }, line, noParse)).toHaveLength(1);
		expect(runProblems({ ...ok, exit: 1, stdout: '' }, { kind: 'error', message: '' }, line, undefined)).toHaveLength(1);

		const toFile = (l: number, c: number) => ({ line: l + 10, char: c + 4 });
		const parsed: ParseEntry = { path: 'p', variant: 'original', exit: 0, stderr: '' };
		expect(parseProblems(parsed, { kind: 'ok' }, toFile)).toEqual([]);
		const broken: ParseEntry = {
			path: 'p', variant: 'broken', exit: 1,
			stderr: 'failed to parse mapping: line 2 char 3: expected something\n  |\n2 |  +\n  |   ^---\n',
		};
		const brokenResult: BloblParseOutcome = { kind: 'parseError', message: 'expected something', line: 2, char: 3, excerpt: '' };
		expect(parseProblems(broken, brokenResult, toFile)).toEqual([]);
		expect(parseProblems({ ...broken, stderr: broken.stderr.replace('char 3', 'char 4') }, brokenResult, toFile)).toEqual([
			'  p (broken): diagnostic {"message":"expected something","line":12,"char":7,"mappingLine":2,"mappingChar":3}, ' +
				'recorded {"message":"expected something","line":12,"char":8,"mappingLine":2,"mappingChar":4}',
		]);
		// Past the processor's text the map clamps: the mapping position still tells them apart.
		const clamped = () => ({ line: 9, char: 9 });
		expect(parseProblems({ ...broken, stderr: broken.stderr.replace('char 3', 'char 4') }, brokenResult, clamped)).toHaveLength(1);
		expect(parseProblems({ ...broken, stderr: broken.stderr.replace('something', 'else') }, brokenResult, toFile)).toHaveLength(1);
		expect(parseProblems(broken, { kind: 'ok' }, toFile)).toHaveLength(1);
		expect(parseProblems({ ...broken, exit: 0 }, brokenResult, toFile)).toHaveLength(1);
		// A non-parse failure: the extension's message is blobl's.
		// The message runs on to the caret excerpt; the space after the colon is optional.
		expect(bloblParseError('failed to parse mapping: line 1 char 2:first\nsecond\n  |\n1 | x\n')).toEqual({ line: 1, char: 2, message: 'first\nsecond' });
		expect(bloblParseError('failed to parse mapping: line 1 char 2:\n')).toEqual({ line: 1, char: 2, message: 'Bloblang parse error.' });
		const envFailure: ParseEntry = { ...broken, stderr: 'failed to replace env vars: required environment variables were not set: [X]\n' };
		expect(parseProblems(envFailure, { kind: 'other', message: 'failed to replace env vars: required environment variables were not set: [X]' }, toFile)).toEqual([]);
		expect(parseProblems(envFailure, { kind: 'other', message: 'something else' }, toFile)).toHaveLength(1);
		expect(parseProblems(envFailure, brokenResult, toFile)).toHaveLength(1);
	});

	it('the file position of an offset counts lines and UTF-16 units as VS Code does', () => {
		expect(fileAt('ab\ncd', 4)).toEqual({ line: 2, char: 2 });
		expect(fileAt('ab\r\ncd', 4)).toEqual({ line: 2, char: 1 });
		expect(fileAt('ab', 99)).toEqual({ line: 1, char: 3 });
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

	it('the orphan check finds orphaned lint, graph and Bloblang records', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-orphans-'));
		try {
			for (const f of ['x.graph/4.112.0.json', 'a.graph/9.9.9.json', 'a.graph/4.112.0.txt', 'a.graph/4.100.0.json',
				'a.lint/4.112.0.txt', 'a.lint/4.112.0.json', 'y.lint/4.100.0.txt']) {
				fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
				fs.writeFileSync(path.join(dir, f), '');
			}
			for (const f of ['a.bloblang/4.112.0.json', 'a.bloblang/4.112.0.txt', 'b.bloblang/4.112.0.json']) {
				fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
				fs.writeFileSync(path.join(dir, f), '');
			}
			// b.yaml is a config, but has no Bloblang processors: its Bloblang record is an orphan.
			expect(orphanedRecords(dir, ['a.yaml', 'b.yaml'], ['a.yaml'])).toEqual([
				'a.bloblang/4.112.0.txt', 'a.graph/4.112.0.txt', 'a.graph/9.9.9.json', 'a.lint/4.112.0.json', 'b.bloblang',
				'x.graph', 'y.lint',
			].map((f) => path.join(dir, f)));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('every Bloblang processor has a sample, and every samples entry and file has its processor and config (4.12)', () => {
		const missing = PARITY_CONFIGS.flatMap((c) => bloblangCases(c).processors.filter((p) => p.samples.length === 0)
			.map((p) => `${c} ${p.processor.label ?? p.processor.path}`));
		expect(missing, `processors with no sample in their <config>.samples.json: ${missing.join(', ')}`).toEqual([]);
		const stale: string[] = [];
		for (const file of fs.readdirSync(CORPUS).filter((f) => f.endsWith('.samples.json'))) {
			const config = configs.find((c) => samplesFileName(c) === file);
			if (!config) {
				stale.push(`${file} (no config)`);
				continue;
			}
			const processors = bloblangCases(config).processors.map((p) => p.processor);
			for (const entry of readSamples(config)?.mappings ?? []) {
				const linked = entry.label !== undefined
					? processors.some((p) => p.label === entry.label)
					: processors.some((p) => p.label === undefined && p.path === entry.path);
				if (!linked) {
					stale.push(`${file} ${entry.label ?? entry.path} (no such processor)`);
				}
			}
		}
		expect(stale, `samples with no processor: ${stale.join(', ')}`).toEqual([]);
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

		it('every config has a lint and a graph record (and a Bloblang one with Bloblang processors) for each pinned version', () => {
			const missing = configs.flatMap((c) => VERSIONS.flatMap((v) => [recordOf(c, v), graphOf(c, v),
				...(withBloblang.includes(c) ? [bloblangRecordOf(c, v)] : [])]))
				.concat(BLOBLANG_FIXTURES.flatMap((c) => VERSIONS.map((v) => bloblangRecordOf(c, v))))
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

		describe('Bloblang parity (4.12)', () => {
			// The pinned binary with no resource or env file settings, as the extension builds it.
			const setup: BloblangCommand = {
				state: { kind: 'ok', path: binaryOf(ver), version: ver, invocation: [binaryOf(ver)] },
				settings: {
					files: () => ({ kind: 'ok', resourceFiles: [], envFile: undefined }),
					envFile: () => ({ kind: 'ok', path: undefined }),
					processEnv: () => process.env,
				},
			};
			for (const config of PARITY_CONFIGS) {
				it(config, async () => {
					const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-bloblang-'));
					try {
						const recordFile = bloblangRecordOf(config, ver);
						if (RECORD) {
							fs.mkdirSync(path.dirname(recordFile), { recursive: true });
							fs.writeFileSync(recordFile, formatBloblangRecord(await recordBloblang(config, ver, dir)));
						}
						if (!fs.existsSync(recordFile)) {
							throw new Error(`${config} has no Bloblang record for redpanda-connect ${ver} (${rel(recordFile)}); ` +
								'run `npm run test:corpus:record`');
						}
						const record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as BloblangRecord;
						const problems = await bloblangParityProblems(config, record, setup, dir);
						expect(problems, [`${config} with redpanda-connect ${ver}: the extension's Bloblang run or parse differs from ` +
							`${rel(recordFile)}:`, ...problems, 'If the record is stale, run `npm run test:corpus:record`.'].join('\n')).toEqual([]);
					} finally {
						fs.rmSync(dir, { recursive: true, force: true });
					}
				});
			}

			// Strictness (WRONG_RECORD): a real record, altered in memory one value at a time, is
			// reported by the same comparison as above, at exactly the altered entry.
			for (const alteration of ALTERATIONS) {
				it(`a recorded ${alteration.name} altered in memory is reported as a mismatch`, async () => {
					const found = withBloblang.map((config) => {
						const file = bloblangRecordOf(config, ver);
						const record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as BloblangRecord : undefined;
						const altered = record && alteration.alter(record);
						return altered && { config, ...altered };
					}).find((a) => a !== undefined);
					expect(found, `no record @ ${ver} has an entry to alter for ${alteration.name}`).toBeDefined();
					const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-bloblang-'));
					try {
						const problems = await bloblangParityProblems(found!.config, found!.record, setup, dir);
						expect(problems.length, `${found!.config}: ${problems.join('\n')}`).toBe(1);
						expect(problems[0].startsWith(`  ${found!.entry}:`), problems[0]).toBe(true);
					} finally {
						fs.rmSync(dir, { recursive: true, force: true });
					}
				});
			}
		});
	});
}
