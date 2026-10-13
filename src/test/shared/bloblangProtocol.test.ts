import * as assert from 'assert';
import {
	MAX_SAMPLE_NAME_LENGTH, parseBloblangHostMessage, parseBloblangWebviewMessage, type BloblangHostMessage, type BloblangResult,
	type BloblangSample, type BloblangWebviewMessage,
} from '../../shared/bloblangProtocol';

const NONE = { added: [], changed: [], removed: [] };

const RESULTS: readonly BloblangResult[] = [
	{ kind: 'ok', content: '{"b":2}', meta: {}, changes: { fields: { added: ['b'], changed: [], removed: ['a'] }, meta: NONE } },
	{
		kind: 'ok', content: 'text', meta: { k: 'x', n: 1.5, t: true, z: null, a: [1, 'two', { three: 3 }], o: { p: { q: [] } } },
		changes: { fields: null, meta: { added: ['n', 't', 'z', 'a', 'o'], changed: ['k'], removed: ['gone'] } },
	},
	{ kind: 'failed', message: 'failed assignment (line 1)' },
	{ kind: 'failed', message: 'failed assignment (line 2)', mappingLine: 2 },
	{ kind: 'failed', message: 'failed assignment (line 2)', mappingLine: 2, fileLine: 9 },
	{ kind: 'parseError', message: 'expected end of input', excerpt: 'root = (', mappingLine: 1, mappingChar: 8, fileLine: 7, fileChar: 20 },
	{ kind: 'invalidInput', message: 'The input is not valid JSON.' },
	{ kind: 'deleted' },
	{ kind: 'error', message: 'No Redpanda Connect binary.' },
];

const SAMPLES: readonly BloblangSample[] = [
	{ name: 'order', content: '{"id":1}', meta: { kafka_key: 'k1' } },
	{ name: 'x'.repeat(MAX_SAMPLE_NAME_LENGTH), content: '', meta: {} },
];

const HOST_MESSAGES: readonly BloblangHostMessage[] = [
	{ type: 'snapshot', title: 'Bloblang: first', kind: 'mapping', source: 'root = this', binary: 'ok', samples: [], selected: null },
	{ type: 'snapshot', title: 'Bloblang: pipeline.processors[0]', kind: 'mutation', source: '', binary: 'missing', samples: SAMPLES, selected: 'order' },
	...RESULTS.map((result, i): BloblangHostMessage => ({ type: 'result', result, durationMs: i * 1.5, binary: i % 2 ? null : 'rpk connect 4.112.0' })),
	{ type: 'samples', samples: [], selected: null },
	{ type: 'samples', samples: SAMPLES, selected: null },
	{ type: 'samples', samples: SAMPLES, selected: SAMPLES[1].name },
	...(['ok', 'missing', 'invalid', 'unresolved'] as const).map((status): BloblangHostMessage => ({ type: 'binary', status })),
];

const okWith = (patch: Record<string, unknown>) => ({
	type: 'result', durationMs: 1, binary: null,
	result: { kind: 'ok', content: '', meta: {}, changes: { fields: null, meta: NONE }, ...patch },
});
const snapshotWith = (patch: Record<string, unknown>) => ({
	type: 'snapshot', title: 't', kind: 'mapping', source: '', binary: 'ok', samples: [], selected: null, ...patch,
});
const PARSE_ERROR = { kind: 'parseError', message: 'm', excerpt: 'e', mappingLine: 1, mappingChar: 1, fileLine: 1, fileChar: 1 };
const resultOf = (result: unknown) => ({ type: 'result', result, durationMs: 1, binary: null });

/** An object whose `field` getter throws. */
function throwing(base: Record<string, unknown>, field: string): Record<string, unknown> {
	const o = { ...base };
	Object.defineProperty(o, field, { enumerable: true, get: () => { throw new Error('boom'); } });
	return o;
}

