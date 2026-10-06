import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DETECTION_KEYS, isRedpandaConnectConfig } from '../../core/detection';
import { REPO_ROOT } from '../helpers/fakeBinary';

const CORPUS = path.join(REPO_ROOT, 'test', 'corpus');

/** `file → Kind` from the table in test/corpus/SOURCES.md. */
function corpusKinds(): Map<string, string> {
	const kinds = new Map<string, string>();
	for (const line of fs.readFileSync(path.join(CORPUS, 'SOURCES.md'), 'utf8').split('\n')) {
		const cells = line.split('|').map((c) => c.trim());
		const file = /^`([^`]+\.yaml)`$/.exec(cells[1] ?? '');
		if (file) {
			kinds.set(file[1], cells[3]);
		}
	}
	return kinds;
}

suite('core/detection isRedpandaConnectConfig', () => {
	test('DETECTED: every detection key at the top level is detected', () => {
		for (const key of DETECTION_KEYS) {
			assert.strictEqual(isRedpandaConnectConfig(`${key}:\n  foo: {}\n`), true, key);
		}
	});

	test('RESOURCE_ONLY: a file with only cache_resources is detected', () => {
		assert.strictEqual(isRedpandaConnectConfig('cache_resources:\n  - label: c\n    memory: {}\n'), true);
	});

	test('NOT_DETECTED: a Kubernetes manifest is not detected', () => {
		const manifest = [
			'apiVersion: apps/v1',
			'kind: Deployment',
			'metadata:',
			'  name: web',
			'spec:',
			'  template:',
			'    spec:',
			'      containers:',
			'        - name: web',
			'          input: not-top-level',
			'',
		].join('\n');
		assert.strictEqual(isRedpandaConnectConfig(manifest), false);
	});

	test('empty and whitespace-only text is not detected', () => {
		assert.strictEqual(isRedpandaConnectConfig(''), false);
		assert.strictEqual(isRedpandaConnectConfig('\n\n  \n'), false);
	});

	test('indented keys are not top-level', () => {
		assert.strictEqual(isRedpandaConnectConfig('root:\n  input:\n    stdin: {}\n'), false);
		assert.strictEqual(isRedpandaConnectConfig(' input:\n  stdin: {}\n'), false);
	});

	test('a key must be followed by a colon and a space, a comment or the end of the line', () => {
		assert.strictEqual(isRedpandaConnectConfig('input: {}\n'), true);
		assert.strictEqual(isRedpandaConnectConfig('input:  # comment\n'), true);
		assert.strictEqual(isRedpandaConnectConfig('input :\n'), true);
		assert.strictEqual(isRedpandaConnectConfig('input'), false);
		assert.strictEqual(isRedpandaConnectConfig('input:x\n'), false);
		assert.strictEqual(isRedpandaConnectConfig('inputs:\n'), false);
		assert.strictEqual(isRedpandaConnectConfig('my_input:\n'), false);
	});

	test('quoted keys are detected', () => {
		assert.strictEqual(isRedpandaConnectConfig('"pipeline":\n  processors: []\n'), true);
		assert.strictEqual(isRedpandaConnectConfig("'output': {}\n"), true);
	});

	test('comments and document markers are ignored', () => {
		assert.strictEqual(isRedpandaConnectConfig('# input:\n#pipeline:\nfoo: 1\n'), false);
		assert.strictEqual(isRedpandaConnectConfig('---\nfoo: 1\n---\noutput:\n  stdout: {}\n'), true);
	});

	test('CRLF line endings are handled', () => {
		assert.strictEqual(isRedpandaConnectConfig('logger:\r\n  level: INFO\r\ninput:\r\n  stdin: {}\r\n'), true);
	});

	test('other top-level Redpanda Connect keys alone do not detect', () => {
		assert.strictEqual(isRedpandaConnectConfig('logger:\n  level: INFO\nhttp:\n  enabled: false\n'), false);
	});

	test('corpus: every config and resource file in SOURCES.md is detected; the three templates are not', () => {
		const kinds = corpusKinds();
		const yamlFiles = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.yaml')).sort();
		assert.deepStrictEqual([...kinds.keys()].sort(), yamlFiles, 'SOURCES.md table and corpus files differ');
		const templates = [...kinds].filter(([, kind]) => kind === 'template').map(([f]) => f).sort();
		assert.deepStrictEqual(templates, ['input_sqs_example.yaml', 'processor_hydration.yaml', 'processor_log_and_drop.yaml']);
		for (const [file, kind] of kinds) {
			assert.ok(['config', 'resource file', 'template'].includes(kind), `${file}: unknown kind ${kind}`);
			const text = fs.readFileSync(path.join(CORPUS, file), 'utf8');
			assert.strictEqual(isRedpandaConnectConfig(text), kind !== 'template', `${file} (${kind})`);
		}
	});
});
