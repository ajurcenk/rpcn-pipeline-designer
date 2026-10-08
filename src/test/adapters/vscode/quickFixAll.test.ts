import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as zlib from 'zlib';
import { JsonObject, transformSchema } from '../../../core/schema';
import { LINT_SOURCE } from '../../../adapters/vscode/diagnostics';
import { LintQuickFix } from '../../../adapters/vscode/quickFix';
import { SCHEMA_FIXTURES } from '../../helpers/fakeBinary';

const SCHEMA = transformSchema(
	JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'jsonschema-4.112.0.json'), 'utf8')) as JsonObject,
	JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'json-full-4.112.0.json.gz'))).toString('utf8')) as JsonObject,
);

const lint = (doc: vscode.TextDocument, line: number, message: string, source = LINT_SOURCE) => {
	const d = new vscode.Diagnostic(doc.lineAt(line - 1).range, message, vscode.DiagnosticSeverity.Error);
	d.source = source;
	return d;
};
const unknown = (key: string) => `field ${key} not recognised`;
const invalid = (value: string) => `value ${value} is not a valid option for this field`;
const FIX_ALL = /^Fix all lint findings with a clear fix \((\d+)\)$/;

/**
 * Code actions for `text` when the document shows `all` diagnostics and the request carries those at
 * the indices in `requested` (default: the first).
 */
async function run(
	text: string,
	all: (doc: vscode.TextDocument) => vscode.Diagnostic[],
	requested: (list: vscode.Diagnostic[]) => vscode.Diagnostic[] = (list) => list.slice(0, 1),
	schema: () => JsonObject | undefined = () => SCHEMA,
) {
	const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: text });
	const shown = all(doc);
	const context = { diagnostics: requested(shown), only: undefined, triggerKind: vscode.CodeActionTriggerKind.Invoke };
	const provider = new LintQuickFix(schema, (uri) => (uri.toString() === doc.uri.toString() ? shown : []));
	const actions = provider.provideCodeActions(doc, new vscode.Range(0, 0, 0, 0), context);
	return { doc, shown, actions, fixAll: actions.find((a) => FIX_ALL.test(a.title)) };
}

/** The document text after applying every edit of `action` (non-overlapping, as a WorkspaceEdit requires). */
function appliedAll(doc: vscode.TextDocument, action: vscode.CodeAction): string {
	const edits = [...action.edit!.get(doc.uri)].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
	let text = doc.getText();
	for (const { range, newText } of edits) {
		text = text.slice(0, doc.offsetAt(range.start)) + newText + text.slice(doc.offsetAt(range.end));
	}
	return text;
}

const THREE = 'input:\n  socket_server:\n    network: tpc\n    adress: 0.0.0.0:6000\noutput:\n  kafka_franz:\n    seed_brokers: [x]\n    topci: t\n';
const threeFindings = (doc: vscode.TextDocument) => [lint(doc, 3, invalid('tpc')), lint(doc, 4, unknown('adress')), lint(doc, 8, unknown('topci'))];
const THREE_FIXED = THREE.replace('network: tpc', 'network: tcp').replace('adress:', 'address:').replace('topci:', 'topic:');

