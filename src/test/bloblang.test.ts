import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { REPO_ROOT, SCHEMA_FIXTURES } from './helpers/fakeBinary';
import { scopesOf, Token, tokenize } from './helpers/tokenize';

const has = (scopes: readonly string[] | undefined, scope: string) => !!scopes?.some((s) => s === scope || s.startsWith(`${scope} `));
const anyBloblang = (scopes: readonly string[] | undefined) => !!scopes?.some((s) => s.includes('bloblang'));

/** Every token text on `line` that carries `scope`. */
const withScope = (lines: Token[][], line: number, scope: string) =>
	(lines[line] ?? []).filter((t) => t.scopes.includes(scope)).map((t) => t.text.trim());

suite('Bloblang highlighting (2.9, VS Code YAML grammar + our injection)', () => {
	test('a block scalar under mapping: is Bloblang to its end, and YAML resumes after it', async () => {
		const lines = await tokenize([
			'pipeline:',
			'  processors:',
			'    - mapping: |',
			'        # comment',
			'        root = this',
			'        root.at = now()',
			'        root.n = this.name.uppercase()',
			'        let x = $y + 1',
			'        root.k = @kafka_key',
			'    - log:',
			'        message: root = this',
		].join('\n'));
		assert.ok(has(scopesOf(lines, 3, '# comment'), 'comment.line.number-sign.bloblang'), JSON.stringify(lines[3]));
		assert.ok(has(scopesOf(lines, 4, 'root'), 'variable.language.bloblang'));
		assert.ok(has(scopesOf(lines, 4, 'this'), 'variable.language.bloblang'));
		assert.ok(has(scopesOf(lines, 5, 'now'), 'entity.name.function.bloblang'));
		assert.ok(has(scopesOf(lines, 6, 'uppercase'), 'entity.name.function.method.bloblang'));
		assert.ok(has(scopesOf(lines, 7, 'let'), 'keyword.control.bloblang'));
		assert.ok(has(scopesOf(lines, 7, '$y'), 'variable.other.bloblang'));
		assert.ok(has(scopesOf(lines, 7, '1'), 'constant.numeric.bloblang'));
		assert.ok(has(scopesOf(lines, 8, '@kafka_key'), 'variable.other.metadata.bloblang'));
		assert.ok(!anyBloblang(scopesOf(lines, 9, 'log')), 'the next processor is YAML again');
		assert.ok(!anyBloblang(scopesOf(lines, 10, 'root = this')), 'message: is a plain YAML string, not Bloblang');
	});

	test('a sibling key after a dash-item block ends the Bloblang block', async () => {
		const lines = await tokenize(['- mapping: |', '    root = this', '  label: x'].join('\n'));
		assert.ok(has(scopesOf(lines, 1, 'root'), 'variable.language.bloblang'));
		assert.ok(!anyBloblang(scopesOf(lines, 2, 'x')), JSON.stringify(lines[2]));
	});

	test('single-line plain, single-quoted and double-quoted check / mapping values', async () => {
		const lines = await tokenize([
			"cases:",
			"  - check: this.type == \"foo\"   # yaml comment",
			"    processors: []",
			"  - check: 'this.n > 1'",
			"  - check: \"this.ok\"",
			"mapping: root = this",
		].join('\n'));
		assert.ok(has(scopesOf(lines, 1, 'this'), 'variable.language.bloblang'));
		assert.ok(has(scopesOf(lines, 1, '=='), 'keyword.operator.bloblang'));
		assert.ok(withScope(lines, 1, 'string.quoted.double.bloblang').includes('foo'));
		assert.ok(!anyBloblang(scopesOf(lines, 1, '# yaml comment')), 'the YAML comment stays a YAML comment');
		assert.ok(!anyBloblang(scopesOf(lines, 2, 'processors')));
		assert.ok(has(scopesOf(lines, 3, 'this'), 'variable.language.bloblang'), JSON.stringify(lines[3]));
		assert.ok(has(scopesOf(lines, 4, 'this'), 'variable.language.bloblang'), JSON.stringify(lines[4]));
		assert.ok(has(scopesOf(lines, 5, 'root'), 'variable.language.bloblang'), JSON.stringify(lines[5]));
	});

	test('${! } interpolations are Bloblang inside any YAML string; plain strings are untouched', async () => {
		const lines = await tokenize([
			'output:',
			'  kafka_franz:',
			'    topic: events',
			'    key: ${! json("id") }',
			'    path: "/tmp/${!meta(\\"k\\")}.txt"',
			'    description: root = this',
		].join('\n'));
		assert.ok(!anyBloblang(scopesOf(lines, 2, 'events')));
		assert.ok(has(scopesOf(lines, 3, '${!'), 'punctuation.section.interpolation.begin.bloblang'), JSON.stringify(lines[3]));
		assert.ok(has(scopesOf(lines, 3, 'json'), 'entity.name.function.bloblang'));
		assert.ok(has(scopesOf(lines, 3, '}'), 'punctuation.section.interpolation.end.bloblang'));
		assert.ok(withScope(lines, 4, 'meta.interpolation.bloblang').length > 0, JSON.stringify(lines[4]));
		assert.ok(!anyBloblang(scopesOf(lines, 5, 'root = this')));
	});

	test('a triple-quoted Bloblang string with YAML-looking text stays one string until it closes', async () => {
		const q = '"' + '"' + '"';
		const lines = await tokenize(['mapping: |', `  root = ${q}`, '  key: ${! x }', `  ${q}`, '  root.y = 1', 'output: x'].join('\n'));
		assert.ok(lines[2].every((t) => t.scopes.includes('string.quoted.triple.bloblang')), JSON.stringify(lines[2]));
		assert.ok(has(scopesOf(lines, 4, 'root'), 'variable.language.bloblang'), 'Bloblang resumes after the string');
		assert.ok(!anyBloblang(scopesOf(lines, 5, 'output')));
	});

	test('generic keys in other YAML files are not touched (when:, variables:, query:)', async () => {
		const lines = await tokenize(['when: this == that', 'variables: x', 'query: SELECT * FROM t'].join('\n'));
		for (let i = 0; i < 3; i++) {
			assert.ok(lines[i].every((t) => !anyBloblang(t.scopes)), JSON.stringify(lines[i]));
		}
	});

	test('corpus configs: every mapping block line is Bloblang and every ${! } is an interpolation', async () => {
		const corpus = path.join(REPO_ROOT, 'test', 'corpus');
		let blocks = 0;
		let interpolations = 0;
		for (const name of ['deduplicate.yaml', 'eval.yaml', 'cdc_replication.yaml']) {
			const text = fs.readFileSync(path.join(corpus, name), 'utf8');
			const lines = await tokenize(text);
			text.split('\n').forEach((line, i) => {
				// Inside a Bloblang block a ${! } is string content (eval.yaml embeds a whole config in a
				// triple-quoted prompt); everywhere else it must be an interpolation.
				const insideBloblang = lines[i].some((t) => t.text.includes('${!') && t.scopes.some((sc) => /^string\..*\.bloblang$/.test(sc)));
				if (line.includes('${!') && !insideBloblang) {
					interpolations++;
					assert.ok(lines[i].some((t) => t.scopes.includes('meta.interpolation.bloblang')), `${name}:${i + 1} ${line}`);
				}
				if (/^\s*(?:-\s+)?mapping:\s*\|/.test(line)) {
					blocks++;
					const next = text.split('\n')[i + 1] ?? '';
					if (next.trim()) {
						assert.ok(lines[i + 1].some((t) => t.scopes.includes('source.bloblang')), `${name}:${i + 2} ${next}`);
					}
				}
			});
		}
		assert.ok(blocks > 0 && interpolations > 0, `blocks ${blocks}, interpolations ${interpolations}`);
	});

	test('every key in the grammar is Bloblang wherever it appears in the 4.112.0 docs', () => {
		const grammar = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'syntaxes', 'bloblang.injection.tmLanguage.json'), 'utf8'));
		const keys = /\(\?:([^)]*)\)/.exec(grammar.repository.plain.match)![1].split('|');
		const docs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'json-full-4.112.0.json.gz'))).toString('utf8'));
		const seen = new Map<string, { bloblang: number; other: number }>();
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) {
				node.forEach(walk);
			} else if (node && typeof node === 'object') {
				const f = node as Record<string, unknown>;
				if (typeof f.name === 'string' && typeof f.kind === 'string' && typeof f.type === 'string') {
					const entry = seen.get(f.name) ?? { bloblang: 0, other: 0 };
					entry[f.bloblang === true ? 'bloblang' : 'other']++;
					seen.set(f.name, entry);
				}
				Object.values(f).forEach(walk);
			}
		};
		['config', 'buffers', 'caches', 'inputs', 'outputs', 'processors', 'rate-limits', 'metrics', 'tracers', 'scanners'].forEach((k) => walk(docs[k]));
		const processors = new Map((docs.processors as { name: string; config?: { bloblang?: boolean } }[]).map((p) => [p.name, p.config?.bloblang === true]));
		for (const key of keys) {
			const field = seen.get(key);
			const isBloblangProcessor = processors.get(key) === true;
			assert.ok(isBloblangProcessor || (field && field.bloblang > 0 && field.other === 0), `${key}: ${JSON.stringify(field)}`);
		}
	});
});

