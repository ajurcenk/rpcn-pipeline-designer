import * as assert from 'assert';
import * as vscode from 'vscode';
import { DetectionRegistry, DetectionSource } from '../../../adapters/vscode/detection';

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
	readonly onDidOpenTextDocument = this.open.event;
	readonly onDidChangeTextDocument = this.change.event;
	readonly onDidCloseTextDocument = this.close.event;
	constructor(readonly textDocuments: vscode.TextDocument[] = []) {}

	fireChange(doc: FakeDocument): void {
		this.change.fire({ document: asDocument(doc), contentChanges: [], reason: undefined });
	}

	dispose(): void {
		this.open.dispose();
		this.change.dispose();
		this.close.dispose();
	}
}

const uri = (name: string) => vscode.Uri.file(`/tmp/rpcn-detection/${name}`);

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
});
