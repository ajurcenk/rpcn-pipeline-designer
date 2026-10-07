import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DetectionChange, DetectionRegistry, DetectionSource, filePatternsFrom, matchesFilePattern, PatternMatcher } from '../../../adapters/vscode/detection';

interface FakeDocument {
	uri: vscode.Uri;
	languageId: string;
	text: string;
}

function asDocument(doc: FakeDocument): vscode.TextDocument {
	return { uri: doc.uri, languageId: doc.languageId, getText: () => doc.text } as unknown as vscode.TextDocument;
}

class FakeSource implements DetectionSource {
	readonly open = new vscode.EventEmitter<vscode.TextDocument>();
	readonly change = new vscode.EventEmitter<vscode.TextDocumentChangeEvent>();
	readonly close = new vscode.EventEmitter<vscode.TextDocument>();
	readonly config = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
	readonly onDidChangeConfiguration = this.config.event;
	readonly onDidOpenTextDocument = this.open.event;
	readonly onDidChangeTextDocument = this.change.event;
	readonly onDidCloseTextDocument = this.close.event;
	constructor(readonly textDocuments: vscode.TextDocument[] = []) {}

	fireChange(doc: FakeDocument): void {
		this.change.fire({ document: asDocument(doc), contentChanges: [], reason: undefined });
	}

	fireConfig(section: string): void {
		this.config.fire({ affectsConfiguration: (s: string) => s === section });
	}

	dispose(): void {
		this.config.dispose();
		this.open.dispose();
		this.change.dispose();
		this.close.dispose();
	}
}

const uri = (name: string) => vscode.Uri.file(`/tmp/rpcn-detection/${name}`);

/** Fake matcher: a pattern `*.x.yaml` matches paths ending in `.x.yaml`. */
const suffixMatcher: PatternMatcher = (doc, patterns) =>
	patterns.some((p) => doc.uri.path.endsWith(p.replace(/^\*+\/?\**/, '')));

const TEMPLATE = 'name: t\ntype: input\nmapping: |\n  root = {}\ninput:\n  stdin: {}\n';