suite('shared/bloblangProtocol (4.2, 4.4, AD-5)', () => {
	test('VALID_HOST: every host message and each result kind validates, unchanged', () => {
		const kinds = new Set(RESULTS.map((r) => r.kind));
		assert.deepStrictEqual([...kinds].sort(), ['deleted', 'error', 'failed', 'invalidInput', 'ok', 'parseError']);
		for (const message of HOST_MESSAGES) {
			const copy = JSON.parse(JSON.stringify(message));
			assert.strictEqual(parseBloblangHostMessage(copy), copy);
			assert.deepStrictEqual(copy, message);
		}
	});

	test('MALFORMED: malformed host messages are rejected, never thrown', () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		const cyclicArray: unknown[] = [];
		cyclicArray.push(cyclicArray);
		const bad: unknown[] = [
			undefined, null, 'snapshot', [], {}, 1,
			{ type: 'model' },
			{ type: 'ready' },
			// snapshot
			snapshotWith({ kind: 'bloblang' }),
			snapshotWith({ title: 1 }),
			snapshotWith({ source: undefined }),
			snapshotWith({ binary: undefined }),
			snapshotWith({ binary: 'gone' }),
			snapshotWith({ samples: undefined }),
			snapshotWith({ samples: {} }),
			snapshotWith({ selected: undefined }),
			snapshotWith({ selected: 'nope' }),
			snapshotWith({ samples: [{ name: '', content: '', meta: {} }] }),
			snapshotWith({ samples: [{ name: 'x'.repeat(MAX_SAMPLE_NAME_LENGTH + 1), content: '', meta: {} }] }),
			snapshotWith({ samples: [{ name: 's', content: 1, meta: {} }] }),
			snapshotWith({ samples: [{ name: 's', content: '' }] }),
			snapshotWith({ samples: [{ name: 's', content: '', meta: [] }] }),
			snapshotWith({ samples: [{ name: 's', content: '', meta: { k: 1 } }] }),
			snapshotWith({ samples: [{ name: 's', content: '', meta: { '': 'v' } }] }),
			snapshotWith({ samples: [SAMPLES[0], SAMPLES[0]] }),
			// samples and binary
			{ type: 'samples', samples: SAMPLES },
			{ type: 'samples', samples: SAMPLES, selected: 'missing' },
			{ type: 'samples', samples: 'x', selected: null },
			{ type: 'binary' },
			{ type: 'binary', status: 'broken' },
			// result envelope
			{ type: 'result', result: { kind: 'deleted' }, durationMs: -1, binary: null },
			{ type: 'result', result: { kind: 'deleted' }, durationMs: Number.NaN, binary: null },
			{ type: 'result', result: { kind: 'deleted' }, durationMs: 1 },
			{ type: 'result', result: { kind: 'deleted' }, durationMs: 1, binary: 4 },
			resultOf({ kind: 'nope' }),
			resultOf(null),
			// ok
			resultOf({ kind: 'ok' }),
			resultOf({ kind: 'ok', content: '' }),
			okWith({ meta: undefined }),
			okWith({ meta: [] }),
			okWith({ meta: 'x' }),
			okWith({ meta: { '': 1 } }),
			okWith({ meta: { k: undefined } }),
			okWith({ meta: { k: Number.NaN } }),
			okWith({ meta: { k: Number.POSITIVE_INFINITY } }),
			okWith({ meta: { k: () => 1 } }),
			okWith({ meta: { k: cyclic } }),
			okWith({ meta: { k: cyclicArray } }),
			okWith({ changes: undefined }),
			okWith({ changes: { fields: null } }),
			okWith({ changes: { fields: undefined, meta: NONE } }),
			okWith({ changes: { fields: { added: [], changed: [] }, meta: NONE } }),
			okWith({ changes: { fields: null, meta: { added: [1], changed: [], removed: [] } } }),
			okWith({ changes: { fields: null, meta: null } }),
			// failed
			resultOf({ kind: 'failed' }),
			resultOf({ kind: 'failed', message: 'm', mappingLine: 0 }),
			resultOf({ kind: 'failed', message: 'm', mappingLine: Number.NaN }),
			resultOf({ kind: 'failed', message: 'm', fileLine: 1.5 }),
			resultOf({ kind: 'failed', message: 'm', fileLine: '3' }),
			resultOf({ kind: 'failed', message: 'm', mappingLine: null }),
			// parseError
			...['message', 'excerpt', 'mappingLine', 'mappingChar', 'fileLine', 'fileChar'].map((f) => resultOf({ ...PARSE_ERROR, [f]: undefined })),
			...['mappingLine', 'mappingChar', 'fileLine', 'fileChar'].flatMap((f) => [0, -1, Number.NaN, 2.5, '1'].map((v) => resultOf({ ...PARSE_ERROR, [f]: v }))),
			// invalidInput, error
			resultOf({ kind: 'invalidInput' }),
			resultOf({ kind: 'error', message: 2 }),
			// getters that throw
			throwing({ type: 'snapshot' }, 'title'),
			resultOf(throwing({ kind: 'ok', content: '', changes: { fields: null, meta: NONE } }, 'meta')),
			okWith({ meta: throwing({}, 'k') }),
		];
		bad.forEach((message, i) => {
			assert.doesNotThrow(() => parseBloblangHostMessage(message), `#${i}`);
			assert.strictEqual(parseBloblangHostMessage(message), undefined, `#${i}`);
		});
	});

	test('VALID_WEBVIEW: each webview message, with extra fields, comes back as a fresh copy with only its own fields', () => {
		const good: [Record<string, unknown>, BloblangWebviewMessage][] = [
			[{ type: 'ready', extra: 1 }, { type: 'ready' }],
			[{ type: 'run', content: '{"a":1}', meta: { k: 'v' }, extra: true }, { type: 'run', content: '{"a":1}', meta: { k: 'v' } }],
			[{ type: 'run', content: '', meta: {} }, { type: 'run', content: '', meta: {} }],
			[{ type: 'inputEdited', content: 'x', meta: { a: '1', b: '' }, input: 'x' }, { type: 'inputEdited', content: 'x', meta: { a: '1', b: '' } }],
			[{ type: 'sampleAdded', name: 'order', from: 'x' }, { type: 'sampleAdded', name: 'order' }],
			[{ type: 'sampleAdded', name: 'x'.repeat(MAX_SAMPLE_NAME_LENGTH) }, { type: 'sampleAdded', name: 'x'.repeat(MAX_SAMPLE_NAME_LENGTH) }],
			[{ type: 'sampleRenamed', from: 'a', to: 'b', name: 'c' }, { type: 'sampleRenamed', from: 'a', to: 'b' }],
			[{ type: 'sampleDeleted', name: 'a', extra: 1 }, { type: 'sampleDeleted', name: 'a' }],
			[{ type: 'sampleSwitched', name: 'a', extra: 1 }, { type: 'sampleSwitched', name: 'a' }],
			[{ type: 'goToLine', line: 12, character: 3 }, { type: 'goToLine', line: 12 }],
			[{ type: 'goToLine', line: 1 }, { type: 'goToLine', line: 1 }],
			[{ type: 'installGuideRequested', extra: 1 }, { type: 'installGuideRequested' }],
			[{ type: 'setPathRequested', extra: 1 }, { type: 'setPathRequested' }],
			[{ type: 'retryRequested', extra: 1 }, { type: 'retryRequested' }],
		];
		for (const [message, expected] of good) {
			const parsed = parseBloblangWebviewMessage(message);
			assert.deepStrictEqual(parsed, expected);
			assert.notStrictEqual(parsed, message);
			if (parsed && 'meta' in parsed) {
				assert.notStrictEqual(parsed.meta, message.meta, 'the metadata is copied too');
			}
		}
		// A `__proto__` key is kept as data, not as the copy's prototype.
		const proto = JSON.parse('{"type":"run","content":"","meta":{"__proto__":"x"}}');
		const parsed = parseBloblangWebviewMessage(proto);
		assert.ok(parsed?.type === 'run');
		assert.deepStrictEqual(Object.keys(parsed.meta), ['__proto__']);
		assert.strictEqual(Object.getPrototypeOf(parsed.meta), Object.prototype);
	});

	test('MALFORMED: malformed webview messages are rejected, never thrown', () => {
		const bad: unknown[] = [
			undefined, null, [], 'ready', {}, { type: 'nodeActivated', nodeId: 'x' }, { type: 'snapshot' },
			// 4.2's shape is gone
			{ type: 'run', input: '{"a":1}' },
			{ type: 'run' },
			{ type: 'run', content: 1, meta: {} },
			{ type: 'run', content: '' },
			{ type: 'run', content: '', meta: null },
			{ type: 'run', content: '', meta: [] },
			{ type: 'run', content: '', meta: 'k=v' },
			{ type: 'run', content: '', meta: { k: 1 } },
			{ type: 'run', content: '', meta: { k: null } },
			{ type: 'run', content: '', meta: { '': 'v' } },
			{ type: 'inputEdited', content: '', meta: { k: true } },
			{ type: 'inputEdited', meta: {} },
			{ type: 'sampleAdded' },
			{ type: 'sampleAdded', name: '' },
			{ type: 'sampleAdded', name: 'x'.repeat(MAX_SAMPLE_NAME_LENGTH + 1) },
			{ type: 'sampleAdded', name: 3 },
			{ type: 'sampleRenamed', from: 'a' },
			{ type: 'sampleRenamed', from: '', to: 'b' },
			{ type: 'sampleRenamed', from: 'a', to: 'x'.repeat(MAX_SAMPLE_NAME_LENGTH + 1) },
			{ type: 'sampleDeleted', name: '' },
			{ type: 'sampleSwitched', name: null },
			{ type: 'goToLine' },
			{ type: 'goToLine', line: 0 },
			{ type: 'goToLine', line: -3 },
			{ type: 'goToLine', line: Number.NaN },
			{ type: 'goToLine', line: Number.POSITIVE_INFINITY },
			{ type: 'goToLine', line: 1.5 },
			{ type: 'goToLine', line: '4' },
			throwing({ type: 'goToLine' }, 'line'),
			throwing({ type: 'run', meta: {} }, 'content'),
			{ type: 'run', content: '', meta: throwing({}, 'k') },
			throwing({}, 'type'),
		];
		bad.forEach((message, i) => {
			assert.doesNotThrow(() => parseBloblangWebviewMessage(message), `#${i}`);
			assert.strictEqual(parseBloblangWebviewMessage(message), undefined, `#${i}`);
		});
	});
});
