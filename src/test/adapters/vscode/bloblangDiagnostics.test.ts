import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BloblParseOutcome } from '../../../core/bloblangParse';
import type { BinaryState } from '../../../adapters/redpandaConnect/binary';
import { BLOBLANG_SOURCE, BloblangDiagnostics, BloblangDiagnosticsSource } from '../../../adapters/vscode/bloblangDiagnostics';
import { makeTempDir } from '../../helpers/fakeBinary';

class FakeSource implements BloblangDiagnosticsSource {
	readonly change = new vscode.EventEmitter<vscode.TextDocumentChangeEvent>();
	readonly close = new vscode.EventEmitter<vscode.TextDocument>();
	readonly configuration = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
	readonly onDidChangeTextDocument = this.change.event;
	readonly onDidCloseTextDocument = this.close.event;
	readonly onDidChangeConfiguration = this.configuration.event;
	docs: vscode.TextDocument[] = [];
	collection: vscode.DiagnosticCollection | undefined;
	get textDocuments() { return this.docs; }
	createDiagnosticCollection(): vscode.DiagnosticCollection {
		this.collection = vscode.languages.createDiagnosticCollection(`rpcn-bloblang-test-${Math.random()}`);
		return this.collection;
	}
	edit(doc: vscode.TextDocument): void {
		this.change.fire({ document: doc, contentChanges: [{} as vscode.TextDocumentContentChangeEvent], reason: undefined });
	}
	dispose(): void {
		this.change.dispose();
		this.close.dispose();
		this.configuration.dispose();
		this.collection?.dispose();
	}
}

class FakeBinary {
	readonly emitter = new vscode.EventEmitter<BinaryState>();
	readonly onDidChange = this.emitter.event;
	state: BinaryState = { kind: 'ok', path: '/bin/rc', version: '4.112.0', invocation: ['/bin/rc'] };
	set(state: BinaryState): void {
		this.state = state;
		this.emitter.fire(state);
	}
}

/** A parse the test releases: `ERR` gives a parse error at line 1 char 1. */
class ControlledParse {
	readonly calls: { text: string; uri: vscode.Uri; release: () => void }[] = [];
	readonly parse = (text: string, uri: vscode.Uri): Promise<BloblParseOutcome> => new Promise((resolve) => {
		this.calls.push({
			text,
			uri,
			release: () => resolve(text.includes('ERR') ? { kind: 'parseError', message: 'bad', line: 1, char: 1, excerpt: '' } : { kind: 'ok' }),
		});
	});
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !predicate(); i++) {
		await tick(10);
	}
	assert.ok(predicate());
}