suite('adapters/vscode DetectionRegistry', () => {
	let source: FakeSource;
	let registry: DetectionRegistry;

	teardown(() => {
		registry.dispose();
		source.dispose();
	});

	test('documents already open at construction are classified', () => {
		const config = { uri: uri('a.yaml'), languageId: 'yaml', text: 'input:\n  stdin: {}\n' };
		const manifest = { uri: uri('k8s.yaml'), languageId: 'yaml', text: 'kind: Pod\n' };
		source = new FakeSource([asDocument(config), asDocument(manifest)]);
		registry = new DetectionRegistry(source);
		assert.strictEqual(registry.isDetected(config.uri), true);
		assert.strictEqual(registry.isDetected(config.uri.toString()), true);
		assert.strictEqual(registry.isDetected(manifest.uri), false);
		assert.strictEqual(registry.has(manifest.uri), true);
	});

	test('DETECTED / NOT_DETECTED on open; non-YAML documents are not tracked', () => {
		source = new FakeSource();
		registry = new DetectionRegistry(source);
		const config = { uri: uri('b.yaml'), languageId: 'yaml', text: 'output:\n  stdout: {}\n' };
		const plain = { uri: uri('c.txt'), languageId: 'plaintext', text: 'input:\n' };
		source.open.fire(asDocument(config));
		source.open.fire(asDocument(plain));
		assert.strictEqual(registry.isDetected(config.uri), true);
		assert.strictEqual(registry.isDetected(plain.uri), false);
		assert.strictEqual(registry.has(plain.uri), false);
	});

	test('BECOMES_DETECTED: a change that adds pipeline: detects the document; removing it undetects', () => {
		source = new FakeSource();
		registry = new DetectionRegistry(source);
		const doc = { uri: uri('d.yaml'), languageId: 'yaml', text: '' };
		source.open.fire(asDocument(doc));
		assert.strictEqual(registry.isDetected(doc.uri), false);
		doc.text = 'pipeline:\n  processors: []\n';
		source.fireChange(doc);
		assert.strictEqual(registry.isDetected(doc.uri), true);
		doc.text = 'foo: 1\n';
		source.fireChange(doc);
		assert.strictEqual(registry.isDetected(doc.uri), false);
	});

	test('CLOSED: closing a detected document removes its entry', () => {
		const doc = { uri: uri('e.yaml'), languageId: 'yaml', text: 'input:\n  stdin: {}\n' };
		source = new FakeSource([asDocument(doc)]);
		registry = new DetectionRegistry(source);
		assert.strictEqual(registry.has(doc.uri), true);
		source.close.fire(asDocument(doc));
		assert.strictEqual(registry.has(doc.uri), false);
		assert.strictEqual(registry.isDetected(doc.uri), false);
	});

	test('a language change away from YAML drops the entry', () => {
		const doc = { uri: uri('f.yaml'), languageId: 'yaml', text: 'input:\n  stdin: {}\n' };
		source = new FakeSource([asDocument(doc)]);
		registry = new DetectionRegistry(source);
		doc.languageId = 'plaintext';
		source.fireChange(doc);
		assert.strictEqual(registry.has(doc.uri), false);
	});

	test('dispose stops listening', () => {
		source = new FakeSource();
		registry = new DetectionRegistry(source);
		registry.dispose();
		const doc = { uri: uri('g.yaml'), languageId: 'yaml', text: 'input:\n' };
		source.open.fire(asDocument(doc));
		assert.strictEqual(registry.has(doc.uri), false);
	});

	suite('2.2 patterns, templates, events and the session mark', () => {
		let patterns: string[];
		let events: DetectionChange[];

		function make(docs: FakeDocument[] = []): void {
			source = new FakeSource(docs.map(asDocument));
			registry = new DetectionRegistry(source, () => patterns, suffixMatcher);
			registry.onDidChangeDetection((e) => events.push(e));
		}

		setup(() => {
			patterns = [];
			events = [];
		});

		test('PATTERN: a key-less file matching filePatterns is detected', () => {
			patterns = ['**/*.rpcn.yaml'];
			const doc = { uri: uri('a.rpcn.yaml'), languageId: 'yaml', text: 'foo: 1\n' };
			make([doc]);
			assert.strictEqual(registry.isDetected(doc.uri), true);
		});

		test('TEMPLATE / TEMPLATE_PATTERN: a template is detected only when a pattern matches it', () => {
			const doc = { uri: uri('t.tmpl.yaml'), languageId: 'yaml', text: TEMPLATE };
			make([doc]);
			assert.strictEqual(registry.isDetected(doc.uri), false);
			registry.dispose();
			source.dispose();
			patterns = ['*.tmpl.yaml'];
			make([doc]);
			assert.strictEqual(registry.isDetected(doc.uri), true);
		});

		test('SETTING_CHANGE: recompute every open document; events only for flipped URIs', () => {
			const plain = { uri: uri('p.rpcn.yaml'), languageId: 'yaml', text: 'foo: 1\n' };
			const config = { uri: uri('c.yaml'), languageId: 'yaml', text: 'input:\n  stdin: {}\n' };
			make([plain, config]);
			patterns = ['*.rpcn.yaml'];
			source.fireConfig('redpandaConnect.envFile');
			assert.strictEqual(registry.isDetected(plain.uri), false, 'unrelated setting ignored');
			source.fireConfig('redpandaConnect.filePatterns');
			assert.strictEqual(registry.isDetected(plain.uri), true);
			assert.deepStrictEqual(events, [{ uri: plain.uri.toString(), detected: true }]);
			patterns = [];
			source.fireConfig('redpandaConnect.filePatterns');
			assert.strictEqual(registry.isDetected(plain.uri), false);
			assert.strictEqual(registry.isDetected(config.uri), true);
			assert.strictEqual(events.length, 2);
		});

		test('BECOMES_DETECTED / NO_FLIP: one event on the flip, none for edits that keep the value', () => {
			const doc = { uri: uri('b.yaml'), languageId: 'yaml', text: '' };
			make();
			source.open.fire(asDocument(doc));
			assert.deepStrictEqual(events, []);
			doc.text = 'input:\n';
			source.fireChange(doc);
			doc.text = 'input:\n  stdin: {}\n';
			source.fireChange(doc);
			assert.deepStrictEqual(events, [{ uri: doc.uri.toString(), detected: true }]);
		});

		test('open of a detected document fires; CLOSED fires detected: false', () => {
			const doc = { uri: uri('o.yaml'), languageId: 'yaml', text: 'output:\n  stdout: {}\n' };
			make();
			source.open.fire(asDocument(doc));
			source.close.fire(asDocument(doc));
			assert.deepStrictEqual(events, [
				{ uri: doc.uri.toString(), detected: true },
				{ uri: doc.uri.toString(), detected: false },
			]);
		});

		test('MARK: detected for the session, idempotent, survives close and reopen', () => {
			const doc = { uri: uri('m.yaml'), languageId: 'yaml', text: 'foo: 1\n' };
			make([doc]);
			registry.markDetected(doc.uri);
			registry.markDetected(doc.uri.toString());
			assert.strictEqual(registry.isDetected(doc.uri), true);
			source.close.fire(asDocument(doc));
			assert.strictEqual(registry.isDetected(doc.uri), true);
			assert.strictEqual(registry.has(doc.uri), false);
			source.open.fire(asDocument(doc));
			assert.strictEqual(registry.isDetected(doc.uri), true);
			assert.deepStrictEqual(events, [{ uri: doc.uri.toString(), detected: true }]);
		});

		test('marking an already detected URI fires nothing', () => {
			const doc = { uri: uri('n.yaml'), languageId: 'yaml', text: 'input:\n' };
			make([doc]);
			registry.markDetected(doc.uri);
			assert.deepStrictEqual(events, []);
		});

		test('RESOURCE_ONLY: a resource-only file is detected', () => {
			const doc = { uri: uri('r.yaml'), languageId: 'yaml', text: 'cache_resources:\n  - label: c\n    memory: {}\n' };
			make([doc]);
			assert.strictEqual(registry.isDetected(doc.uri), true);
		});
	});

	test('BAD_SETTING: non-array values and non-string or empty entries are dropped', () => {
		assert.deepStrictEqual(filePatternsFrom('x'), []);
		assert.deepStrictEqual(filePatternsFrom(undefined), []);
		assert.deepStrictEqual(filePatternsFrom({ a: 1 }), []);
		assert.deepStrictEqual(filePatternsFrom([1, '**/*.y.yaml', null, ' ', '']), ['**/*.y.yaml']);
	});

	test('the pattern match is cached per document until filePatterns changes', () => {
		let calls = 0;
		const doc = { uri: uri('k.rpcn.yaml'), languageId: 'yaml', text: 'foo: 1\n' };
		source = new FakeSource([asDocument(doc)]);
		let patterns = ['*.rpcn.yaml'];
		registry = new DetectionRegistry(source, () => patterns, (d, p) => { calls++; return suffixMatcher(d, p); });
		source.fireChange(doc);
		source.fireChange(doc);
		assert.strictEqual(calls, 1);
		patterns = ['*.other.yaml'];
		source.fireConfig('redpandaConnect.filePatterns');
		assert.strictEqual(calls, 2);
		assert.strictEqual(registry.isDetected(doc.uri), false);
	});

	suite('matchesFilePattern (real VS Code matching)', () => {
		let dir: string;
		suiteSetup(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-match-'));
			fs.mkdirSync(path.join(dir, 'configs'));
			fs.writeFileSync(path.join(dir, 'configs', 'a.yaml'), 'foo: 1\n');
			fs.writeFileSync(path.join(dir, 'b.rpcn.yaml'), 'foo: 1\n');
		});
		suiteTeardown(() => fs.rmSync(dir, { recursive: true, force: true }));
		const folderAt = (root: string): vscode.WorkspaceFolder => ({ uri: vscode.Uri.file(root), name: 'f', index: 0 });

		test('folder-relative patterns match only inside the containing folder', async () => {
			const nested = await vscode.workspace.openTextDocument(path.join(dir, 'configs', 'a.yaml'));
			const root = await vscode.workspace.openTextDocument(path.join(dir, 'b.rpcn.yaml'));
			const inFolder = () => folderAt(dir);
			assert.strictEqual(matchesFilePattern(nested, ['configs/*.yaml'], inFolder), true);
			assert.strictEqual(matchesFilePattern(root, ['*.rpcn.yaml'], inFolder), true);
			assert.strictEqual(matchesFilePattern(nested, ['*.yaml'], inFolder), false, 'no ** → folder root only');
			assert.strictEqual(matchesFilePattern(nested, ['configs/*.yaml'], () => undefined), false, 'no folder');
		});

		test('** and absolute patterns match without a folder; an unmatchable pattern is no match', async () => {
			const root = await vscode.workspace.openTextDocument(path.join(dir, 'b.rpcn.yaml'));
			assert.strictEqual(matchesFilePattern(root, ['**/*.rpcn.yaml'], () => undefined), true);
			assert.strictEqual(matchesFilePattern(root, [path.join(dir, '*.rpcn.yaml')], () => undefined), true);
			assert.strictEqual(matchesFilePattern(root, ['**/*.other.yaml', '['], () => undefined), false);
		});
	});
});
