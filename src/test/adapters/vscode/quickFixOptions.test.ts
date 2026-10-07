import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as zlib from 'zlib';
import { JsonObject, transformSchema } from '../../../core/schema';
import { optionsAt } from '../../../core/schemaFields';
import { rankNames } from '../../../core/suggest';
import { findValueOnLine, parseYaml, yamlString } from '../../../core/yamlPath';
import { LINT_SOURCE } from '../../../adapters/vscode/diagnostics';
import { LintQuickFix, MAX_FALLBACK_OPTIONS } from '../../../adapters/vscode/quickFix';
import { SCHEMA_FIXTURES } from '../../helpers/fakeBinary';

const SCHEMA = transformSchema(
	JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'jsonschema-4.112.0.json'), 'utf8')) as JsonObject,
	JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'json-full-4.112.0.json.gz'))).toString('utf8')) as JsonObject,
);

const lint = (doc: vscode.TextDocument, line: number, message: string) => {
	const d = new vscode.Diagnostic(doc.lineAt(line - 1).range, message, vscode.DiagnosticSeverity.Error);
	d.source = LINT_SOURCE;
	return d;
};
const invalid = (value: string) => `value ${value} is not a valid option for this field`;

async function fixes(text: string, line: number, message: string, schema: () => JsonObject | undefined = () => SCHEMA) {
	const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: text });
	const context = { diagnostics: [lint(doc, line, message)], only: undefined, triggerKind: vscode.CodeActionTriggerKind.Invoke };
	return { doc, actions: new LintQuickFix(schema).provideCodeActions(doc, new vscode.Range(0, 0, 0, 0), context) };
}

function applied(doc: vscode.TextDocument, action: vscode.CodeAction): string {
	const [{ range, newText }] = action.edit!.get(doc.uri);
	const text = doc.getText();
	return text.slice(0, doc.offsetAt(range.start)) + newText + text.slice(doc.offsetAt(range.end));
}

const titles = (list: vscode.CodeAction[]) => list.map((a) => [a.title, a.isPreferred]);
const SOCKET = 'input:\n  socket_server:\n    network: tpc   # was tcp\n    address: 0.0.0.0:6000\n    tls:\n      client_auth: maybe\noutput:\n  stdout: {}\n';

suite('core option-fix pieces (2.14)', () => {
	test('findValueOnLine: key, path and the value range (quotes included)', () => {
		const text = 'input:\n  socket_server:\n    network: "tpc"\n';
		const loc = findValueOnLine(parseYaml(text), 3, 'tpc')!;
		assert.deepStrictEqual([loc.path, loc.key, text.slice(loc.start, loc.end)], [['input', 'socket_server'], 'network', '"tpc"']);
	});

	test('findValueOnLine: an anchored value is skipped (lint reports aliases at the anchor)', () => {
		assert.strictEqual(findValueOnLine(parseYaml('x: &a tpc\ny: *a\n'), 1, 'tpc'), undefined);
	});

	test('findValueOnLine: not a key, not another line, not twice', () => {
		assert.strictEqual(findValueOnLine(parseYaml('tpc: x\n'), 1, 'tpc'), undefined);
		assert.strictEqual(findValueOnLine(parseYaml('a: tpc\nb: x\n'), 2, 'tpc'), undefined);
		assert.strictEqual(findValueOnLine(parseYaml('{a: tpc, b: tpc}\n'), 1, 'tpc'), undefined);
	});

	test('optionsAt: the field\'s options, [] without', () => {
		assert.deepStrictEqual(optionsAt(SCHEMA, ['input', 'socket_server'], 'network'), ['unix', 'tcp', 'udp', 'tls', 'unixgram']);
		assert.deepStrictEqual(optionsAt(SCHEMA, ['logger'], 'format'), ['json', 'logfmt']);
		assert.deepStrictEqual(optionsAt(SCHEMA, ['output', 'file'], 'path'), []);
		assert.deepStrictEqual(optionsAt(SCHEMA, ['nope'], 'x'), []);
	});

	test('rankNames ignoreCase', () => {
		assert.deepStrictEqual(rankNames('JSN', ['json', 'logfmt'], [], true).map((s) => s.name), ['json']);
		assert.deepStrictEqual(rankNames('JSN', ['json', 'logfmt']).map((s) => s.name), []);
	});

	test('yamlString: plain when YAML reads it back unchanged, else double-quoted', () => {
		assert.deepStrictEqual(['tcp', 'delim:x', 'all-bytes', 'require_any'].map(yamlString), ['tcp', 'delim:x', 'all-bytes', 'require_any']);
		assert.deepStrictEqual(['OFF', 'no', 'true', '1', '~', 'a: b', 'x #y', ' sp', '[a]', '*x', 'a,b', 'a]', '%x', '-x', '@x'].map(yamlString),
			['"OFF"', '"no"', '"true"', '"1"', '"~"', '"a: b"', '"x #y"', '" sp"', '"[a]"', '"*x"', '"a,b"', '"a]"', '"%x"', '"-x"', '"@x"']);
		assert.strictEqual(yamlString('a-b'), 'a-b');
	});
});

