import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { JsonObject } from '../../../core/schema';
import { LINT_SOURCE } from '../../../adapters/vscode/diagnostics';
import { UnknownFieldQuickFix } from '../../../adapters/vscode/quickFix';
import { SCHEMA_FIXTURES } from '../../helpers/fakeBinary';

const SCHEMA = JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'jsonschema-4.112.0.json'), 'utf8')) as JsonObject;

function lintDiagnostic(doc: vscode.TextDocument, line: number, message: string, source = LINT_SOURCE): vscode.Diagnostic {
	const d = new vscode.Diagnostic(doc.lineAt(line - 1).range, message, vscode.DiagnosticSeverity.Error);
	d.source = source;
	return d;
}

async function actions(text: string, diagnostics: (doc: vscode.TextDocument) => vscode.Diagnostic[], schema: () => JsonObject | undefined = () => SCHEMA) {
	const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: text });
	const context = { diagnostics: diagnostics(doc), only: undefined, triggerKind: vscode.CodeActionTriggerKind.Invoke };
	return { doc, actions: new UnknownFieldQuickFix(schema).provideCodeActions(doc, new vscode.Range(0, 0, 0, 0), context) };
}

/** The document text after applying `action`'s edit to `text` (no editor needed). */
function applied(doc: vscode.TextDocument, action: vscode.CodeAction): string {
	const edits = action.edit!.get(doc.uri);
	assert.strictEqual(edits.length, 1);
	const { range, newText } = edits[0];
	const text = doc.getText();
	return text.slice(0, doc.offsetAt(range.start)) + newText + text.slice(doc.offsetAt(range.end));
}

suite('adapters/vscode UnknownFieldQuickFix', () => {
	test('OUTPUT_FIELD: "Change to `topic`" first and preferred, carrying the diagnostic', async () => {
		const { doc, actions: list } = await actions('output:\n  kafka_franz:\n    seed_brokers: [x]\n    topci: t\n',
			(d) => [lintDiagnostic(d, 4, 'field topci not recognised')]);
		assert.strictEqual(list[0].title, 'Change to `topic`');
		assert.strictEqual(list[0].kind?.value, vscode.CodeActionKind.QuickFix.value);
		assert.strictEqual(list[0].isPreferred, true);
		assert.ok(list.slice(1).every((a) => !a.isPreferred));
		assert.strictEqual(list[0].diagnostics?.[0].message, 'field topci not recognised');
		assert.strictEqual(applied(doc, list[0]), 'output:\n  kafka_franz:\n    seed_brokers: [x]\n    topic: t\n');
	});

	test('MINIMAL_EDIT / QUOTED_KEY: only the key token changes; comments, ${ENV} and spacing are kept', async () => {
		const text = '# head\noutput:   # out\n  kafka_franz:\n    seed_brokers: [ "${BROKER}" ]\n    "topci" :   ${TOPIC:x}  # keep\n';
		const { doc, actions: list } = await actions(text, (d) => [lintDiagnostic(d, 5, 'field topci not recognised')]);
		assert.strictEqual(applied(doc, list[0]),
			'# head\noutput:   # out\n  kafka_franz:\n    seed_brokers: [ "${BROKER}" ]\n    topic :   ${TOPIC:x}  # keep\n');
	});

	test('NO_SCHEMA: no actions', async () => {
		const { actions: list } = await actions('inptu: {}\n', (d) => [lintDiagnostic(d, 1, 'field inptu not recognised')], () => undefined);
		assert.deepStrictEqual(list, []);
	});

	test('OTHER_DIAGNOSTIC: Red Hat and other lint messages get no actions', async () => {
		const { actions: list } = await actions('inptu: {}\n', (d) => [
			lintDiagnostic(d, 1, 'field inptu not recognised', 'YAML'),
			lintDiagnostic(d, 1, 'field inptu is deprecated'),
			lintDiagnostic(d, 1, 'field inptu is invalid when the component type is mapping (processor)'),
		]);
		assert.deepStrictEqual(list, []);
	});

	test('NO_MATCH: a diagnostic whose key is not on its line gets no actions', async () => {
		const { actions: list } = await actions('input:\n  inptu: {}\n', (d) => [lintDiagnostic(d, 1, 'field inptu not recognised')]);
		assert.deepStrictEqual(list, []);
	});

	test('a schema that throws gives no actions, never a throw', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'inptu: {}\n' });
		const provider = new UnknownFieldQuickFix(() => { throw new Error('boom'); });
		const context = { diagnostics: [lintDiagnostic(doc, 1, 'field inptu not recognised')], only: undefined,
			triggerKind: vscode.CodeActionTriggerKind.Invoke };
		assert.deepStrictEqual(provider.provideCodeActions(doc, new vscode.Range(0, 0, 0, 0), context), []);
	});

	test('several diagnostics in one request each get their fixes', async () => {
		const { actions: list } = await actions('inptu:\n  stdin: {}\noutptu:\n  stdout: {}\n', (d) => [
			lintDiagnostic(d, 1, 'field inptu not recognised'),
			lintDiagnostic(d, 3, 'field outptu not recognised'),
		]);
		assert.ok(list.some((a) => a.title === 'Change to `input`'));
		assert.ok(list.some((a) => a.title === 'Change to `output`'));
	});

	test('QUOTED_KEY (single quotes) and MULTI_DOC through the provider', async () => {
		const text = "output:\n  kafka_franz:\n    'topci': a\n---\noutput:\n  kafka_franz:\n    topci: b\n";
		const { doc, actions: list } = await actions(text, (d) => [lintDiagnostic(d, 7, 'field topci not recognised')]);
		assert.strictEqual(applied(doc, list[0]), text.replace('topci: b', 'topic: b'));
		const first = await actions(text, (d) => [lintDiagnostic(d, 3, 'field topci not recognised')]);
		assert.strictEqual(applied(first.doc, first.actions[0]), text.replace("'topci': a", 'topic: a'));
	});

	test('a tie has no preferred fix; all candidates are still listed', async () => {
		const { actions: list } = await actions('input:\n  generate:\n    countt: 1\n    mapping: x\n',
			(d) => [lintDiagnostic(d, 3, 'field countt not recognised')]);
		assert.strictEqual(list[0].title, 'Change to `count`');
		assert.strictEqual(list[0].isPreferred, true, 'count is the only name within the limit');
		const fake = { properties: { x: { properties: { abd: {}, abe: {} } } } };
		const tie = await actions('x:\n  abc: 1\n', (d) => [lintDiagnostic(d, 2, 'field abc not recognised')], () => fake);
		assert.deepStrictEqual(tie.actions.map((a) => [a.title, a.isPreferred]), [['Change to `abd`', false], ['Change to `abe`', false]]);
	});
});
