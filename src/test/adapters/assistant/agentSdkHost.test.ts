import * as assert from 'assert';
import { idleTimeoutText, loadSdk } from '../../../adapters/assistant/agentSdkHost';

// Story 8.1 review: the SDK import (a failed one is tried again, review 16) and the idle timeout's text (review 8).
suite('assistant SDK adapter (story 8.1)', () => {
	test('review 16: a rejected import is not cached: the next load tries again', async () => {
		let calls = 0;
		const failing = () => {
			calls++;
			return Promise.reject(new Error('cannot find package'));
		};
		await assert.rejects(loadSdk(failing as never), /cannot find package/);
		await assert.rejects(loadSdk(failing as never), /cannot find package/);
		assert.strictEqual(calls, 2);
		const sdk = { query: () => undefined };
		const ok = () => {
			calls++;
			return Promise.resolve(sdk);
		};
		assert.strictEqual(await loadSdk(ok as never), sdk);
		assert.strictEqual(await loadSdk(ok as never), sdk, 'kept once loaded');
		assert.strictEqual(calls, 3);
	});

	test('story 8.2: another runtime entry is imported anew; the same one is kept', async () => {
		const ran: string[] = [];
		const a = { query: () => 'a' };
		const b = { query: () => 'b' };
		const importA = () => {
			ran.push('a');
			return Promise.resolve(a);
		};
		const importB = () => {
			ran.push('b');
			return Promise.resolve(b);
		};
		assert.strictEqual(await loadSdk(importA as never, '/v1/sdk.mjs'), a);
		assert.strictEqual(await loadSdk(importB as never, '/v2/sdk.mjs'), b, 'the new entry\'s module');
		assert.strictEqual(await loadSdk(importA as never, '/v2/sdk.mjs'), b, 'the same entry: kept');
		assert.deepStrictEqual(ran, ['a', 'b']);
	});

	test('review 8: the idle timeout names how long it waited', () => {
		assert.strictEqual(idleTimeoutText(5 * 60_000), 'No answer from the assistant for 5 minutes: the run was stopped.');
		assert.strictEqual(idleTimeoutText(60_000), 'No answer from the assistant for 1 minute: the run was stopped.');
		assert.strictEqual(idleTimeoutText(1500), 'No answer from the assistant for 2 s: the run was stopped.');
	});
});
