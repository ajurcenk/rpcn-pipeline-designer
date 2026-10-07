import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LintFinding, parseLintOutput } from '../../../core/lint';
import { LintResult } from '../../../adapters/redpandaConnect/lint';
import { DetectionView, DiagnosticsSource, LINT_SOURCE, LintDiagnostics } from '../../../adapters/vscode/diagnostics';
import { makeTempDir } from '../../helpers/fakeBinary';

class FakeSource implements DiagnosticsSource {
	readonly save = new vscode.EventEmitter<vscode.TextDocument>();
	readonly change = new vscode.EventEmitter<vscode.TextDocumentChangeEvent>();
	readonly diagnostics = new vscode.EventEmitter<vscode.DiagnosticChangeEvent>();
	readonly close = new vscode.EventEmitter<vscode.TextDocument>();
	readonly onDidCloseTextDocument = this.close.event;
	readonly onDidSaveTextDocument = this.save.event;
	readonly onDidChangeTextDocument = this.change.event;
	readonly onDidChangeDiagnostics = this.diagnostics.event;
	readonly redHat = new Map<string, vscode.Diagnostic[]>();
	collection: vscode.DiagnosticCollection | undefined;
	get textDocuments() { return vscode.workspace.textDocuments; }
	getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
		return [...(this.redHat.get(uri.toString()) ?? []), ...(this.collection?.get(uri) ?? [])];
	}
	createDiagnosticCollection(): vscode.DiagnosticCollection {
		this.collection = vscode.languages.createDiagnosticCollection(`rpcn-test-${Math.random()}`);
		return this.collection;
	}
	setRedHat(uri: vscode.Uri, lines: number[]): void {
		this.redHat.set(uri.toString(), lines.map((l) => {
			const d = new vscode.Diagnostic(new vscode.Range(l - 1, 0, l - 1, 1), 'red hat', vscode.DiagnosticSeverity.Error);
			d.source = 'YAML';
			return d;
		}));
		this.diagnostics.fire({ uris: [uri] });
	}
	edit(doc: vscode.TextDocument): void {
		this.change.fire({ document: doc, contentChanges: [{} as vscode.TextDocumentContentChangeEvent], reason: undefined });
	}
	dispose(): void {
		this.save.dispose();
		this.change.dispose();
		this.diagnostics.dispose();
		this.close.dispose();
	}
}

class FakeDetection implements DetectionView {
	readonly emitter = new vscode.EventEmitter<{ uri: string; detected: boolean }>();
	readonly onDidChangeDetection = this.emitter.event;
	detected = new Set<string>();
	isDetected(uri: string | vscode.Uri): boolean { return this.detected.has(uri.toString()); }
	undetect(uri: vscode.Uri): void {
		this.detected.delete(uri.toString());
		this.emitter.fire({ uri: uri.toString(), detected: false });
	}
}

/** A lint whose results the test releases one by one. */
class ControlledLint {
	readonly pending: ((r: LintResult) => void)[] = [];
	calls = 0;
	readonly lint = (): Promise<LintResult> => {
		this.calls++;
		return new Promise((resolve) => this.pending.push(resolve));
	};
	release(result: LintResult): void {
		const next = this.pending.shift();
		assert.ok(next, 'no lint pending');
		next(result);
	}
}

const findings = (fsPath: string, ...lines: [number, string][]): LintResult => ({
	kind: 'findings',
	findings: parseLintOutput(lines.map(([l, m]) => `${fsPath}(${l},1) ${m}\n`).join('')).findings as LintFinding[],
	logLines: [],
});

const tick = () => new Promise((r) => setTimeout(r, 10));