suite('adapters/vscode LintQuickFix Fix all (2.22)', () => {
	test('THREE: per-finding fixes first, then "Fix all … (3)", one edit with three replaces', async () => {
		const { doc, shown, actions, fixAll } = await run(THREE, threeFindings);
		assert.ok(fixAll, JSON.stringify(actions.map((a) => a.title)));
		assert.strictEqual(fixAll.title, 'Fix all lint findings with a clear fix (3)');
		assert.strictEqual(actions[actions.length - 1], fixAll, 'appended after the per-finding fixes');
		assert.deepStrictEqual(actions.slice(0, -1).map((a) => [a.title, a.isPreferred]).slice(0, 1), [['Change to `tcp`', true]]);
		assert.strictEqual(fixAll.kind?.value, vscode.CodeActionKind.QuickFix.value);
		assert.strictEqual(fixAll.isPreferred, false, 'Auto Fix keeps choosing the per-finding fix');
		assert.deepStrictEqual(fixAll.diagnostics, shown);
		assert.strictEqual(fixAll.edit!.get(doc.uri).length, 3);
		assert.strictEqual(appliedAll(doc, fixAll), THREE_FIXED);
	});

	test('FROM_ANY_LINE: a request on the last finding alone still covers all three', async () => {
		const { doc, actions, fixAll } = await run(THREE, threeFindings, (list) => [list[2]]);
		assert.strictEqual(actions[0].title, 'Change to `topic`');
		assert.strictEqual(fixAll?.title, 'Fix all lint findings with a clear fix (3)');
		assert.strictEqual(appliedAll(doc, fixAll), THREE_FIXED);
	});

	test('SKIP_UNCLEAR: an option fallback (no preferred fix) is left out of N and unchanged', async () => {
		const text = `${THREE.replace('    adress: 0.0.0.0:6000\n', '    adress: 0.0.0.0:6000\n    tls:\n      client_auth: maybe\n')}`;
		const { doc, fixAll } = await run(text, (d) => [
			lint(d, 3, invalid('tpc')), lint(d, 4, unknown('adress')), lint(d, 6, invalid('maybe')), lint(d, 10, unknown('topci'))]);
		assert.strictEqual(fixAll?.title, 'Fix all lint findings with a clear fix (3)');
		assert.strictEqual(fixAll.diagnostics?.length, 3);
		assert.ok(fixAll.diagnostics.every((d) => d.message !== invalid('maybe')));
		const fixed = appliedAll(doc, fixAll);
		assert.ok(fixed.includes('client_auth: maybe\n'));
		assert.strictEqual(fixed, text.replace('network: tpc', 'network: tcp').replace('adress:', 'address:').replace('topci:', 'topic:'));
	});

	test('SKIP_UNCLEAR: a ranking tie is left out of N and unchanged', async () => {
		const fake = { properties: { x: { properties: { abd: {}, abe: {}, foo: {}, bar: {} } } } };
		const text = 'x:\n  abc: 1\n  fooo: 2\n  barr: 3\n';
		const { doc, fixAll } = await run(text, (d) => [lint(d, 2, unknown('abc')), lint(d, 3, unknown('fooo')), lint(d, 4, unknown('barr'))],
			(list) => [list[0]], () => fake);
		assert.strictEqual(fixAll?.title, 'Fix all lint findings with a clear fix (2)');
		assert.ok(fixAll.diagnostics?.every((d) => d.message !== unknown('abc')));
		assert.strictEqual(appliedAll(doc, fixAll), 'x:\n  abc: 1\n  foo: 2\n  bar: 3\n');
	});

	test('ONE: a lone fixable finding gives no Fix all', async () => {
		const single = await run(THREE, (d) => [lint(d, 8, unknown('topci'))]);
		assert.strictEqual(single.actions[0].title, 'Change to `topic`');
		assert.strictEqual(single.fixAll, undefined);
	});

	test('ONE: one fixable finding beside an unclear one gives no Fix all', async () => {
		const text = 'input:\n  socket_server:\n    network: tpc\n    tls:\n      client_auth: maybe\n';
		const withUnclear = await run(text, (d) => [lint(d, 3, invalid('tpc')), lint(d, 5, invalid('maybe'))], (list) => list);
		assert.ok(withUnclear.actions.length > 1, 'both findings get their per-finding fixes');
		assert.strictEqual(withUnclear.fixAll, undefined);
	});

	test('SAME_RANGE: two diagnostics for the same token are one replace (and alone give no Fix all)', async () => {
		const twice = await run(THREE, (d) => [lint(d, 8, unknown('topci')), lint(d, 8, unknown('topci'))]);
		assert.strictEqual(twice.fixAll, undefined, 'one replace is the per-finding fix');
		const { doc, shown, fixAll } = await run(THREE, (d) => [lint(d, 8, unknown('topci')), lint(d, 3, invalid('tpc')), lint(d, 8, unknown('topci'))]);
		assert.strictEqual(fixAll?.title, 'Fix all lint findings with a clear fix (3)');
		assert.strictEqual(fixAll.edit!.get(doc.uri).length, 2);
		assert.strictEqual(fixAll.diagnostics?.length, 3, 'both copies are fixed by the one replace');
		assert.ok(shown.every((d) => fixAll.diagnostics!.includes(d)));
		assert.strictEqual(appliedAll(doc, fixAll), THREE.replace('network: tpc', 'network: tcp').replace('topci:', 'topic:'));
	});

	test('FLOW: two flagged keys in one flow mapping are both replaced in one edit', async () => {
		const text = 'input:\n  socket_server: {netwrk: tcp, adress: x}\n';
		const { doc, fixAll } = await run(text, (d) => [lint(d, 2, unknown('netwrk')), lint(d, 2, unknown('adress'))]);
		assert.strictEqual(fixAll?.title, 'Fix all lint findings with a clear fix (2)');
		assert.strictEqual(appliedAll(doc, fixAll), 'input:\n  socket_server: {network: tcp, address: x}\n');
	});

	test('NO_SCHEMA: no actions at all', async () => {
		const { actions } = await run(THREE, threeFindings, undefined, () => undefined);
		assert.deepStrictEqual(actions, []);
	});

	test('Red Hat diagnostics are neither fixed nor counted, and a request with none of ours gets nothing', async () => {
		const { fixAll } = await run(THREE, (d) => [lint(d, 3, invalid('tpc')), lint(d, 8, unknown('topci'), 'YAML')]);
		assert.strictEqual(fixAll, undefined);
		const redHatOnly = await run(THREE, (d) => [lint(d, 8, unknown('topci'), 'YAML'), ...threeFindings(d)]);
		assert.deepStrictEqual(redHatOnly.actions, []);
	});

	test('a throwing allDiagnostics keeps the per-finding fixes and never throws', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: THREE });
		const provider = new LintQuickFix(() => SCHEMA, () => { throw new Error('boom'); });
		const context = { diagnostics: [lint(doc, 8, unknown('topci'))], only: undefined, triggerKind: vscode.CodeActionTriggerKind.Invoke };
		const list = provider.provideCodeActions(doc, new vscode.Range(0, 0, 0, 0), context);
		assert.strictEqual(list[0].title, 'Change to `topic`');
		assert.ok(list.every((a) => !FIX_ALL.test(a.title)));
	});
});
