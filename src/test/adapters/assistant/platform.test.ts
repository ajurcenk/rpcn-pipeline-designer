import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSdkHost, importSdkFrom, isBinaryMissing, RUNTIME_GONE_TEXT } from '../../../adapters/assistant/agentSdkHost';
import type { AssistantEvent } from '../../../adapters/assistant/host';
import { binaryName, hostIsMusl, hostPlatform, isMusl, platformLabel, resetHostMuslForTest } from '../../../adapters/assistant/platform';
import { FAKE_SDK_MJS } from '../../helpers/fakeRegistry';
import { REPO_ROOT } from '../../helpers/fakeBinary';

// Story 8.2: the platform as the binary packages name it, the musl detection (once per process), and the
// SDK host loading only the runtime it is handed.
suite('assistant platform (story 8.2)', () => {
	test('the platform labels, musl only on Linux; the binary\'s name', () => {
		assert.strictEqual(platformLabel('linux', 'x64', false), 'linux-x64');
		assert.strictEqual(platformLabel('linux', 'arm64', true), 'linux-arm64-musl');
		assert.strictEqual(platformLabel('darwin', 'arm64', true), 'darwin-arm64', 'musl only on Linux');
		assert.strictEqual(platformLabel('win32', 'x64', false), 'win32-x64');
		assert.strictEqual(binaryName('win32'), 'claude.exe');
		assert.strictEqual(binaryName('linux'), 'claude');
	});

	test('musl as the SDK decides it: Linux with a report without a glibc runtime version', () => {
		assert.strictEqual(isMusl('linux', () => ({ header: { glibcVersionRuntime: '2.39' } })), false);
		assert.strictEqual(isMusl('linux', () => ({ header: {} })), true);
		assert.strictEqual(isMusl('linux', () => undefined), false, 'no report: not musl');
		assert.strictEqual(isMusl('linux', () => {
			throw new Error('no report');
		}), false);
		assert.strictEqual(isMusl('darwin', () => ({ header: {} })), false);
	});

	test('review 4: the host\'s musl answer is decided once', () => {
		resetHostMuslForTest();
		let calls = 0;
		const report = () => {
			calls++;
			return { header: { glibcVersionRuntime: '2.39' } };
		};
		const first = hostIsMusl(report);
		assert.strictEqual(hostIsMusl(report), first);
		assert.strictEqual(hostIsMusl(report), first);
		hostPlatform();
		hostPlatform();
		assert.strictEqual(calls, process.platform === 'linux' ? 1 : 0);
		resetHostMuslForTest();
	});

	suite('the SDK host and the runtime it is handed', () => {
		let dir: string;
		setup(() => {
			dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-sdk-host-')));
		});
		teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

		const host = (runtime: { sdk: string; binary: string }, storageDir: string) => new AgentSdkHost({
			model: 'm', baseUrl: 'http://127.0.0.1:1', auth: 'bearer', apiKey: 'k'.repeat(16), workspace: '/nowhere', skillsDir: '/nowhere', rpcnBinary: '/nowhere',
			storageDir, baseEnv: {}, log: () => undefined, runtime: { version: '1.0.0', ...runtime },
		});

		test('review 3: a runtime gone as the run starts ends it at once with runtimeMissing, before anything is set up', async () => {
			const storage = path.join(dir, 'storage');
			const events: AssistantEvent[] = [];
			await host({ sdk: path.join(dir, 'sdk.mjs'), binary: path.join(dir, 'claude') }, storage).start({ prompt: 'x', skill: 'rpcn-design' }, (e) => events.push(e));
			assert.deepStrictEqual(events, [{ type: 'error', message: RUNTIME_GONE_TEXT, runtimeMissing: true }]);
			assert.ok(!fs.existsSync(storage), 'nothing was set up');
			// The SDK there but the binary not executable: the same.
			fs.writeFileSync(path.join(dir, 'sdk.mjs'), FAKE_SDK_MJS);
			fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o644 });
			events.length = 0;
			await host({ sdk: path.join(dir, 'sdk.mjs'), binary: path.join(dir, 'claude') }, storage).start({ prompt: 'x', skill: 'rpcn-design' }, (e) => events.push(e));
			assert.deepStrictEqual(events, [{ type: 'error', message: RUNTIME_GONE_TEXT, runtimeMissing: true }]);
		});

		test('review 2: the SDK is imported from the path handed over, not looked up by name', async () => {
			const entry = path.join(dir, 'sdk.mjs');
			fs.writeFileSync(entry, FAKE_SDK_MJS);
			const sdk = await importSdkFrom(entry) as unknown as { query: () => unknown };
			assert.strictEqual(typeof sdk.query, 'function');
		});

		test('isBinaryMissing matches the pinned SDK\'s own binary-not-found messages', () => {
			const text = fs.readFileSync(path.join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'), 'utf8');
			const messages = [/Native CLI binary for \$\{[^}]+\}-\$\{[^}]+\} not found[^`]*/, /Claude Code native binary not found at \$\{[^}]+\}[^`]*/, /Claude Code executable not found at \$\{[^}]+\}[^`]*/]
				.map((re) => re.exec(text)?.[0]);
			assert.ok(messages.every((m) => m !== undefined), 'the pinned SDK still says these');
			for (const m of messages) {
				const filled = m!.replace(/\$\{[^}]+\}/g, 'x');
				assert.ok(isBinaryMissing(filled), filled);
			}
		});

		test('the SDK\'s own "binary not found" is told apart', () => {
			assert.ok(isBinaryMissing('Native CLI binary for linux-x64 not found. Reinstall …'));
			assert.ok(!isBinaryMissing('API Error: 401'));
		});
	});
});