suite('adapters/vscode LintDiagnostics', () => {
	let dir: string;
	let source: FakeSource;
	let detection: FakeDetection;
	let lint: ControlledLint;
	let controller: LintDiagnostics;
	let logs: string[];
	let doc: vscode.TextDocument;
	let changes: string[];

	const published = () => (source.collection!.get(doc.uri) ?? []).map((d) =>
		[d.range.start.line + 1, d.range.start.character, d.range.end.character, d.severity, d.source, d.message]);

	setup(async () => {
		dir = makeTempDir('rpcn-diag-');
		const file = path.join(dir, 'a.yaml');
		fs.writeFileSync(file, 'input:\n  generate:\n    nope: 1\n    codec: lines\nlong line here\n');
		doc = await vscode.workspace.openTextDocument(file);
		source = new FakeSource();
		detection = new FakeDetection();
		detection.detected.add(doc.uri.toString());
		lint = new ControlledLint();
		logs = [];
		changes = [];
		controller = new LintDiagnostics({ detection, lint: lint.lint, log: (l) => logs.push(l), source });
		controller.onDidChangeDiagnostics((uri) => changes.push(uri.toString()));
	});

	teardown(() => {
		controller.dispose();
		source.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('UNKNOWN_FIELD / DEPRECATED / MULTI: whole-line Error and Warning, source Redpanda Connect', async () => {
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'field nope not recognised'], [4, 'field codec is deprecated']));
		await tick();
		assert.deepStrictEqual(published(), [
			[3, 0, 11, vscode.DiagnosticSeverity.Error, LINT_SOURCE, 'field nope not recognised'],
			[4, 0, 16, vscode.DiagnosticSeverity.Warning, LINT_SOURCE, 'field codec is deprecated'],
		]);
		assert.deepStrictEqual(changes, [doc.uri.toString()]);
	});

	test('a line past the end is clamped to the last line', async () => {
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [99, 'x']));
		await tick();
		assert.strictEqual(published()[0][0], doc.lineCount);
	});

	test('CLEAN: a clean lint removes earlier findings', async () => {
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'x']));
		await tick();
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath));
		await tick();
		assert.deepStrictEqual(published(), []);
	});

	test('DEDUPE / LATE_REDHAT: a Red Hat line suppresses lint there, re-checked when Red Hat changes', async () => {
		source.setRedHat(doc.uri, [3]);
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'a'], [5, 'b']));
		await tick();
		assert.deepStrictEqual(published().map((p) => p[0]), [5]);
		source.setRedHat(doc.uri, []);
		assert.deepStrictEqual(published().map((p) => p[0]), [3, 5]);
		source.setRedHat(doc.uri, [5]);
		assert.deepStrictEqual(published().map((p) => p[0]), [3]);
	});

	test('only YAML / yaml-schema sources count as Red Hat', async () => {
		const other = new vscode.Diagnostic(new vscode.Range(2, 0, 2, 1), 'other');
		other.source = 'eslint';
		const schema = new vscode.Diagnostic(new vscode.Range(4, 0, 4, 1), 'schema');
		schema.source = 'yaml-schema: rpcn-schema';
		source.redHat.set(doc.uri.toString(), [other, schema]);
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'a'], [5, 'b']));
		await tick();
		assert.deepStrictEqual(published().map((p) => p[0]), [3]);
		assert.deepStrictEqual(controller.diagnosticsFor(doc.uri).map((d) => d.message), ['schema', 'a']);
	});

	test('ACCESSOR: Red Hat plus deduped lint, one event per change, none for our own republish', async () => {
		source.setRedHat(doc.uri, [2]);
		assert.deepStrictEqual(changes.length, 1, 'a Red Hat-only change on a detected file is reported');
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [2, 'dup'], [5, 'five']));
		await tick();
		assert.deepStrictEqual(controller.diagnosticsFor(doc.uri).map((d) => [d.range.start.line + 1, d.message]),
			[[2, 'red hat'], [5, 'five']]);
		assert.strictEqual(changes.length, 2);
		source.diagnostics.fire({ uris: [doc.uri] }); // e.g. our own collection.set echoing back
		assert.strictEqual(changes.length, 2);
	});

	test('FIRST_EDIT: the first edit clears lint diagnostics; Red Hat untouched', async () => {
		source.setRedHat(doc.uri, [1]);
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'x']));
		await tick();
		source.edit(doc);
		assert.deepStrictEqual(published(), []);
		assert.deepStrictEqual(controller.diagnosticsFor(doc.uri).map((d) => d.message), ['red hat']);
	});

	test('a change event without content changes (dirty flag) does not clear', async () => {
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'x']));
		await tick();
		source.change.fire({ document: doc, contentChanges: [], reason: undefined });
		assert.strictEqual(published().length, 1);
	});

	test('STALE_RESULT: an edit during a running lint discards its result', async () => {
		source.save.fire(doc);
		source.edit(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'x']));
		await tick();
		assert.deepStrictEqual(published(), []);
	});

	test('SAVE_BURST: saves during a run queue one rerun; only the last result shows', async () => {
		source.save.fire(doc);
		source.save.fire(doc);
		source.save.fire(doc);
		assert.strictEqual(lint.calls, 1);
		lint.release(findings(doc.uri.fsPath, [3, 'first']));
		await tick();
		assert.deepStrictEqual(published(), [], 'first result is stale');
		assert.strictEqual(lint.calls, 2);
		lint.release(findings(doc.uri.fsPath, [4, 'last']));
		await tick();
		assert.deepStrictEqual(published().map((p) => p[5]), ['last']);
		assert.strictEqual(lint.calls, 2);
	});

	test('an edit while a rerun is queued cancels the rerun', async () => {
		source.save.fire(doc);
		source.save.fire(doc);
		source.edit(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'x']));
		await tick();
		assert.strictEqual(lint.calls, 1);
		assert.deepStrictEqual(published(), []);
	});

	test('NOT_DETECTED and non-file URIs: no lint', async () => {
		detection.detected.clear();
		source.save.fire(doc);
		const untitled = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'input: {}\n' });
		detection.detected.add(untitled.uri.toString());
		source.save.fire(untitled);
		assert.strictEqual(lint.calls, 0);
	});

	test('UNDETECTED: lint diagnostics are removed; a running result is dropped', async () => {
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'x']));
		await tick();
		source.save.fire(doc);
		detection.undetect(doc.uri);
		assert.deepStrictEqual(published(), []);
		lint.release(findings(doc.uri.fsPath, [3, 'x']));
		await tick();
		assert.deepStrictEqual(published(), []);
	});

	test('failed and log lines are logged, even when stale; failures publish nothing', async () => {
		source.save.fire(doc);
		lint.release({ kind: 'failed', logLine: 'Lint a.yaml: boom' });
		await tick();
		source.save.fire(doc);
		source.edit(doc);
		lint.release({ kind: 'findings', findings: [], logLines: ['Lint a.yaml: unrecognised output: x'] });
		await tick();
		assert.deepStrictEqual(logs, ['Lint a.yaml: boom', 'Lint a.yaml: unrecognised output: x']);
		assert.deepStrictEqual(published(), []);
	});

	test('a rejecting lint is logged, never thrown', async () => {
		controller.dispose();
		controller = new LintDiagnostics({ detection, lint: () => Promise.reject(new Error('bug')), log: (l) => logs.push(l), source });
		source.save.fire(doc);
		await tick();
		assert.strictEqual(logs.length, 1);
		assert.ok(logs[0].includes('bug'), logs[0]);
	});

	test('one lint per URI also across undetect and re-detect', async () => {
		source.save.fire(doc);
		detection.undetect(doc.uri);
		detection.detected.add(doc.uri.toString());
		source.save.fire(doc);
		assert.strictEqual(lint.calls, 1, 'the second save queues behind the running lint');
		lint.release(findings(doc.uri.fsPath, [3, 'stale']));
		await tick();
		assert.strictEqual(lint.calls, 2);
		lint.release(findings(doc.uri.fsPath, [4, 'fresh']));
		await tick();
		assert.deepStrictEqual(published().map((p) => p[5]), ['fresh']);
	});

	test('closing a session-marked (still detected) file drops its findings', async () => {
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [3, 'x']));
		await tick();
		source.close.fire(doc);
		assert.deepStrictEqual(published(), []);
		source.setRedHat(doc.uri, []);
		assert.deepStrictEqual(published(), [], 'old findings are not republished after reopen');
	});

	test('dispose during a run: the late result touches nothing and no rerun starts', async () => {
		source.save.fire(doc);
		source.save.fire(doc);
		controller.dispose();
		lint.release(findings(doc.uri.fsPath, [3, 'x']));
		await tick();
		assert.strictEqual(lint.calls, 1);
	});

	test('NO_BINARY: a skipped lint logs and publishes nothing', async () => {
		source.save.fire(doc);
		lint.release({ kind: 'skipped' });
		await tick();
		assert.deepStrictEqual(logs, []);
		assert.deepStrictEqual(published(), []);
	});

	test('a multi-line Red Hat range flags every line it covers (not a line it ends at column 0)', async () => {
		const d = new vscode.Diagnostic(new vscode.Range(1, 2, 3, 0), 'multi');
		d.source = 'YAML';
		source.redHat.set(doc.uri.toString(), [d]);
		source.save.fire(doc);
		lint.release(findings(doc.uri.fsPath, [2, 'a'], [3, 'b'], [4, 'c'], [5, 'd']));
		await tick();
		assert.deepStrictEqual(published().map((p) => p[0]), [4, 5]);
	});

	test('YAML_SYNTAX: lint\'s syntax error on another line is hidden while Red Hat reports a syntax error', async () => {
		source.setRedHat(doc.uri, [4]);
		source.save.fire(doc);
		lint.release({ kind: 'findings', findings: parseLintOutput(`${doc.uri.fsPath}(1,1) yaml: line 1: did not find expected key\n`
			+ `${doc.uri.fsPath}(5,1) field nope not recognised\n`).findings, logLines: [] });
		await tick();
		assert.deepStrictEqual(published().map((p) => p[0]), [5]);
		source.setRedHat(doc.uri, []);
		assert.deepStrictEqual(published().map((p) => p[0]), [1, 5], 'shown when Red Hat reports none');
	});

	test('a yaml-schema diagnostic alone does not hide lint\'s syntax findings', async () => {
		const schema = new vscode.Diagnostic(new vscode.Range(4, 0, 4, 1), 'schema');
		schema.source = 'yaml-schema: rpcn';
		source.redHat.set(doc.uri.toString(), [schema]);
		source.save.fire(doc);
		lint.release({ kind: 'findings', findings: parseLintOutput(`${doc.uri.fsPath}(1,1) yaml: line 2: x\n`).findings, logLines: [] });
		await tick();
		assert.deepStrictEqual(published().map((p) => p[0]), [2]);
	});
});
