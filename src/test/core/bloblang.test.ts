import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
	BLOBLANG_FIELDS, BLOBLANG_KEY, bloblangCatalogOf, bloblangContext, bloblangHoverAt, bloblangItems, bloblangMarkdown, bloblangSnippet,
} from '../../core/bloblang';
import { JsonObject, transformSchema } from '../../core/schema';
import { parseYaml } from '../../core/yamlPath';
import { REPO_ROOT, SCHEMA_FIXTURES } from '../helpers/fakeBinary';

const SCHEMA = transformSchema(
	JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'jsonschema-4.112.0.json'), 'utf8')) as JsonObject,
	JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'json-full-4.112.0.json.gz'))).toString('utf8')) as JsonObject,
);
const CATALOG = bloblangCatalogOf(SCHEMA)!;

/** The context at `§` in `marked` (the marker is removed; `|` is YAML's block indicator). */
function ctx(marked: string) {
	const offset = marked.indexOf('§');
	const text = marked.replace('§', '');
	return bloblangContext(parseYaml(text), text, offset);
}
const block = (line: string) => `pipeline:\n  processors:\n    - mapping: |\n        ${line}\n`;

suite('core/bloblang (2.19, 4.112.0 docs)', () => {
	test('the catalog: 39 functions (2 hidden left out) and 193 methods, in the served schema', () => {
		assert.strictEqual(CATALOG.functions.length, 39);
		assert.strictEqual(CATALOG.methods.length, 193);
		const names = CATALOG.functions.map((f) => f.name);
		assert.ok(names.includes('now') && names.includes('uuid_v4') && names.includes('random_int'));
		assert.ok(!names.includes('nothing') && !names.includes('var'), 'hidden functions are left out');
		assert.strictEqual(CATALOG.functions.find((f) => f.name === 'meta')!.status, 'deprecated');
		assert.strictEqual(CATALOG.methods.find((m) => m.name === 'replace_all')!.category, 'String Manipulation');
		assert.ok(SCHEMA[BLOBLANG_KEY], 'stored under the private key');
	});

	test('without docs there is no catalog', () => {
		const raw = JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'jsonschema-4.112.0.json'), 'utf8')) as JsonObject;
		assert.strictEqual(bloblangCatalogOf(transformSchema(raw)), undefined);
	});

	test('the field list equals the injection grammar\'s key list', () => {
		const grammar = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'syntaxes', 'bloblang.injection.tmLanguage.json'), 'utf8'));
		const keys = /\(\?:([^)]*)\)/.exec(grammar.repository.plain.match)![1].split('|');
		assert.deepStrictEqual([...BLOBLANG_FIELDS].sort(), [...keys].sort());
	});

	test('functions at an expression position; methods after a dot', () => {
		const fn = ctx(block('root.id = §'))!;
		assert.deepStrictEqual([fn.kind, fn.prefix, fn.start], ['function', '', block('root.id = ').length - 1]);
		assert.deepStrictEqual(ctx(block('root.n = this.name.up§'))?.kind, 'method');
		assert.deepStrictEqual(ctx(block('root.n = this.name.up§'))?.prefix, 'up');
		assert.strictEqual(ctx('pipeline:\n  processors:\n    - switch:\n        - check: this.a.§\n')?.kind, 'method');
		assert.strictEqual(ctx('pipeline:\n  processors:\n    - mapping: root = no§\n')?.kind, 'function', 'plain value');
		assert.strictEqual(ctx("pipeline:\n  processors:\n    - mapping: 'root = no§'\n")?.kind, 'function', 'single-quoted value');
		assert.strictEqual(ctx('output:\n  file:\n    path: /tmp/${! no§ }.txt\n')?.kind, 'function', 'interpolation');
	});

	test('nothing in strings, comments, metadata keys, variables, or outside Bloblang', () => {
		assert.strictEqual(ctx(block('root = "str§"')), undefined);
		assert.strictEqual(ctx(block('# comm§')), undefined);
		assert.strictEqual(ctx(block('root = this # x.§')), undefined);
		assert.strictEqual(ctx(block('root.k = @sou§'))?.kind, 'metadata', 'metadata names (2.20)');
		assert.strictEqual(ctx(block('let x = $va§'))?.kind, 'variable', 'variable names (2.20)');
		assert.strictEqual(ctx('pipeline:\n  processors:\n    - log:\n        message: root = §\n'), undefined);
		assert.strictEqual(ctx('output:\n  file:\n    path: /tmp/x§.txt\n'), undefined);
		assert.strictEqual(ctx('input:\n  stdin: {}\nlogger:\n  level: §\n'), undefined);
	});

	test('items: deprecated entries last', () => {
		const items = bloblangItems(CATALOG, { kind: 'function', prefix: '', start: 0 });
		const firstDeprecated = items.findIndex((e) => e.status === 'deprecated');
		assert.ok(firstDeprecated > 0 && items.slice(firstDeprecated).every((e) => e.status === 'deprecated'));
		assert.strictEqual(bloblangItems(CATALOG, { kind: 'method', prefix: '', start: 0 }).length, 193);
	});

	test('snippets: placeholders for required parameters only', () => {
		const fn = (n: string) => CATALOG.functions.find((f) => f.name === n)!;
		const m = (n: string) => CATALOG.methods.find((f) => f.name === n)!;
		assert.strictEqual(bloblangSnippet(fn('now')), 'now()');
		assert.strictEqual(bloblangSnippet(fn('random_int')), 'random_int($0)', 'all parameters have defaults');
		assert.strictEqual(bloblangSnippet(m('uppercase')), 'uppercase()');
		assert.strictEqual(bloblangSnippet(m('replace_all')), 'replace_all(${1:old}, ${2:new})');
	});

	test('markdown: title, description, parameters, example', () => {
		const md = bloblangMarkdown(CATALOG.methods.find((f) => f.name === 'replace_all')!);
		assert.ok(md.startsWith('**replace_all** method · String Manipulation'));
		assert.ok(md.includes('- `old` (string): A string to match against.'));
		assert.ok(md.includes('```coffee\nroot.new_value = this.value.replace_all("foo","dog")'));
		assert.ok(bloblangMarkdown(CATALOG.functions.find((f) => f.name === 'meta')!).includes('(deprecated)'));
	});

	test('hover: a function or method name followed by ( in Bloblang', () => {
		const text = block('root.at = now()\n        root.n = this.name.uppercase()');
		const hover = (needle: string) => bloblangHoverAt(CATALOG, parseYaml(text), text, text.indexOf(needle) + 1);
		assert.strictEqual(hover('now')?.entry.kind, 'function');
		assert.strictEqual(hover('uppercase')?.entry.name, 'uppercase');
		assert.strictEqual(hover('uppercase')?.entry.kind, 'method');
		assert.strictEqual(hover('name'), undefined, 'a field, not a call');
		const plain = 'pipeline:\n  processors:\n    - log:\n        message: now()\n';
		assert.strictEqual(bloblangHoverAt(CATALOG, parseYaml(plain), plain, plain.indexOf('now') + 1), undefined, 'outside Bloblang');
	});

	test('review fixes: double-quoted values and interpolations, unterminated and nested ${!, triple strings, decimals', () => {
		assert.strictEqual(ctx('output:\n  file:\n    path: "${! no§ }"\n')?.kind, 'function', 'double-quoted interpolation');
		assert.strictEqual(ctx('x:\n  message: "id ${! this.id.§ }"\n')?.kind, 'method');
		assert.strictEqual(ctx('pipeline:\n  processors:\n    - mapping: "root = \\"a\\" + no§"\n')?.kind, 'function', 'YAML \\" escapes');
		assert.strictEqual(ctx('output:\n  file:\n    path: /tmp/${! now\nother:\n  key: §\n'), undefined, 'an open ${! stops at its line');
		assert.strictEqual(ctx('output:\n  file:\n    path: /tmp/${! no§\n')?.kind, 'function', '... but works on its own line');
		assert.strictEqual(ctx('x:\n  k: ${! {"a":1}.a.§ }\n')?.kind, 'method', 'nested braces');
		const q = '"' + '"' + '"';
		assert.strictEqual(ctx(block(`root = ${q}\n        abc. §\n        ${q}`)), undefined, 'inside a multi-line triple-quoted string');
		assert.strictEqual(ctx(block(`root = ${q}x${q}\n        root.b = no§`))?.kind, 'function', 'after a closed triple string');
		assert.strictEqual(ctx('pipeline:\n  processors:\n    - mapping: root = 1.§\n'), undefined, 'a decimal point');
	});

	test('review fixes: variadic snippets, an existing paren, AsciiDoc cross-references', () => {
		const m = (n: string) => CATALOG.methods.find((f) => f.name === n)!;
		assert.strictEqual(m('format').variadic, true);
		assert.strictEqual(bloblangSnippet(m('format')), 'format($0)');
		assert.strictEqual(bloblangSnippet(m('replace_all'), true), 'replace_all', 'a ( already follows');
		const all = [...CATALOG.functions, ...CATALOG.methods];
		assert.deepStrictEqual(all.filter((e) => e.description?.includes('<<')).map((e) => e.name), []);
	});

	test('hover inside a double-quoted interpolation', () => {
		const text = 'x:\n  message: "${! now() }"\n';
		assert.strictEqual(bloblangHoverAt(CATALOG, parseYaml(text), text, text.indexOf('now') + 1)?.entry.name, 'now');
	});
});

