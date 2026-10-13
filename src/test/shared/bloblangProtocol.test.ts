import * as assert from 'assert';
import {
	parseBloblangHostMessage, parseBloblangWebviewMessage, type BloblangHostMessage, type BloblangWebviewMessage,
} from '../../shared/bloblangProtocol';

const HOST_MESSAGES: readonly BloblangHostMessage[] = [
	{ type: 'snapshot', title: 'Bloblang: first', kind: 'mapping', source: 'root = this' },
	{ type: 'snapshot', title: 'Bloblang: pipeline.processors[0]', kind: 'mutation', source: '' },
	{ type: 'result', result: { kind: 'ok', content: '{"b":2}' }, durationMs: 210, binary: 'rpk connect 4.112.0' },
	{ type: 'result', result: { kind: 'failed', message: 'failed assignment (line 1)' }, durationMs: 0, binary: 'redpanda-connect 4.100.0' },
	{ type: 'result', result: { kind: 'deleted' }, durationMs: 1.5, binary: 'redpanda-connect 4.112.0' },
	{ type: 'result', result: { kind: 'error', message: 'No Redpanda Connect binary.' }, durationMs: 0, binary: null },
];

suite('shared/bloblangProtocol (4.2, AD-5)', () => {
	test('every well-formed host message validates, unchanged', () => {
		for (const message of HOST_MESSAGES) {
			const copy = JSON.parse(JSON.stringify(message));
			assert.deepStrictEqual(parseBloblangHostMessage(copy), message);
		}
	});

	test('malformed host messages are rejected', () => {
		const bad: unknown[] = [
			undefined, null, 'snapshot', [], {},
			{ type: 'model' },
			{ type: 'snapshot', title: 't', kind: 'bloblang', source: '' },
			{ type: 'snapshot', title: 1, kind: 'mapping', source: '' },
			{ type: 'snapshot', title: 't', kind: 'mapping' },
			{ type: 'result', result: { kind: 'ok' }, durationMs: 1, binary: null },
			{ type: 'result', result: { kind: 'failed' }, durationMs: 1, binary: null },
			{ type: 'result', result: { kind: 'nope' }, durationMs: 1, binary: null },
			{ type: 'result', result: { kind: 'deleted' }, durationMs: -1, binary: null },
			{ type: 'result', result: { kind: 'deleted' }, durationMs: Number.NaN, binary: null },
			{ type: 'result', result: { kind: 'deleted' }, durationMs: 1 },
			{ type: 'result', result: { kind: 'deleted' }, durationMs: 1, binary: 4 },
		];
		for (const message of bad) {
			assert.strictEqual(parseBloblangHostMessage(message), undefined, JSON.stringify(message));
		}
	});

	test('webview messages: a fresh copy with only their own fields; malformed ones rejected', () => {
		const good: [unknown, BloblangWebviewMessage][] = [
			[{ type: 'ready', extra: 1 }, { type: 'ready' }],
			[{ type: 'run', input: '{"a":1}', extra: true }, { type: 'run', input: '{"a":1}' }],
			[{ type: 'run', input: '' }, { type: 'run', input: '' }],
		];
		for (const [message, expected] of good) {
			assert.deepStrictEqual(parseBloblangWebviewMessage(message), expected);
		}
		for (const message of [undefined, null, [], { type: 'run' }, { type: 'run', input: 1 }, { type: 'nodeActivated', nodeId: 'x' }]) {
			assert.strictEqual(parseBloblangWebviewMessage(message), undefined, JSON.stringify(message));
		}
	});
});
