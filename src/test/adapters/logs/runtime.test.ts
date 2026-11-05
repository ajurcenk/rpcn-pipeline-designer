import * as assert from 'assert';
import { newerVsCodeMessage, nodeSupported } from '../../../adapters/logs/runtime';

// Ticket 6.2 (the user's decision of 2026-11-05): the client needs Node 22.22 or later.
suite('Pipeline logs runtime check (ticket 6.2)', () => {
	test('Node 22.22 or later is supported; older is not', () => {
		for (const [v, ok] of [['22.22.0', true], ['22.23.1', true], ['24.0.0', true], ['22.21.9', false], ['20.18.3', false], ['x', false]] as const) {
			assert.strictEqual(nodeSupported(v), ok, v);
		}
		assert.strictEqual(newerVsCodeMessage('20.18.3'), 'Pipeline logs need a newer VS Code (Node 22.22 or later; this one has 20.18.3)');
	});
});