suite('adapters/vscode LintQuickFix option values (2.14)', () => {
	test('CLOSE: tpc → "Change to `tcp`" preferred; only the value changes', async () => {
		const { doc, actions } = await fixes(SOCKET, 3, invalid('tpc'));
		assert.deepStrictEqual(titles(actions)[0], ['Change to `tcp`', true]);
		assert.strictEqual(applied(doc, actions[0]), SOCKET.replace('network: tpc', 'network: tcp'));
	});

	test('CASE: JSN → json (lint compares case-insensitively)', async () => {
		const { actions } = await fixes('input:\n  stdin: {}\nlogger:\n  format: JSN\n', 4, invalid('JSN'));
		assert.deepStrictEqual(titles(actions), [['Change to `json`', true]]);
	});

	test('FALLBACK: nothing close in a short closed list → all options, none preferred, quoted where needed', async () => {
		const { doc, actions } = await fixes(SOCKET, 6, invalid('maybe'));
		assert.deepStrictEqual(titles(actions), [
			['Change to `no`', false], ['Change to `request`', false], ['Change to `require_any`', false],
			['Change to `require_valid`', false], ['Change to `verify_if_given`', false],
		]);
		assert.strictEqual(applied(doc, actions[0]), SOCKET.replace('client_auth: maybe', 'client_auth: "no"'));
	});

	test('TOP_LEVEL: logger.format xml → json and logfmt (fallback)', async () => {
		const { actions } = await fixes('input:\n  stdin: {}\nlogger:\n  format: xml\n', 4, invalid('xml'));
		assert.deepStrictEqual(titles(actions), [['Change to `json`', false], ['Change to `logfmt`', false]]);
	});

	test('LONG_LIST: a far-off value in a list of more than 5 gets nothing', async () => {
		assert.ok(optionsAt(SCHEMA, ['logger'], 'level').length > MAX_FALLBACK_OPTIONS);
		const text = 'input:\n  stdin: {}\nlogger:\n  level: verbose\n';
		assert.deepStrictEqual((await fixes(text, 4, invalid('verbose'))).actions, []);
		// Positive control: a close value on the same field gets a fix.
		assert.strictEqual((await fixes(text.replace('verbose', 'DEBG'), 4, invalid('DEBG'))).actions[0].title, 'Change to `DEBUG`');
	});

	test('NEEDS_QUOTES: OF → "OFF" (quoted)', async () => {
		const text = 'input:\n  stdin: {}\nlogger:\n  level: OF\n';
		const { doc, actions } = await fixes(text, 4, invalid('OF'));
		assert.strictEqual(actions[0].title, 'Change to `OFF`');
		assert.strictEqual(applied(doc, actions[0]), text.replace('level: OF', 'level: "OFF"'));
	});

	test('QUOTED: a quoted wrong value is replaced, quotes included', async () => {
		const text = "input:\n  socket_server:\n    network: 'tpc'\n";
		const { doc, actions } = await fixes(text, 3, invalid('tpc'));
		assert.strictEqual(applied(doc, actions[0]), text.replace("'tpc'", 'tcp'));
	});

	test('NO_MATCH / NO_OPTIONS / no schema: no actions', async () => {
		assert.deepStrictEqual((await fixes(SOCKET, 2, invalid('tpc'))).actions, []);
		const noOptions = await fixes('output:\n  file:\n    path: tpc\n', 3, invalid('tpc'));
		assert.deepStrictEqual(noOptions.actions, []);
		assert.ok(findValueOnLine(parseYaml(noOptions.doc.getText()), 3, 'tpc'), 'found, but the field has no options');
		assert.deepStrictEqual((await fixes(SOCKET, 3, invalid('tpc'), () => undefined)).actions, []);
	});

	test('a numeric value falls back to the whole short list; a flow mapping is edited in place', async () => {
		const numeric = await fixes('input:\n  socket_server:\n    network: 1\n', 3, invalid('1'));
		assert.strictEqual(numeric.actions.length, 5);
		const flow = 'input:\n  socket_server: {network: tpc, address: x}\n';
		const { doc, actions } = await fixes(flow, 2, invalid('tpc'));
		assert.strictEqual(applied(doc, actions[0]), flow.replace('network: tpc', 'network: tcp'));
	});

	test('BOTH: one request with an unknown field and an invalid option', async () => {
		const text = 'input:\n  socket_server:\n    netwrk: x\n    address: y\nlogger:\n  format: jsn\n';
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: text });
		const context = { diagnostics: [lint(doc, 3, 'field netwrk not recognised'), lint(doc, 6, invalid('jsn'))],
			only: undefined, triggerKind: vscode.CodeActionTriggerKind.Invoke };
		const list = new LintQuickFix(() => SCHEMA).provideCodeActions(doc, new vscode.Range(0, 0, 0, 0), context);
		assert.ok(list.some((a) => a.title === 'Change to `network`'), JSON.stringify(list.map((a) => a.title)));
		assert.ok(list.some((a) => a.title === 'Change to `json`'));
	});
});
