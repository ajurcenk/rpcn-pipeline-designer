import * as assert from 'assert';
import { BinaryState } from '../adapters/redpandaConnect/binary';
import { REFRESH_NO_BINARY_LINE, refreshSchema } from '../extension';

suite('extension refreshSchema (2.8)', () => {
	function deps(stateAfterRefresh: BinaryState) {
		const calls: string[] = [];
		let state: BinaryState = { kind: 'unresolved' };
		return {
			calls,
			deps: {
				schemaStore: { refresh: async () => { calls.push('refresh'); state = stateAfterRefresh; } },
				binary: { get state() { return state; }, showBinaryWarning: () => { calls.push('warning'); return true; } },
				log: (line: string) => calls.push(`log:${line}`),
			},
		};
	}

	test('no usable binary: refresh, then one log line and the binary warning again', async () => {
		const { calls, deps: d } = deps({ kind: 'missing' } as BinaryState);
		await refreshSchema(d);
		assert.deepStrictEqual(calls, ['refresh', `log:${REFRESH_NO_BINARY_LINE}`, 'warning']);
	});

	test('an invalid binary is treated the same way', async () => {
		const { calls, deps: d } = deps({ kind: 'invalid', path: '/x', reason: { kind: 'tooOld', version: '4.63.0' } } as unknown as BinaryState);
		await refreshSchema(d);
		assert.strictEqual(calls.filter((c) => c === 'warning').length, 1);
	});

	test('a usable binary: just the refresh, no extra feedback', async () => {
		const { calls, deps: d } = deps({ kind: 'ok', path: '/b', version: '4.112.0', invocation: ['/b'] });
		await refreshSchema(d);
		assert.deepStrictEqual(calls, ['refresh']);
	});
});