suite('adapters/vscode BloblangDiagnostics (4.5)', () => {
	let dir: string;
	let source: FakeSource;
	let binary: FakeBinary;
	let parse: ControlledParse;
	let service: BloblangDiagnostics | undefined;
	const detection = { isDetected: () => true, onDidChangeDetection: new vscode.EventEmitter<{ uri: string; detected: boolean }>().event };
	const logs: string[] = [];

	setup(() => {
		dir = makeTempDir('rpcn-bloblang-diag-unit-');
		source = new FakeSource();
		binary = new FakeBinary();
		parse = new ControlledParse();
		logs.length = 0;
	});
	teardown(() => {
		service?.dispose();
		source.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	async function doc(text: string): Promise<vscode.TextDocument> {
		const file = path.join(dir, `c${Math.random()}.yaml`);
		fs.writeFileSync(file, text);
		const d = await vscode.workspace.openTextDocument(file);
		source.docs.push(d);
		return d;
	}

	function start(): BloblangDiagnostics {
		service = new BloblangDiagnostics({ detection, binary, parse: parse.parse, log: (l) => logs.push(l), debounceMs: 10, source });
		return service;
	}

	test('ticket 4: each parse gets its config; a result cached in one scope (workspace folder) is not used in another', async () => {
		const MAPPING = 'pipeline:\n  processors:\n    - mapping: root = ERR\n';
		const scopes = new Map<string, string>();
		const a = await doc(MAPPING);
		scopes.set(a.uri.toString(), 'A');
		service = new BloblangDiagnostics({ detection, binary, parse: parse.parse, log: (l) => logs.push(l), debounceMs: 10, source,
			cacheScope: (uri) => scopes.get(uri.toString()) ?? '?' });
		const s = service;
		await until(() => parse.calls.length === 1);
		assert.strictEqual(parse.calls[0].uri.toString(), a.uri.toString(), 'the parse gets its config');
		parse.calls[0].release();
		await until(() => s.diagnostics(a.uri).length === 1);
		// The same text, now cached for A, in a config of scope B: parsed again, for B.
		const b = await doc(MAPPING);
		scopes.set(b.uri.toString(), 'B');
		source.edit(b);
		await until(() => parse.calls.length === 2);
		assert.strictEqual(parse.calls[1].uri.toString(), b.uri.toString());
		parse.calls[1].release();
		await until(() => s.diagnostics(b.uri).length === 1);
		// A third config in A's scope: A's cached result, no parse.
		const c = await doc(MAPPING);
		scopes.set(c.uri.toString(), 'A');
		source.edit(c);
		await until(() => s.diagnostics(c.uri).length === 1);
		assert.strictEqual(parse.calls.length, 2, 'c shares a\'s scope and its cached result');
	});

	test('ERROR_SHOWN at the mapped offset, source Bloblang, Error; CLOSE clears it', async () => {
		const d = await doc('pipeline:\n  processors:\n    - mapping: root = ERR\n');
		const s = start();
		await until(() => parse.calls.length === 1);
		parse.calls[0].release();
		await until(() => s.diagnostics(d.uri).length === 1);
		const [diag] = s.diagnostics(d.uri);
		assert.deepStrictEqual([diag.range.start.line, diag.range.start.character, diag.range.end.character], [2, 15, 16]);
		assert.strictEqual(diag.source, BLOBLANG_SOURCE);
		assert.strictEqual(diag.severity, vscode.DiagnosticSeverity.Error);
		assert.strictEqual(diag.message, 'bad');
		// The key's line through the line after the value, with the live message.
		assert.deepStrictEqual(s.liveErrorsFor(d.uri), [{ firstLine: 3, lastLine: 4, message: 'bad' }]);
		source.close.fire(d);
		assert.deepStrictEqual(s.diagnostics(d.uri), []);
		assert.deepStrictEqual(s.liveErrorsFor(d.uri), []);
	});

	test('STALE / single flight: one parse per path at a time, only the latest pending; a stale result is never shown', async () => {
		const d = await doc('pipeline:\n  processors:\n    - mapping: root = ERR\n');
		const s = start();
		await until(() => parse.calls.length === 1);
		// Two more versions while the first runs: only the last is parsed next.
		const edit = async (text: string) => {
			const e = new vscode.WorkspaceEdit();
			e.replace(d.uri, new vscode.Range(d.positionAt(0), d.positionAt(d.getText().length)), text);
			assert.ok(await vscode.workspace.applyEdit(e));
			source.edit(d);
			await tick(40);
		};
		await edit('pipeline:\n  processors:\n    - mapping: root = 1\n');
		await edit('pipeline:\n  processors:\n    - mapping: root = 2\n');
		parse.calls[0].release();
		await until(() => parse.calls.length === 2);
		assert.deepStrictEqual(parse.calls.map((c) => c.text), ['root = ERR', 'root = 2']);
		assert.deepStrictEqual(s.diagnostics(d.uri), [], 'the result for root = ERR is dropped');
		parse.calls[1].release();
		await tick(40);
		assert.deepStrictEqual(s.diagnostics(d.uri), []);
		assert.strictEqual(parse.calls.length, 2);
	});

	test('NO_BINARY: no parse and no diagnostics; they appear once the binary is found', async () => {
		binary.state = { kind: 'missing' };
		const d = await doc('pipeline:\n  processors:\n    - mapping: root = ERR\n');
		const s = start();
		await tick(60);
		assert.strictEqual(parse.calls.length, 0);
		binary.set({ kind: 'ok', path: '/bin/rc', version: '4.112.0', invocation: ['/bin/rc'] });
		await until(() => parse.calls.length === 1);
		parse.calls[0].release();
		await until(() => s.diagnostics(d.uri).length === 1);
		binary.set({ kind: 'missing' });
		assert.deepStrictEqual(s.diagnostics(d.uri), [], 'cleared when the binary goes');
	});

	test('ENV_VAR / other failures: no diagnostic, one log line per distinct message', async () => {
		const d = await doc('pipeline:\n  processors:\n    - mapping: root = 1\n    - mapping: root = 2\n');
		service = new BloblangDiagnostics({
			detection, binary, log: (l) => logs.push(l), debounceMs: 10, source,
			parse: async () => ({ kind: 'other', message: 'failed to replace env vars: required environment variables were not set: [X]' }),
		});
		await until(() => service!.parseCount === 2);
		await tick(40);
		assert.deepStrictEqual(service.diagnostics(d.uri), []);
		assert.deepStrictEqual(logs, ['Bloblang parse: failed to replace env vars: required environment variables were not set: [X]']);
	});

	async function setText(d: vscode.TextDocument, text: string): Promise<void> {
		const e = new vscode.WorkspaceEdit();
		e.replace(d.uri, new vscode.Range(d.positionAt(0), d.positionAt(d.getText().length)), text);
		assert.ok(await vscode.workspace.applyEdit(e));
		source.edit(d);
		await tick(40);
	}

	test('the last diagnostic stays while the new text is parsed, then is replaced or cleared', async () => {
		const d = await doc('pipeline:\n  processors:\n    - mapping: root = ERR\n');
		const s = start();
		await until(() => parse.calls.length === 1);
		parse.calls[0].release();
		await until(() => s.diagnostics(d.uri).length === 1);
		await setText(d, 'pipeline:\n  processors:\n    - mapping: root = ERR2\n');
		assert.strictEqual(parse.calls.length, 2);
		assert.strictEqual(s.diagnostics(d.uri).length, 1, 'kept while root = ERR2 is parsed');
		parse.calls[1].release();
		await until(() => s.diagnostics(d.uri).length === 1 && s.diagnostics(d.uri)[0] !== undefined);
		await setText(d, 'pipeline:\n  processors:\n    - mapping: root = 1\n');
		assert.strictEqual(s.diagnostics(d.uri).length, 1, 'kept while root = 1 is parsed');
		parse.calls[2].release();
		await until(() => s.diagnostics(d.uri).length === 0);
	});

	test('A running, B pending, then C already cached: B is not parsed', async () => {
		const d = await doc('pipeline:\n  processors:\n    - mapping: root = 1\n');
		const s = start();
		await until(() => parse.calls.length === 1);
		parse.calls[0].release();
		await until(() => s.parseCount === 1);
		await tick(20);
		await setText(d, 'pipeline:\n  processors:\n    - mapping: root = 2\n');
		await setText(d, 'pipeline:\n  processors:\n    - mapping: root = 3\n');
		await setText(d, 'pipeline:\n  processors:\n    - mapping: root = 1\n');
		parse.calls[1].release();
		await tick(60);
		assert.deepStrictEqual(parse.calls.map((c) => c.text), ['root = 1', 'root = 2']);
	});

	test('a transient failure is logged once and not cached; the next trigger parses the text again; a reset logs again', async () => {
		const d = await doc('pipeline:\n  processors:\n    - mapping: root = 1\n');
		let calls = 0;
		service = new BloblangDiagnostics({
			detection, binary, log: (l) => logs.push(l), debounceMs: 10, source,
			parse: async () => {
				calls++;
				return { kind: 'other', message: 'blobl gave no result after 5 s; stopped.' };
			},
		});
		await until(() => calls === 1);
		await tick(40);
		source.edit(d);
		await until(() => calls === 2);
		await tick(40);
		assert.deepStrictEqual(logs, ['Bloblang parse: blobl gave no result after 5 s; stopped.']);
		binary.set({ kind: 'ok', path: '/bin/rc2', version: '4.112.0', invocation: ['/bin/rc2'] });
		await until(() => calls === 3);
		await tick(40);
		assert.strictEqual(logs.length, 2, 'logged again after a reset');
		assert.deepStrictEqual(service.diagnostics(d.uri), []);
	});
});
